"""The agent loop: a Bedrock Converse tool-use conversation over the shared tool registry.

This is where the agent actually runs. It is a deliberately thin loop — send the
conversation with a tool catalogue, execute whatever tools the model asks for, feed the
results back, repeat until it stops asking — because all the judgement that matters lives
elsewhere: in the tools that own the data access, and in the registry that owns the
authorization.

Why boto3 Converse rather than Strands
--------------------------------------
Every Lambda in this stack is packaged from ``CodeUri: .``, so one dependency tree is copied
into all of them. Adding ``strands-agents`` previously took the artifact to 86 MB, which is
why ``requirements.txt`` excludes it and why the six agent factories were unreachable code.

``boto3`` is already in the Lambda runtime, and the Converse API gives tool use directly, so
the deployed path costs nothing in bundle size. The tool registry is framework-neutral, so
:func:`build_strands_tools` projects the same tools into Strands callables for anyone running
that path locally. One definition, two front ends, and neither can bypass the gate.

What the loop guarantees
------------------------
* **Bounded.** A model that keeps calling tools is stopped at ``MAX_TOOL_TURNS``. An
  unbounded loop inside a Lambda is a timeout and a bill, not a better answer.
* **Honest about approvals.** A tool that hit the approval gate returns a result saying so,
  and the system prompt requires the model to relay that rather than claiming success.
* **Scoped.** The tool catalogue sent to Bedrock is filtered to the caller's role, so an
  instruction to use a leader-only tool has nothing to act on.
* **Minimal PII.** Tool results are shaped by the tools themselves and exclude attendee and
  speaker contact details, so personal data is not sent to the model to answer questions
  that never needed it.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from services.shared.principal import Principal, Role, agent_principal
from tools.community_ops import registry
from tools.registry import ToolContext, ToolRegistry

logger = logging.getLogger(__name__)

BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-sonnet-4-20250514-v1:0")
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")
MAIN_TABLE = os.environ.get("MAIN_TABLE", "CommunityOps-Main-dev")

# How many times the model may call tools before the loop stops. Real questions resolve in
# two or three rounds; more than this usually means the model is circling rather than
# converging, and a Lambda cannot afford to find out how long that would continue.
MAX_TOOL_TURNS = 6

# Ceiling on the reply length. Operational answers are read between other tasks, so brevity
# is a feature; this also bounds cost.
MAX_OUTPUT_TOKENS = 1600

# Low but non-zero. Zero makes the phrasing stilted and repetitive across turns; high makes
# an operations assistant discursive when it should be direct.
TEMPERATURE = 0.2

# How much conversation history is replayed. Enough for follow-up questions to make sense
# without resending an entire session on every turn.
MAX_HISTORY_TURNS = 12


class AgentUnavailableError(Exception):
    """Bedrock could not be reached or is not permitted for this deployment.

    Distinguished from a model that answered badly, because the two need different messages:
    one is "try again", the other is "the answer may be wrong".
    """


@dataclass
class AgentTurn:
    """The outcome of one exchange with the agent."""

    reply: str
    tools_used: list[str] = field(default_factory=list)
    approvals_created: list[str] = field(default_factory=list)
    tool_results: list[dict[str, Any]] = field(default_factory=list)
    stop_reason: str = ""
    turns_taken: int = 0
    latency_ms: int = 0
    truncated: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "reply": self.reply,
            "tools_used": self.tools_used,
            "approvals_created": self.approvals_created,
            "stop_reason": self.stop_reason,
            "turns_taken": self.turns_taken,
            "latency_ms": self.latency_ms,
            "truncated": self.truncated,
        }


# The operating rules. Written as constraints on what the model may assert rather than as a
# personality, because the failure that matters is a confident wrong number, not a dull tone.
BASE_RULES = """\
You are CommunityOps, an AI operations teammate for community event organisers.

You are not a chatbot bolted onto a dashboard. You are the person's operations colleague: you
look at the real state of their event, tell them what needs them, and handle what you can.

HOW YOU WORK

1. Look things up. Every fact you state about an event must come from a tool call in this
   conversation. You have no memory of their data and no ability to infer it.
2. Never invent or estimate a number. Task counts, budget figures, speaker status, attendee
   numbers and health scores all come from tools. If you have not called the tool, you do not
   know the answer.
3. Never compute a budget figure yourself. get_budget and calculate_remaining_budget return
   the authoritative arithmetic. Report what they say.
4. Never state the event health score from your own judgement. get_event_risk computes it.
5. If a tool reports that data could not be read, say it could not be checked. Do not turn
   "unavailable" into "there are none" — that is a false statement about their event.

WHEN YOU ACT

You can create tasks, assign unassigned work, comment on incidents, draft messages and record
incidents without asking. Do those when the user agrees they are needed; do not tell someone to
go and make a task themselves.

