"""Operational overview: command centre, event health, attention list, operations brief.

Routes:
    GET /command-center                       organization-wide overview
    GET /events/{eventId}/health              health band, score and the reasons for it
    GET /events/{eventId}/attention           what needs a decision, worst first
    GET /events/{eventId}/brief               today's operations brief
    GET /events/{eventId}/workload            per-team and per-member workload

These four views are grouped into one function because they are one concern — "what is the
state of this event" — and they all answer it from the same
:class:`~services.shared.aggregate.EventSnapshot`. Splitting them across four Lambdas would
mean four cold starts loading the same code to run the same query.

Every number here is arithmetic over stored records. Nothing on this path calls a model.
That is what makes the agent's answers checkable: when it says four things need attention,
the leader can open this endpoint and see the same four.
"""

from __future__ import annotations

import logging
from typing import Any

from services.api._common import begin_request, handle_dynamodb_errors, path_param
from services.shared.aggregate import EventSnapshot, list_organization_events, load_event_snapshot
from services.shared.api_response import error, success
from services.shared.health import attention_items, compute_health
from services.shared.keys import audit_prefix
from services.shared.models.base import ErrorCategory, utc_now
from services.shared.principal import authorize_scope
from services.shared.validation import coerce_int, format_inr

logger = logging.getLogger(__name__)

# How many events the command centre loads a full snapshot for. Beyond this the remaining
# events are listed with their cached health band only. A leader running twenty events does
# not need twenty full aggregations to answer "what needs me now", and doing it anyway
# would make the most-used screen the slowest.
MAX_DETAILED_EVENTS = 5


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    if event.get("httpMethod", "GET") != "GET":
        return error(ErrorCategory.VALIDATION_ERROR, "This endpoint is read-only")

    path = str(event.get("resource") or event.get("path") or "")
    event_id = path_param(event, "eventId")

    if path.endswith("/health"):
        return get_health(event, event_id)
    if path.endswith("/attention"):
        return get_attention(event, event_id)
    if path.endswith("/brief"):
        return get_brief(event, event_id)
    if path.endswith("/workload"):
        return get_workload(event, event_id)
    return get_command_center(event)


def _snapshot_or_denied(
    event: dict[str, Any], event_id: str, *, include_attendees: bool = True
) -> tuple[EventSnapshot | None, Any, dict[str, Any] | None]:
    """Shared opening for the per-event views: authorize, then load state once."""
    ctx, denied = begin_request(event)
    if denied:
        return None, None, denied
    assert ctx is not None

    if not event_id:
        return None, None, error(ErrorCategory.VALIDATION_ERROR, "eventId is required")

    scope_denied = authorize_scope(ctx.principal, event_id=event_id)
    if scope_denied:
        return None, None, scope_denied

    snapshot = load_event_snapshot(
        ctx.organization_id,
        event_id,
        table_name=ctx.repo.table_name,
        include_attendees=include_attendees,
    )
    if not snapshot.event:
        return None, None, error(ErrorCategory.NOT_FOUND, "Event not found")
    return snapshot, ctx, None


