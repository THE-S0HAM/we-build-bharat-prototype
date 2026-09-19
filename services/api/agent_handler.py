"""The operations chat endpoint.

Routes:
    POST /agent/chat                     send a message, get the agent's reply
    GET  /agent/capabilities             what this caller's agent can and cannot do
    GET  /agent/sessions/{sessionId}     replay a conversation
    GET  /agent/activity                 what the agent has been doing, from the audit log

The chat is an operational interface, not a general assistant. The authority model is the
whole point: the caller's token decides which tools exist, the tools decide what data is
reachable, and policy decides what needs a human. Nothing in the message body can change any
of that — a prompt is input, and input does not grant permission.

Conversations are persisted so a follow-up question makes sense after a page reload, and so the
tools an answer relied on stay inspectable afterwards. Only the text is replayed into the
model; stale tool results are not, because a figure that was true an hour ago is not an answer
to a question asked now.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from services.api._common import (
    begin_request,
    handle_dynamodb_errors,
    path_param,
    query_param,
    require_fields,
)
from services.shared.api_response import error, success
from services.shared.audit import create_audit_event
from services.shared.dynamodb import DynamoDBError
from services.shared.keys import audit_prefix, chat_session_prefix, chat_turn_sk, user_gsi2pk
from services.shared.models.base import ErrorCategory, utc_now
from services.shared.principal import authorize_scope
from services.shared.validation import MAX_CHAT_MESSAGE_LENGTH, validate_session_id

logger = logging.getLogger(__name__)

# How many stored turns are replayed as context. Matches the runtime's own ceiling so the two
# do not disagree about how much history exists.
HISTORY_TURNS = 12


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    method = event.get("httpMethod", "POST")
    path = str(event.get("resource") or event.get("path") or "")

    if path.endswith("/capabilities") and method == "GET":
        return get_capabilities(event)
    if "/sessions" in path and method == "GET":
        return get_session(event, path_param(event, "sessionId"))
    if path.endswith("/activity") and method == "GET":
        return get_activity(event)
    if method == "POST":
        return chat(event)

    return error(ErrorCategory.VALIDATION_ERROR, "Unsupported operation")


@handle_dynamodb_errors
def chat(event: dict[str, Any]) -> dict[str, Any]:
    """Run one conversation turn.

    The sequence: authorize, load history, run the loop, persist both turns, audit. The
    persistence happens after the reply is produced so a storage failure costs the transcript
    rather than the answer — the user has their answer either way.
    """
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    missing = require_fields(ctx.body, "message")
    if missing:
        return missing

    message = str(ctx.body["message"]).strip()
    if len(message) > MAX_CHAT_MESSAGE_LENGTH:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            f"Please keep the message under {MAX_CHAT_MESSAGE_LENGTH} characters.",
        )

    event_id = str(ctx.body.get("event_id", "")).strip()
    if event_id:
        scope_denied = authorize_scope(ctx.principal, event_id=event_id)
        if scope_denied:
            return scope_denied

    session_id = str(ctx.body.get("session_id", "")).strip()
    if session_id:
        if not validate_session_id(session_id):
            return error(
                ErrorCategory.VALIDATION_ERROR,
                "session_id must be 8 to 64 characters of letters, digits or hyphens.",
            )
    else:
        session_id = uuid.uuid4().hex[:16]

    history = _load_history(ctx, session_id)
    next_sequence = len(history)

    event_context = _event_context(ctx, event_id)
    fun_mode = bool(ctx.body.get("fun_mode", False))

    from agents.runtime import AgentUnavailableError, run_turn

    try:
        turn = run_turn(
            ctx.principal,
            ctx.organization_id,
            message,
            event_id=event_id,
            event_context=event_context,
            history=history,
            fun_mode=fun_mode,
            table_name=ctx.repo.table_name,
        )
    except AgentUnavailableError as exc:
        # Surfaced as a distinct category so the console can present it as "the assistant is
        # unavailable" rather than rendering an apology that looks like the agent's own answer.
        logger.warning("Agent unavailable: %s", exc)
        return error(ErrorCategory.EXTERNAL_SERVICE_ERROR, str(exc))

    _persist_turn(
        ctx,
        session_id,
        next_sequence,
        role="user",
        content=message,
        event_id=event_id,
        fun_mode=fun_mode,
    )
    _persist_turn(
        ctx,
        session_id,
        next_sequence + 1,
        role="assistant",
        content=turn.reply,
        event_id=event_id,
        fun_mode=fun_mode,
        tools_used=turn.tools_used,
        approvals_created=turn.approvals_created,
    )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="AGENT_CHAT_TURN",
        actor_type="agent",
        actor_id=ctx.user_id,
        resource_type="ChatSession",
        resource_id=session_id,
        event_id=event_id or None,
        details={
            # The message text is deliberately not recorded. It can contain anything the user
            # typed, and the audit log is readable by anyone with audit access.
            "message_length": len(message),
            "tools_used": turn.tools_used,
            "approvals_created": turn.approvals_created,
            "turns_taken": turn.turns_taken,
            "latency_ms": turn.latency_ms,
            "role": ctx.principal.role.value,
        },
        tool_used=",".join(turn.tools_used) or None,
        outcome="success",
    )

    return success(
        {
            "session_id": session_id,
            "reply": turn.reply,
            "tools_used": turn.tools_used,
            "approvals_created": turn.approvals_created,
            "turns_taken": turn.turns_taken,
            "latency_ms": turn.latency_ms,
            "truncated": turn.truncated,
            # Returned so the console can show what the answer was based on. An answer whose
            # sources are visible is one a leader can check.
            "evidence": [
                {"tool": entry["tool"], "summary": _result_summary(entry["result"])}
                for entry in turn.tool_results
            ],
        }
    )


def _result_summary(result: dict[str, Any]) -> str:
    """One line describing what a tool call produced, for the evidence strip."""
    if result.get("error"):
        return f"refused: {result.get('error')}"
    if result.get("status") == "AWAITING_APPROVAL":
        return f"approval {result.get('approval_id')} prepared"
    for key in ("count", "tasks", "teams", "speakers", "incidents", "approvals"):
        value = result.get(key)
        if isinstance(value, list):
            return f"{len(value)} records"
        if isinstance(value, int):
            return f"{value} records"
    if message := result.get("message"):
        return str(message)[:120]
    return "ok"


def _event_context(ctx: Any, event_id: str) -> dict[str, Any] | None:
    """Identifying details of the event in context.

    Name, status and dates only. Operational figures are deliberately excluded so the model
    cannot answer from a summary embedded in its instructions while believing it looked them up.
    """
    if not event_id:
        return None
    from services.shared.keys import event_sk

    record = ctx.repo.get_item(ctx.organization_id, event_sk(event_id))
    if not record:
        return None
    return {
        "event_id": event_id,
        "name": record.get("name", ""),
        "status": record.get("status", ""),
        "start_date": record.get("start_date", ""),
        "venue": record.get("venue", ""),
    }


def _load_history(ctx: Any, session_id: str) -> list[dict[str, Any]]:
    """Load a session's turns in order.

    The sort key zero-pads the sequence number, so lexicographic order is turn order and no
    sorting is needed. Returns an empty history on a read failure: losing context degrades the
    next answer, whereas refusing the request loses it entirely.
    """
    try:
        turns = ctx.repo.query_all(
            ctx.organization_id,
            chat_session_prefix(ctx.user_id, session_id),
            max_items=200,
        )
    except DynamoDBError:
        logger.warning("Could not load chat history; continuing without it", exc_info=True)
        return []

    turns.sort(key=lambda t: int(t.get("sequence", 0)))
    return [
        {
            "role": str(t.get("role", "")),
            "content": str(t.get("content", "")),
            "tools_used": t.get("tools_used", []),
            "approvals_created": t.get("approvals_created", []),
            "created_at": t.get("created_at"),
        }
        for t in turns
    ][-HISTORY_TURNS * 2 :]


def _persist_turn(
    ctx: Any,
    session_id: str,
    sequence: int,
    *,
    role: str,
    content: str,
    event_id: str,
    fun_mode: bool,
    tools_used: list[str] | None = None,
    approvals_created: list[str] | None = None,
) -> None:
    """Store one turn. Never fails the request.

    A conversation the user has already read is not worth failing to deliver because the
    transcript could not be written.
    """
    now = utc_now().isoformat()
    try:
        ctx.repo.put_item(
            ctx.organization_id,
            chat_turn_sk(ctx.user_id, session_id, sequence),
            {
                "entity_type": "CHAT_TURN",
                "session_id": session_id,
                "sequence": sequence,
                "user_id": ctx.user_id,
                "event_id": event_id,
                "role": role,
                "content": content[:20000],
                "tools_used": tools_used or [],
                "approvals_created": approvals_created or [],
                "citations": [],
                "fun_mode": fun_mode,
                "created_at": now,
                "updated_at": now,
                "created_by": ctx.user_id,
                "updated_by": ctx.user_id,
                "GSI2PK": user_gsi2pk(ctx.organization_id, ctx.user_id),
                "GSI2SK": f"CHAT#{session_id}#{sequence:06d}",
            },
        )
    except DynamoDBError:
        logger.warning("Could not persist a chat turn", exc_info=True)


@handle_dynamodb_errors
def get_session(event: dict[str, Any], session_id: str) -> dict[str, Any]:
    """Replay a conversation.

    The sort key is built from the caller's own user id, so there is no key that would reach
    another person's conversation — the isolation is structural rather than a filter.
    """
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    if not validate_session_id(session_id):
        return error(ErrorCategory.VALIDATION_ERROR, "Invalid session id")

    history = _load_history(ctx, session_id)
    return success({"session_id": session_id, "turns": history, "count": len(history)})


@handle_dynamodb_errors
def get_capabilities(event: dict[str, Any]) -> dict[str, Any]:
    """What this caller's agent can do, and what is withheld from their role.

    Exposed so the boundary is inspectable. A leader can see which capabilities are
    approval-gated and which are withheld from team members, rather than taking it on trust.
    """
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    from agents.runtime import agent_capabilities

    return success(agent_capabilities(ctx.principal))


@handle_dynamodb_errors
def get_activity(event: dict[str, Any]) -> dict[str, Any]:
    """What the agent has been doing, read from the audit log.

    Read from audit rather than from a separate activity table so the feed cannot diverge from
    the compliance record — the agent cannot present a flattering account of itself, because
    this is the same trail its refusals land in.
    """
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    from services.api._common import AUDIT_TABLE
    from services.shared.dynamodb import DynamoDBRepository

    audit_repo = DynamoDBRepository(AUDIT_TABLE)
    items, _ = audit_repo.query_page(ctx.organization_id, audit_prefix(), limit=200)

    event_filter = query_param(event, "event_id")
    agent_actions = [
        a
        for a in items
        if str(a.get("actor_type")) == "agent"
        and (not event_filter or str(a.get("event_id")) == event_filter)
    ]
    agent_actions.sort(key=lambda a: str(a.get("timestamp", "")), reverse=True)

    shaped = [
        {
            "audit_id": a.get("audit_id"),
            "timestamp": a.get("timestamp"),
            "action": a.get("action"),
            "resource_type": a.get("resource_type"),
            "resource_id": a.get("resource_id"),
            "tool_used": a.get("tool_used"),
            "policy_evaluated": a.get("policy_evaluated"),
            "approval_id": a.get("approval_id"),
            "outcome": a.get("outcome"),
            "summary": _activity_summary(a),
        }
        for a in agent_actions[:50]
    ]
    return success(
        {
            "activity": shaped,
            "count": len(shaped),
            "refused_count": sum(1 for a in shaped if a["outcome"] == "failure"),
            "awaiting_approval_count": sum(1 for a in shaped if a["outcome"] == "pending"),
        }
    )


def _activity_summary(record: dict[str, Any]) -> str:
    """Turn an audit record into a line a leader can read.

    Phrased from the leader's point of view — what happened to their event — rather than as the
    action name, which is written for machines.
    """
    action = str(record.get("action", ""))
    resource = f"{record.get('resource_type', '')} {record.get('resource_id', '')}".strip()
    outcome = str(record.get("outcome", ""))

    if action == "AGENT_TOOL_REFUSED":
        return f"Refused {record.get('tool_used', 'an action')}: not permitted for this user"
    if outcome == "pending":
        return f"Prepared {resource} and requested approval"
    if action == "AGENT_CHAT_TURN":
        details = record.get("details") or {}
        tools = details.get("tools_used") or []
        return (
            f"Answered a question using {len(tools)} lookup{'s' if len(tools) != 1 else ''}"
            if tools
            else "Answered a question"
        )

    readable = action.replace("AGENT_", "").replace("_", " ").lower()
    return f"{readable.capitalize()} — {resource}" if resource else readable.capitalize()