Some actions require the leader's approval: anything financial, anything irreversible, and
anything that leaves the organization. When a tool returns AWAITING_APPROVAL it has NOT done
the thing. Say so plainly: what you prepared, the approval id, and that it is waiting for
them. Never report a prepared action as done.

A few actions can never be automated at all. If a tool says so, explain that a person has to
do it directly.

HOW YOU ANSWER

Lead with the answer. A leader asking what needs their attention wants the list, not a preamble
about how you looked.

Be specific. "Registration has two overdue tasks: reconcile payments (18h late) and generate
tickets (4h late)" is useful. "Some tasks are overdue" is not.

Quote real identifiers — task ids, speaker names, approval ids, rupee amounts — so the person
can act on what you said.

When you recommend something, give the evidence. "Rahul has 11 open tasks and Priya has 4, so
I would move T-124 to Priya" is a recommendation. "Consider rebalancing" is not.

Say what you do not know. A missing tool result is worth naming, not papering over.

Keep it short. Operational answers get read between other work.

Format amounts as the tools return them, in Indian digit grouping: 62,500 not 62500.
"""

LEADER_CONTEXT = """\
YOUR USER

A community leader with organization-wide authority. They can decide approvals, manage budget,
manage teams, and act on anything you surface. Address decisions to them directly.
"""

TEAM_MEMBER_CONTEXT = """\
YOUR USER

A team member, not a leader. They see only their assigned events and their own teams, and your
tools enforce that — data outside their scope is not available to you either.

They cannot approve anything, allocate budget, or manage teams. When something needs one of
those, say it needs a leader rather than suggesting they do it. Help them with their own work:
their tasks, their team's state, reporting incidents, and raising requests.
"""

FUN_MODE_ADDENDUM = """\
TONE

Fun Mode is on. You may add one light Hindi or Bollywood-flavoured line of encouragement,
occasionally — not every message. Something like "Picture abhi baaki hai, team!" after
delivering a piece of operational news.

Never do this in the same breath as money, an approval, an incident, a security matter, or any
text that will be sent outside the organization. Those stay plain and professional. The
encouragement is decoration around the facts; it never alters, softens or obscures them.
"""


def _bedrock_client() -> Any:
    """A Bedrock runtime client with a retry policy suited to a Lambda.

    Adaptive retries because throttling is the common failure under load and backing off is the
    correct response. The read timeout is generous relative to the API default, since a
    tool-use turn with a long catalogue genuinely takes a while, but stays under the function's
    own timeout so the loop fails with a readable message instead of being killed mid-call.
    """
    return boto3.client(
        "bedrock-runtime",
        region_name=BEDROCK_REGION,
        config=Config(
            retries={"max_attempts": 3, "mode": "adaptive"},
            read_timeout=60,
            connect_timeout=10,
        ),
    )


def build_system_prompt(
    principal: Principal,
    *,
    event_context: dict[str, Any] | None = None,
    fun_mode: bool = False,
) -> str:
    """Assemble the system prompt for this caller.

    The event context is a handful of identifying facts — name, status, dates — not the event's
    data. Facts still have to be fetched, so that the model cannot answer from a stale summary
    baked into its instructions while believing it looked.
    """
    parts = [BASE_RULES]
    parts.append(LEADER_CONTEXT if principal.is_leader else TEAM_MEMBER_CONTEXT)

    if event_context:
        lines = ["CURRENT EVENT IN CONTEXT", ""]
        for label, key in (
            ("Event", "name"),
            ("Identifier", "event_id"),
            ("Status", "status"),
            ("Starts", "start_date"),
            ("Venue", "venue"),
        ):
            if value := event_context.get(key):
                lines.append(f"{label}: {value}")
        lines.append("")
        lines.append(
            "Tools default to this event when event_id is omitted. These are identifying "
            "details only — every operational figure still has to come from a tool call."
        )
        parts.append("\n".join(lines))

    if fun_mode:
        parts.append(FUN_MODE_ADDENDUM)

    return "\n\n".join(parts)


def _history_messages(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert stored chat turns into Converse messages.

    Only text is replayed. Tool calls and their results are dropped, because the data they
    returned may have changed since — replaying a stale tool result as if it were current is how
    an agent ends up confidently quoting yesterday's budget.
    """
    messages: list[dict[str, Any]] = []
    for turn in history[-MAX_HISTORY_TURNS:]:
        role = str(turn.get("role", ""))
        content = str(turn.get("content", "")).strip()
        if role not in ("user", "assistant") or not content:
            continue
        messages.append({"role": role, "content": [{"text": content}]})

    # Converse requires the conversation to start with a user turn. A history that begins with
    # an assistant message — possible if a session was trimmed — would be rejected outright.
    while messages and messages[0]["role"] != "user":
        messages.pop(0)
    return messages