@handle_dynamodb_errors
def get_health(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Compute and return an event's health, with the reasons that produced the score.

    The result is also written back onto the event record so listings can show a band
    without each one running a full aggregation. The cache is advisory — this computation is
    authoritative — so a write failure is logged rather than raised.
    """
    snapshot, ctx, denied = _snapshot_or_denied(event, event_id)
    if denied:
        return denied
    assert snapshot is not None and ctx is not None

    result = compute_health(snapshot)

    try:
        from services.shared.keys import event_sk

        ctx.repo.update_item(
            ctx.organization_id,
            event_sk(event_id),
            {
                "health_band": result.band.value,
                "health_score": result.score,
                "health_reasons": [r.detail for r in result.reasons],
                "health_computed_at": utc_now().isoformat(),
            },
        )
    except Exception:  # noqa: BLE001 - the computed result is what the caller asked for
        logger.warning("Could not cache the computed health band", exc_info=True)

    return success(
        {
            "event_id": event_id,
            "event_name": snapshot.event.get("name", ""),
            **result.to_dict(),
            "computed_at": snapshot.now.isoformat(),
            "inputs": {
                "overdue_tasks": len(snapshot.overdue_tasks),
                "blocked_tasks": len(snapshot.blocked_tasks),
                "open_incidents": len(snapshot.open_incidents),
                "silent_speakers": len(snapshot.silent_speakers),
                "stale_approvals": len(snapshot.stale_approvals),
                "budget_utilization_percent": snapshot.budget.utilization_percent,
                "hours_until_start": snapshot.hours_until_start,
                "attendee_data_completeness_percent": (
                    snapshot.attendees.data_completeness_percent
                ),
            },
        }
    )


@handle_dynamodb_errors
def get_attention(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """What needs the leader, ordered worst first."""
    snapshot, _ctx, denied = _snapshot_or_denied(event, event_id)
    if denied:
        return denied
    assert snapshot is not None

    items = attention_items(snapshot)
    return success(
        {
            "event_id": event_id,
            "attention_items": items,
            "count": len(items),
            "critical_count": sum(1 for i in items if i["severity"] == "CRITICAL"),
            "high_count": sum(1 for i in items if i["severity"] == "HIGH"),
        }
    )


@handle_dynamodb_errors
def get_brief(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Today's operations brief, assembled from state.

    The brief is composed here rather than generated by the model. The agent can narrate it
    and argue about priorities, but the counts and the rupee figures are read, so a brief
    cannot quietly contain a number nobody can reconcile.
    """
    snapshot, _ctx, denied = _snapshot_or_denied(event, event_id)
    if denied:
        return denied
    assert snapshot is not None

    return success(build_brief(snapshot))


def build_brief(snapshot: EventSnapshot) -> dict[str, Any]:
    """Assemble the operations brief for one event.

    Separated from the handler so the agent's ``generate_event_brief`` tool produces the
    identical structure. Two implementations would eventually disagree, and the leader would
    have no way to tell which was right.
    """
    health = compute_health(snapshot)
    attention = attention_items(snapshot)
    budget = snapshot.budget

    decisions_required = [i for i in attention if i["kind"] == "APPROVAL"]
    high_risk = [i for i in attention if i["severity"] in ("CRITICAL", "HIGH")]

    # "Progressing automatically" means open work that is neither late nor stuck — the work
    # the leader does not need to think about. That is the number that makes the rest of the
    # brief meaningful: it is the contrast to the exceptions.
    progressing = [
        t
        for t in snapshot.open_tasks
        if not snapshot.is_task_overdue(t) and str(t.get("status")) != "BLOCKED"
    ]

    recommended: list[str] = []
    for item in attention[:5]:
        if item["kind"] == "INCIDENT":
            recommended.append(f"Resolve: {item['title']}")
        elif item["kind"] == "APPROVAL":
            recommended.append(f"Decide: {item['title']}")
        elif item["kind"] == "SPEAKER":
            recommended.append(f"Follow up: {item['title']}")
        elif item["kind"] == "TASK":
            recommended.append(f"Unblock: {item['title']}")
        elif item["kind"] == "BUDGET":
            recommended.append(f"Review budget: {item['detail']}")
        else:
            recommended.append(f"Rebalance: {item['title']}")

    speakers_pending = snapshot.unsettled_speakers
    return {
        "event_id": snapshot.event_id,
        "event_name": snapshot.event.get("name", ""),
        "generated_at": snapshot.now.isoformat(),
        "health_band": health.band.value,
        "health_score": health.score,
        "health_reasons": [r.detail for r in health.reasons],
        "decisions_required": len(decisions_required),
        "high_risk_items": len(high_risk),
        "tasks_progressing": len(progressing),
        "overdue_tasks": len(snapshot.overdue_tasks),
        "blocked_tasks": len(snapshot.blocked_tasks),
        "open_incidents": len(snapshot.open_incidents),
        "incidents_needing_attention": len(
            [i for i in snapshot.open_incidents if str(i.get("severity")) in ("CRITICAL", "HIGH")]
        ),
        "budget": {
            "total_inr": budget.total_budget,
            "remaining_inr": budget.remaining,
            "remaining_formatted": format_inr(budget.remaining),
            "committed_inr": budget.committed,
            "spent_inr": budget.spent,
            "utilization_percent": budget.utilization_percent,
            "pending_exposure_inr": snapshot.pending_financial_exposure,
        },
        "speakers": {
            "total": len(snapshot.speakers),
            "confirmed": len(snapshot.confirmed_speakers),
            "pending": len(speakers_pending),
            "unresponsive": len(snapshot.silent_speakers),
            "needing_accommodation": len(snapshot.speakers_needing_accommodation),
        },
        "attention_items": attention,
        "recommended_priority": recommended,
        "hours_until_start": snapshot.hours_until_start,
    }


@handle_dynamodb_errors
def get_workload(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Per-team and per-member workload.

    This is what makes a reassignment recommendation evidence-based rather than a guess:
    the agent compares these numbers instead of asserting that somebody looks busy.
    """
    snapshot, _ctx, denied = _snapshot_or_denied(event, event_id, include_attendees=False)
    if denied:
        return denied
    assert snapshot is not None

    teams = [
        {
            "team_id": t.team_id,
            "name": t.name,
            "member_count": t.member_count,
            "open_tasks": t.open_tasks,
            "overdue_tasks": t.overdue_tasks,
            "blocked_tasks": t.blocked_tasks,
            "completed_tasks": t.completed_tasks,
            "progress_percent": t.progress_percent,
            "workload_per_member": t.workload_per_member,
            "risk": t.risk,
        }
        for t in snapshot.teams
    ]
    teams.sort(key=lambda t: -t["open_tasks"])

    members = snapshot.member_workloads()
    return success(
        {
            "event_id": event_id,
            "teams": teams,
            "members": members,
            "busiest_member": members[0] if members else None,
            "most_available_member": (
                min(
                    (m for m in members if m["user_id"]),
                    key=lambda m: m["open_tasks"],
                    default=None,
                )
            ),
        }
    )


@handle_dynamodb_errors
def get_command_center(event: dict[str, Any]) -> dict[str, Any]:
    """Organization-wide overview for the leader.

    Loads full state for the most relevant events and falls back to the cached health band
    for the rest, so the screen stays fast as an organization accumulates completed events.
    """
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    events = list_organization_events(ctx.organization_id, table_name=ctx.repo.table_name)

    # A team member's command centre is their assigned events only.
    if not ctx.principal.is_leader:
        events = [e for e in events if str(e.get("event_id")) in ctx.principal.event_ids]

    active_statuses = {"ACTIVE", "PUBLISHED", "PAUSED"}
    active = [e for e in events if str(e.get("status")) in active_statuses]
    detailed_targets = (active or events)[:MAX_DETAILED_EVENTS]

    summaries: list[dict[str, Any]] = []
    totals = {
        "pending_approvals": 0,
        "critical_incidents": 0,
        "open_incidents": 0,
        "overdue_tasks": 0,
        "blocked_tasks": 0,
        "unresponsive_speakers": 0,
        "budget_remaining_inr": 0,
    }
    all_attention: list[dict[str, Any]] = []

    for event_record in detailed_targets:
        event_id = str(event_record.get("event_id", ""))
        if not event_id:
            continue
        snapshot = load_event_snapshot(
            ctx.organization_id, event_id, table_name=ctx.repo.table_name
        )
        health = compute_health(snapshot)
        attention = attention_items(snapshot)

        totals["pending_approvals"] += len(snapshot.pending_approvals)
        totals["critical_incidents"] += len(snapshot.open_incidents_by_severity("CRITICAL"))
        totals["open_incidents"] += len(snapshot.open_incidents)
        totals["overdue_tasks"] += len(snapshot.overdue_tasks)
        totals["blocked_tasks"] += len(snapshot.blocked_tasks)
        totals["unresponsive_speakers"] += len(snapshot.silent_speakers)
        totals["budget_remaining_inr"] += snapshot.budget.remaining

        for item in attention:
            all_attention.append({**item, "event_id": event_id})

        summaries.append(
            {
                "event_id": event_id,
                "name": snapshot.event.get("name", ""),
                "status": snapshot.event.get("status", ""),
                "start_date": snapshot.event.get("start_date", ""),
                "health_band": health.band.value,
                "health_score": health.score,
                "health_reasons": [r.detail for r in health.reasons],
                "pending_approvals": len(snapshot.pending_approvals),
                "critical_incidents": len(snapshot.open_incidents_by_severity("CRITICAL")),
                "open_incidents": len(snapshot.open_incidents),
                "overdue_tasks": len(snapshot.overdue_tasks),
                "blocked_tasks": len(snapshot.blocked_tasks),
                "total_tasks": len(snapshot.tasks),
                "completed_tasks": len(snapshot.completed_tasks),
                "teams": len(snapshot.teams),
                "speakers": len(snapshot.speakers),
                "confirmed_speakers": len(snapshot.confirmed_speakers),
                "registered": snapshot.attendees.total_registered,
                "checked_in": snapshot.attendees.checked_in,
                "budget_remaining_inr": snapshot.budget.remaining,
                "budget_utilization_percent": snapshot.budget.utilization_percent,
                "detailed": True,
            }
        )

    detailed_ids = {s["event_id"] for s in summaries}
    for event_record in events:
        event_id = str(event_record.get("event_id", ""))
        if event_id in detailed_ids:
            continue
        summaries.append(
            {
                "event_id": event_id,
                "name": event_record.get("name", ""),
                "status": event_record.get("status", ""),
                "start_date": event_record.get("start_date", ""),
                # Cached rather than recomputed. Marked so the console can say so instead
                # of presenting a possibly stale band as freshly measured.
                "health_band": event_record.get("health_band", "GREEN"),
                "health_score": coerce_int(event_record.get("health_score")),
                "health_reasons": event_record.get("health_reasons", []),
                "detailed": False,
            }
        )

    severity_rank = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    all_attention.sort(key=lambda i: severity_rank.get(str(i["severity"]), 9))

    recent_actions = _recent_agent_activity(ctx)

    return success(
        {
            "organization_id": ctx.organization_id,
            "role": ctx.principal.role.value,
            "summary": {
                "active_events": len(active),
                "total_events": len(events),
                **totals,
                "budget_remaining_formatted": format_inr(totals["budget_remaining_inr"]),
                "attention_required": len(all_attention),
            },
            "events": summaries,
            "attention_items": all_attention[:12],
            "recent_actions": recent_actions,
        }
    )


def _recent_agent_activity(ctx: Any) -> list[dict[str, Any]]:
    """The most recent audit records, newest first.

    Read from the audit table because that is where every actor's actions land, so the feed
    shows the agent and the humans in one timeline rather than only what the agent chose to
    advertise about itself. Failure returns an empty feed: the command centre's job is to
    show what needs attention, and losing the activity strip should not take that with it.
    """
    try:
        from services.api._common import AUDIT_TABLE
        from services.shared.dynamodb import DynamoDBRepository

        audit_repo = DynamoDBRepository(AUDIT_TABLE)
        items, _ = audit_repo.query_page(ctx.organization_id, audit_prefix(), limit=60)
        items.sort(key=lambda a: str(a.get("timestamp", "")), reverse=True)
        return items[:15]
    except Exception:  # noqa: BLE001
        logger.warning("Could not load the recent activity feed", exc_info=True)
        return []