def run_turn(
    principal: Principal,
    organization_id: str,
    message: str,
    *,
    event_id: str = "",
    event_context: dict[str, Any] | None = None,
    history: list[dict[str, Any]] | None = None,
    fun_mode: bool = False,
    table_name: str | None = None,
    tool_registry: ToolRegistry | None = None,
    client: Any | None = None,
) -> AgentTurn:
    """Run one exchange: the user's message in, the agent's reply out.

    Args:
        principal: the resolved caller. Re-attributed to the agent for audit, with the same
            authority — the agent never gains scope by being an agent.
        client: injectable for tests, so the loop can be exercised without calling Bedrock.

    Raises:
        AgentUnavailableError: Bedrock could not be reached, is not permitted, or is throttling.
            Raised rather than returned as a reply, because a fabricated apology in the
            assistant's voice is indistinguishable from a real answer.
    """
    started = time.monotonic()
    active_registry = tool_registry or registry
    bedrock = client or _bedrock_client()

    # The agent acts as the user, with the user's authority, recorded as the agent.
    acting = agent_principal(principal)
    ctx = ToolContext(
        principal=acting,
        organization_id=organization_id,
        table_name=table_name or MAIN_TABLE,
        default_event_id=event_id,
        fun_mode=fun_mode,
    )

    messages = _history_messages(history or [])
    messages.append({"role": "user", "content": [{"text": message}]})

    system_prompt = build_system_prompt(principal, event_context=event_context, fun_mode=fun_mode)
    tool_config = active_registry.converse_tool_config(principal)

    tools_used: list[str] = []
    approvals_created: list[str] = []
    tool_results: list[dict[str, Any]] = []
    reply_text = ""
    stop_reason = ""
    turns = 0

    for turn_index in range(MAX_TOOL_TURNS):
        turns = turn_index + 1
        try:
            response = bedrock.converse(
                modelId=BEDROCK_MODEL_ID,
                messages=messages,
                system=[{"text": system_prompt}],
                toolConfig=tool_config,
                inferenceConfig={
                    "maxTokens": MAX_OUTPUT_TOKENS,
                    "temperature": TEMPERATURE,
                },
            )
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            logger.error("Bedrock converse failed: %s", code, exc_info=True)
            # Each of these needs a different message, because each implies a different fix.
            if code in ("AccessDeniedException", "UnrecognizedClientException"):
                raise AgentUnavailableError(
                    "The assistant is not available: this deployment does not have access to "
                    f"the {BEDROCK_MODEL_ID} model in {BEDROCK_REGION}. The operational data "
                    "is unaffected and every screen still works."
                ) from exc
            if code == "ThrottlingException":
                raise AgentUnavailableError(
                    "The assistant is busy right now. Please try that again in a moment."
                ) from exc
            if code == "ValidationException":
                raise AgentUnavailableError(
                    "The assistant could not process that request. Try rephrasing it more briefly."
                ) from exc
            raise AgentUnavailableError(
                "The assistant could not be reached. The operational data is unaffected."
            ) from exc
        except Exception as exc:  # noqa: BLE001 - network and config faults surface the same way
            logger.error("Bedrock converse raised unexpectedly", exc_info=True)
            raise AgentUnavailableError(
                "The assistant could not be reached. The operational data is unaffected."
            ) from exc

        stop_reason = str(response.get("stopReason", ""))
        output_message = response.get("output", {}).get("message", {})
        content_blocks = output_message.get("content", [])

        # The assistant's turn is appended verbatim, including its tool-use blocks. Converse
        # requires each toolUse to be answered by a matching toolResult in the next message.
        messages.append({"role": "assistant", "content": content_blocks})

        for block in content_blocks:
            if text := block.get("text"):
                reply_text = (reply_text + "\n" + text).strip() if reply_text else text

        if stop_reason != "tool_use":
            break

        tool_result_blocks: list[dict[str, Any]] = []
        for block in content_blocks:
            tool_use = block.get("toolUse")
            if not tool_use:
                continue

            name = str(tool_use.get("name", ""))
            arguments = tool_use.get("input") or {}
            logger.info("Agent calling tool", extra={"tool": name})

            result = active_registry.invoke(name, arguments, ctx)
            tools_used.append(name)
            tool_results.append({"tool": name, "result": result})

            # Only an approval the gate actually raised counts. A tool result can carry an
            # approval id for other reasons, such as reporting one it looked up.
            if result.get("status") == "AWAITING_APPROVAL" and result.get("approval_id"):
                approvals_created.append(str(result["approval_id"]))

            tool_result_blocks.append(
                {
                    "toolResult": {
                        "toolUseId": tool_use.get("toolUseId"),
                        "content": [{"json": _json_safe(result)}],
                        # Marked as an error so the model treats it as a failed call rather
                        # than as data, without ending the conversation.
                        "status": "error" if result.get("error") else "success",
                    }
                }
            )

        if not tool_result_blocks:
            # stopReason said tool_use but no toolUse block arrived. Continuing would send a
            # user turn with nothing in it, which Converse rejects.
            logger.warning("Model signalled tool use but sent no tool call")
            break

        messages.append({"role": "user", "content": tool_result_blocks})
    else:
        # The loop ran out of turns rather than the model finishing.
        logger.warning("Agent hit the tool-turn ceiling", extra={"turns": MAX_TOOL_TURNS})

    truncated = stop_reason == "tool_use" and turns >= MAX_TOOL_TURNS
    if truncated and not reply_text:
        reply_text = (
            "I gathered part of the picture but ran out of steps before finishing. "
            "Try asking about one thing at a time — for example the overdue tasks, or the "
            "budget, rather than both at once."
        )
    if not reply_text:
        reply_text = (
            "I could not put together an answer to that. Try asking more specifically — for "
            "example 'what needs my attention today' or 'how much budget remains'."
        )

    return AgentTurn(
        reply=reply_text.strip(),
        tools_used=tools_used,
        approvals_created=approvals_created,
        tool_results=tool_results,
        stop_reason=stop_reason,
        turns_taken=turns,
        latency_ms=int((time.monotonic() - started) * 1000),
        truncated=truncated,
    )


def _json_safe(payload: dict[str, Any]) -> dict[str, Any]:
    """Round-trip a tool result through JSON so Converse can serialize it.

    DynamoDB reads come back with ``Decimal`` values, which the Bedrock client cannot encode.
    Rather than hunting them down per tool, the result is normalised once here.
    """
    return json.loads(json.dumps(payload, default=str))


def build_strands_tools(
    principal: Principal,
    organization_id: str,
    *,
    event_id: str = "",
    table_name: str | None = None,
    tool_registry: ToolRegistry | None = None,
) -> list[Any]:
    """Project the registry into callables for ``strands.Agent(tools=[...])``.

    Each callable routes through :meth:`ToolRegistry.invoke`, so the Strands path gets the same
    validation, scope check, policy evaluation, approval gating and audit as the Converse path.
    This is what makes the Strands factories real rather than decorative — they consume this
    registry instead of declaring tools of their own, so the two front ends cannot drift.

    Strands derives its schema from the signature and docstring, so each wrapper is given both
    from the ``ToolSpec``. Arguments arrive as keywords, which is how Strands calls tools.
    """
    active_registry = tool_registry or registry
    ctx = ToolContext(
        principal=agent_principal(principal),
        organization_id=organization_id,
        table_name=table_name or MAIN_TABLE,
        default_event_id=event_id,
    )

    callables: list[Any] = []
    for spec in active_registry.visible_for(principal):

        def make(spec_ref: Any = spec) -> Any:
            def tool_fn(**kwargs: Any) -> dict[str, Any]:
                return active_registry.invoke(spec_ref.name, kwargs, ctx)

            tool_fn.__name__ = spec_ref.name
            tool_fn.__doc__ = (
                f"{spec_ref.description}\n\n"
                f"Arguments: {', '.join(sorted(spec_ref.parameters)) or 'none'}.\n"
                f"Required: {', '.join(spec_ref.required) or 'none'}."
            )
            return tool_fn

        callables.append(make())
    return callables


def agent_capabilities(principal: Principal) -> dict[str, Any]:
    """What this caller's agent can and cannot do.

    Surfaced in the console so a leader can see the boundary rather than take it on trust.
    """
    from tools.community_ops import tool_catalogue

    catalogue = tool_catalogue()
    visible = {spec.name for spec in registry.visible_for(principal)}
    available = [entry for entry in catalogue if entry["name"] in visible]
    return {
        "role": principal.role.value,
        "model_id": BEDROCK_MODEL_ID,
        "model_region": BEDROCK_REGION,
        "tool_count": len(available),
        "tools": available,
        "automatic": [t["name"] for t in available if not t["requires_approval"]],
        "requires_approval": [t["name"] for t in available if t["requires_approval"]],
        "withheld_from_role": sorted(
            entry["name"] for entry in catalogue if entry["name"] not in visible
        ),
        "notes": [
            "Every figure the agent states is read through a tool; it cannot recall or infer "
            "your data.",
            "Financial, irreversible and outbound actions create an approval request instead "
            "of executing.",
            "The agent has exactly your authority — it cannot reach an event or team you cannot.",
            "Document contents are not indexed, so the agent can find a document but cannot "
            "tell you what is inside it.",
        ],
    }


def unavailable_roles(principal: Principal) -> list[str]:
    """Roles whose tools this principal does not receive. Used in tests and diagnostics."""
    return [role.value for role in (Role.LEADER, Role.TEAM_MEMBER) if role is not principal.role]
