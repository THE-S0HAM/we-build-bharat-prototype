"""The CommunityOps tool catalogue.

Every capability the agent has is defined here, once, as a :class:`~tools.registry.ToolSpec`.
The registry enforces the boundary; this module supplies the behaviour.

Three groups, and the difference between them is the product:

* **Read** tools return operational state. They are how the agent learns anything. Nothing it
  says about the event comes from anywhere else — there is no tool that lets it recall or
  infer a figure.
* **Auto-authorized write** tools do internal, reversible things: create a task, assign work
  within scope, comment on an incident. These are the tools that make the agent a teammate
  rather than a reporter.
* **Approval-gated** tools never act. They assemble the evidence, compute the impact, and
  raise an ``Approval``. The registry handles that transition, so these handlers only ever
  run once a human has already said yes.

Read tools deliberately return shaped summaries rather than raw records. A raw DynamoDB item
carries index keys, audit columns and fields the model has no use for, and every one of them
costs context that would be better spent on the question. Shaping also means a schema change
does not silently alter what the model sees.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from services.shared.aggregate import EventSnapshot, list_organization_events, load_event_snapshot
from services.shared.models.base import ErrorCategory, utc_now
from services.shared.models.team import TaskPriority, TaskStatus
from services.shared.principal import Role
from services.shared.validation import format_inr, sanitize_name, sanitize_text
from tools.registry import ToolContext, ToolError, ToolRegistry, ToolSpec, truncate_items

logger = logging.getLogger(__name__)

registry = ToolRegistry()

# Both roles unless a tool says otherwise.
BOTH_ROLES = frozenset({Role.LEADER, Role.TEAM_MEMBER})
LEADER_ONLY = frozenset({Role.LEADER})

EVENT_ID_PARAM = {
    "event_id": {
        "type": "string",
        "description": "Event identifier, e.g. EVT-acd-mh-2026. Omit to use the event in context.",
    }
}


def _snapshot(
    ctx: ToolContext, arguments: dict[str, Any], *, attendees: bool = True
) -> EventSnapshot:
    """Load the event snapshot a read tool answers from.

    Every read tool goes through this so the agent's numbers come from the same aggregation
    the console renders. If the two loaded state differently they would eventually disagree,
    and the leader would have no way to tell which was right.
    """
    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    snapshot = load_event_snapshot(
        ctx.organization_id,
        event_id,
        table_name=ctx.table_name,
        include_attendees=attendees,
    )
    if not snapshot.event:
        raise ToolError(
            f"No event {event_id} exists in this organization.", ErrorCategory.NOT_FOUND
        )
    return snapshot


def _task_summary(snapshot: EventSnapshot, task: dict[str, Any]) -> dict[str, Any]:
    return {
        "task_id": task.get("task_id"),
        "title": task.get("title"),
        "team_id": task.get("team_id"),
        "status": task.get("status"),
        "priority": task.get("priority"),
        "assigned_to": task.get("assigned_to") or None,
        "assigned_to_name": task.get("assigned_to_name") or None,
        "due_date": task.get("due_date") or None,
        "is_overdue": snapshot.is_task_overdue(task),
        "blocked_reason": task.get("blocked_reason") or None,
        "depends_on": task.get("depends_on") or [],
    }


def _speaker_summary(snapshot: EventSnapshot, speaker: dict[str, Any]) -> dict[str, Any]:
    """Shape a speaker for the model.

    Contact details are deliberately omitted. The agent's job is to notice that somebody has
    not replied and to draft a follow-up; it never needs the address to do either, and sending
    personal contact details to a model is exactly the kind of avoidable PII exposure the
    security requirements rule out.
    """
    return {
        "speaker_id": speaker.get("speaker_id"),
        "name": speaker.get("name"),
        "status": speaker.get("status"),
        "topic": speaker.get("topic"),
        "session_type": speaker.get("session_type"),
        "session_time": speaker.get("session_time") or None,
        "silent_hours": snapshot.speaker_silent_hours(speaker),
        "followup_count": int(speaker.get("followup_count") or 0),
        "travel_required": bool(speaker.get("travel_required")),
        "travel_origin": speaker.get("travel_origin") or None,
        "accommodation_required": bool(speaker.get("accommodation_required")),
        "accommodation_nights": int(speaker.get("accommodation_nights") or 0),
        "estimated_travel_cost_inr": int(speaker.get("estimated_travel_cost") or 0),
        "estimated_accommodation_cost_inr": int(speaker.get("estimated_accommodation_cost") or 0),
        "slides_submitted": bool(speaker.get("slides_submitted")),
        "availability_confirmed": bool(speaker.get("availability_confirmed")),
        "is_backup": bool(speaker.get("is_backup")),
    }


def _incident_summary(incident: dict[str, Any]) -> dict[str, Any]:
    return {
        "incident_id": incident.get("incident_id"),
        "title": incident.get("title"),
        "severity": incident.get("severity"),
        "status": incident.get("status"),
        "category": incident.get("category"),
        "team_id": incident.get("team_id") or None,
        "affected_resource_type": incident.get("affected_resource_type") or None,
        "affected_resource_id": incident.get("affected_resource_id") or None,
        "reported_by_name": incident.get("reported_by_name") or None,
        "detected_at": incident.get("detected_at"),
        "recommendation": incident.get("recommendation") or None,
        "comment_count": int(incident.get("comment_count") or 0),
    }


def _approval_summary(approval: dict[str, Any]) -> dict[str, Any]:
    from services.shared.validation import coerce_int

    amount = coerce_int(approval.get("amount_inr"))
    return {
        "approval_id": approval.get("approval_id"),
        "title": approval.get("title"),
        "status": approval.get("status"),
        "risk_level": approval.get("risk_level"),
        "requested_action": approval.get("requested_action"),
        "reason": approval.get("reason") or None,
        "amount_inr": amount or None,
        "amount_formatted": format_inr(amount) if amount else None,
        "budget_category": approval.get("budget_category") or None,
        "budget_impact": approval.get("budget_impact") or None,
        "requested_by_name": approval.get("requested_by_name") or None,
        "requested_at": approval.get("requested_at"),
    }


# ===========================================================================
# Read tools
# ===========================================================================


def _list_events(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    events = list_organization_events(ctx.organization_id, table_name=ctx.table_name)
    if not ctx.principal.is_leader:
        events = [e for e in events if str(e.get("event_id")) in ctx.principal.event_ids]
    shaped = [
        {
            "event_id": e.get("event_id"),
            "name": e.get("name"),
            "status": e.get("status"),
            "start_date": e.get("start_date") or None,
            "venue": e.get("venue") or None,
            "city": e.get("city") or None,
            "health_band": e.get("health_band"),
            "health_score": int(e.get("health_score") or 0),
        }
        for e in events
    ]
    return truncate_items(shaped)


registry.register(
    ToolSpec(
        name="list_events",
        description=(
            "List the events this user can see, with each event's cached health band. Use this "
            "first when the user has not said which event they mean."
        ),
        risk_action="ReadOperationalState",
        handler=_list_events,
    )
)


def _get_event(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    from services.shared.health import compute_health

    snapshot = _snapshot(ctx, arguments)
    health = compute_health(snapshot)
    return {
        "event_id": snapshot.event_id,
        "name": snapshot.event.get("name"),
        "status": snapshot.event.get("status"),
        "venue": snapshot.event.get("venue"),
        "city": snapshot.event.get("city"),
        "start_date": snapshot.event.get("start_date"),
        "end_date": snapshot.event.get("end_date"),
        "hours_until_start": snapshot.hours_until_start,
        "expected_attendees": int(snapshot.event.get("expected_attendees") or 0),
        "health_band": health.band.value,
        "health_score": health.score,
        "health_reasons": [r.detail for r in health.reasons],
        "counts": {
            "teams": len(snapshot.teams),
            "tasks": len(snapshot.tasks),
            "open_tasks": len(snapshot.open_tasks),
            "overdue_tasks": len(snapshot.overdue_tasks),
            "blocked_tasks": len(snapshot.blocked_tasks),
            "speakers": len(snapshot.speakers),
            "confirmed_speakers": len(snapshot.confirmed_speakers),
            "open_incidents": len(snapshot.open_incidents),
            "pending_approvals": len(snapshot.pending_approvals),
            "registered": snapshot.attendees.total_registered,
            "checked_in": snapshot.attendees.checked_in,
        },
        "budget_remaining_inr": snapshot.budget.remaining,
        "budget_utilization_percent": snapshot.budget.utilization_percent,
    }


registry.register(
    ToolSpec(
        name="get_event",
        description=(
            "Full operational state of one event: status, dates, health band with the reasons "
            "for it, and counts of tasks, speakers, incidents, approvals and attendees."
        ),
        risk_action="ReadOperationalState",
        handler=_get_event,
        parameters=dict(EVENT_ID_PARAM),
    )
)


def _list_teams(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    snapshot = _snapshot(ctx, arguments, attendees=False)
    teams = [
        {
            "team_id": t.team_id,
            "name": t.name,
            "lead_name": t.lead_name or None,
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
        if ctx.principal.may_see_team(t.team_id)
    ]
    teams.sort(key=lambda t: (-t["overdue_tasks"], -t["blocked_tasks"], t["name"]))
    blocked = [t for t in teams if t["blocked_tasks"] > 0]
    return {
        "teams": teams,
        "count": len(teams),
        "teams_with_blocked_work": [t["name"] for t in blocked],
        "teams_at_risk": [t["name"] for t in teams if t["risk"] in ("HIGH", "MEDIUM")],
    }


registry.register(
    ToolSpec(
        name="list_teams",
        description=(
            "Every team on the event with its workload: open, overdue, blocked and completed "
            "task counts, progress, and a derived risk level. Use this to answer which teams "
            "are blocked or behind."
        ),
        risk_action="ReadOperationalState",
        handler=_list_teams,
        parameters=dict(EVENT_ID_PARAM),
    )
)


def _get_team_workload(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """Per-person workload, so a reassignment suggestion is evidence-based."""
    snapshot = _snapshot(ctx, arguments, attendees=False)
    members = snapshot.member_workloads()
    if not ctx.principal.is_leader:
        members = [m for m in members if m.get("team_id") in ctx.principal.team_ids]
    named = [m for m in members if m["user_id"]]
    return {
        "members": members,
        "busiest": named[0] if named else None,
        "most_available": min(named, key=lambda m: m["open_tasks"]) if named else None,
        "unassigned_open_tasks": next((m["open_tasks"] for m in members if not m["user_id"]), 0),
    }


registry.register(
    ToolSpec(
        name="get_team_workload",
        description=(
            "Open and overdue task counts per person, busiest first, plus who has the most "
            "capacity. Use this before suggesting a reassignment so the suggestion cites real "
            "numbers."
        ),
        risk_action="ReadOperationalState",
        handler=_get_team_workload,
        parameters=dict(EVENT_ID_PARAM),
    )
)


def _list_tasks(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    snapshot = _snapshot(ctx, arguments, attendees=False)
    tasks = snapshot.tasks

    if not ctx.principal.is_leader:
        tasks = [t for t in tasks if str(t.get("team_id")) in ctx.principal.team_ids]

    status = str(arguments.get("status", "")).upper()
    if status == "OVERDUE":
        tasks = [t for t in tasks if snapshot.is_task_overdue(t)]
    elif status == "OPEN":
        tasks = [t for t in tasks if snapshot.is_task_open(t)]
    elif status:
        tasks = [t for t in tasks if str(t.get("status")) == status]

    if team_id := str(arguments.get("team_id", "")):
        tasks = [t for t in tasks if str(t.get("team_id")) == team_id]
    if assignee := str(arguments.get("assigned_to", "")):
        tasks = [t for t in tasks if str(t.get("assigned_to")) == assignee]

    shaped = [_task_summary(snapshot, t) for t in tasks]
    priority_rank = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    shaped.sort(
        key=lambda t: (
            0 if t["is_overdue"] else 1,
            priority_rank.get(str(t["priority"]), 9),
            str(t["due_date"] or "~"),
        )
    )
    result = truncate_items(shaped)
    result["tasks"] = result.pop("items")
    result["overdue_count"] = sum(1 for t in shaped if t["is_overdue"])
    result["blocked_count"] = sum(1 for t in shaped if t["status"] == "BLOCKED")
    return result


registry.register(
    ToolSpec(
        name="list_tasks",
        description=(
            "Tasks for an event, overdue first. Filter by status (use OVERDUE or OPEN for the "
            "derived views), team_id, or assigned_to."
        ),
        risk_action="ReadOperationalState",
        handler=_list_tasks,
        parameters={
            **EVENT_ID_PARAM,
            "status": {
                "type": "string",
                "description": "OVERDUE and OPEN are derived. Otherwise an exact task status.",
                "enum": [
                    "OVERDUE",
                    "OPEN",
                    "BACKLOG",
                    "ASSIGNED",
                    "IN_PROGRESS",
                    "BLOCKED",
                    "REVIEW",
                    "COMPLETED",
                    "CANCELLED",
                ],
            },
            "team_id": {"type": "string", "description": "Restrict to one team, e.g. TEAM-venue."},
            "assigned_to": {"type": "string", "description": "Restrict to one assignee's user id."},
        },
    )
)


def _get_speakers(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    snapshot = _snapshot(ctx, arguments, attendees=False)
    speakers = snapshot.speakers
    if status := str(arguments.get("status", "")).upper():
        if status == "UNRESPONSIVE":
            speakers = snapshot.silent_speakers
        elif status == "AT_RISK":
            speakers = snapshot.silent_speakers + [
                s
                for s in snapshot.unsettled_speakers
                if not s.get("availability_confirmed") and s not in snapshot.silent_speakers
            ]
        else:
            speakers = [s for s in speakers if str(s.get("status")) == status]

    shaped = [_speaker_summary(snapshot, s) for s in speakers]
    shaped.sort(key=lambda s: -int(s["silent_hours"] or 0))

    accommodation_cost = sum(
        int(s["estimated_accommodation_cost_inr"]) for s in shaped if s["accommodation_required"]
    )
    travel_cost = sum(int(s["estimated_travel_cost_inr"]) for s in shaped if s["travel_required"])
    return {
        "speakers": shaped,
        "count": len(shaped),
        "confirmed": len(snapshot.confirmed_speakers),
        "pending": len(snapshot.unsettled_speakers),
        "unresponsive_over_72h": len(snapshot.silent_speakers),
        "needing_accommodation": len(snapshot.speakers_needing_accommodation),
        "estimated_accommodation_cost_inr": accommodation_cost,
        "estimated_travel_cost_inr": travel_cost,
    }


registry.register(
    ToolSpec(
        name="get_speakers",
        description=(
            "Speakers with confirmation status, how long each has been silent, topic, session, "
            "and travel and accommodation requirements with their estimated costs. Filter with "
            "status=UNRESPONSIVE for speakers silent over 72 hours."
        ),
        risk_action="ReadOperationalState",
        handler=_get_speakers,
        parameters={
            **EVENT_ID_PARAM,
            "status": {
                "type": "string",
                "description": "UNRESPONSIVE and AT_RISK are derived; otherwise an exact status.",
                "enum": [
                    "UNRESPONSIVE",
                    "AT_RISK",
                    "IDENTIFIED",
                    "INVITED",
                    "AWAITING_RESPONSE",
                    "FOLLOWUP_SENT",
                    "CONFIRMED",
                    "DECLINED",
                    "CANCELLED",
                    "BACKUP",
                ],
            },
        },
    )
)


def _get_attendee_summary(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    snapshot = _snapshot(ctx, arguments)
    a = snapshot.attendees
    return {
        "total_registered": a.total_registered,
        "confirmed": a.confirmed,
        "cancelled": a.cancelled,
        "waitlisted": a.waitlisted,
        "checked_in": a.checked_in,
        "not_checked_in": a.not_checked_in,
        "accommodation_required": a.accommodation_required,
        "dietary_provided": a.dietary_provided,
        "dietary_missing": a.dietary_missing,
        "arrival_confirmed": a.arrival_confirmed,
        "arrival_conflicts": a.arrival_conflicts,
        "missing_information": a.missing_information,
        "data_completeness_percent": a.data_completeness_percent,
        "expected_attendees": int(snapshot.event.get("expected_attendees") or 0),
    }


registry.register(
    ToolSpec(
        name="get_attendee_summary",
        description=(
            "Aggregate attendee operations: registered, checked in, accommodation required, "
            "dietary details provided or missing, arrival conflicts, and overall data "
            "completeness. Counts only, never individual attendee records."
        ),
        risk_action="ReadOperationalState",
        handler=_get_attendee_summary,
        parameters=dict(EVENT_ID_PARAM),
    )
)


def _list_incidents(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    snapshot = _snapshot(ctx, arguments, attendees=False)
    incidents = (
        snapshot.open_incidents
        if str(arguments.get("open_only", "")).lower() in ("true", "1", "yes")
        else snapshot.incidents
    )
    if severity := str(arguments.get("severity", "")).upper():
        incidents = [i for i in incidents if str(i.get("severity")) == severity]

    severity_rank = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    shaped = sorted(
        (_incident_summary(i) for i in incidents),
        key=lambda i: severity_rank.get(str(i["severity"]), 9),
    )
    return {
        "incidents": shaped,
        "count": len(shaped),
        "open_count": len(snapshot.open_incidents),
        "critical_open": len(snapshot.open_incidents_by_severity("CRITICAL")),
        "high_open": len(snapshot.open_incidents_by_severity("HIGH")),
    }


registry.register(
    ToolSpec(
        name="list_incidents",
        description="Incidents for an event, most severe first. Filter by severity or open_only.",
        risk_action="ReadOperationalState",
        handler=_list_incidents,
        parameters={
            **EVENT_ID_PARAM,
            "severity": {
                "type": "string",
                "enum": ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
                "description": "Restrict to one severity.",
            },
            "open_only": {"type": "boolean", "description": "Exclude resolved and closed."},
        },
    )
)


def _get_incident(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """One incident with its discussion, so the agent can reason about what was said."""
    from services.shared.aggregate import load_incident_comments
    from services.shared.keys import incident_sk

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    incident_id = str(arguments["incident_id"])
    incident = ctx.repo.get_item(ctx.organization_id, incident_sk(event_id, incident_id))
    if not incident:
        raise ToolError(f"No incident {incident_id} on this event.", ErrorCategory.NOT_FOUND)

    comments = load_incident_comments(
        ctx.organization_id, event_id, incident_id, table_name=ctx.table_name
    )
    return {
        **_incident_summary(incident),
        "description": incident.get("description"),
        "impact_analysis": incident.get("impact_analysis") or None,
        "dependencies": incident.get("dependencies") or [],
        "backup_options": incident.get("backup_options") or [],
        "root_cause": incident.get("root_cause") or None,
        "resolution_summary": incident.get("resolution_summary") or None,
        "discussion": [
            {
                "comment_id": c.get("comment_id"),
                "author_name": c.get("author_name"),
                "author_type": c.get("author_type"),
                "author_role": c.get("author_role"),
                "body": c.get("body"),
                "created_at": c.get("created_at"),
                "created_task_id": c.get("created_task_id") or None,
            }
            for c in comments
        ],
    }


registry.register(
    ToolSpec(
        name="get_incident",
        description=(
            "One incident in full, including its discussion thread. Use this before "
            "recommending anything about an incident so the recommendation accounts for what "
            "people have already said."
        ),
        risk_action="ReadOperationalState",
        handler=_get_incident,
        parameters={
            **EVENT_ID_PARAM,
            "incident_id": {"type": "string", "description": "Incident id, e.g. INC-014."},
        },
        required=["incident_id"],
    )
)


def _list_approvals(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    snapshot = _snapshot(ctx, arguments, attendees=False)
    approvals = snapshot.approvals
    if status := str(arguments.get("status", "")).upper():
        approvals = [a for a in approvals if str(a.get("status")) == status]
    elif str(arguments.get("pending_only", "")).lower() in ("true", "1", "yes"):
        approvals = snapshot.pending_approvals

    if not ctx.principal.is_leader:
        approvals = [a for a in approvals if str(a.get("requested_by")) == ctx.principal.user_id]

    shaped = [_approval_summary(a) for a in approvals]
    shaped.sort(key=lambda a: (a["status"] != "PENDING", str(a["requested_at"] or "")))
    return {
        "approvals": shaped,
        "count": len(shaped),
        "pending_count": len(snapshot.pending_approvals),
        "pending_financial_exposure_inr": snapshot.pending_financial_exposure,
        "pending_financial_exposure_formatted": format_inr(snapshot.pending_financial_exposure),
        "waiting_over_24h": len(snapshot.stale_approvals),
    }


registry.register(
    ToolSpec(
        name="list_approvals",
        description=(
            "Approval requests for an event with their amounts and budget impact. Use this to "
            "answer what decisions are waiting and what they would cost."
        ),
        risk_action="ReadOperationalState",
        handler=_list_approvals,
        parameters={
            **EVENT_ID_PARAM,
            "status": {
                "type": "string",
                "enum": ["PENDING", "APPROVED", "DECLINED", "EDITED", "EXPIRED"],
            },
            "pending_only": {"type": "boolean", "description": "Only undecided requests."},
        },
    )
)


def _get_budget(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """The authoritative budget.

    Read from ``budget_service``, the same code the write path uses. The agent is explicitly
    not permitted to compute a budget figure: it reports what this returns.
    """
    from services.shared import budget_service

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    summary = budget_service.get_budget(ctx.organization_id, event_id, table_name=ctx.table_name)

    if not summary["exists"]:
        return {
            "exists": False,
            "message": "No budget has been set for this event yet.",
        }

    highest = max(
        (c for c in summary["categories"] if int(c["allocated"]) > 0),
        key=lambda c: int(c["utilization_percent"]),
        default=None,
    )
    return {
        "exists": True,
        "currency": summary["currency"],
        "total_budget_inr": summary.total_budget,
        "allocated_inr": summary["allocated"],
        "spent_inr": summary.spent,
        "committed_inr": summary.committed,
        "remaining_inr": summary.remaining,
        "unallocated_inr": summary["unallocated"],
        "utilization_percent": summary["utilization_percent"],
        "formatted": {
            "total": format_inr(summary.total_budget),
            "spent": format_inr(summary.spent),
            "committed": format_inr(summary.committed),
            "remaining": format_inr(summary.remaining),
        },
        "categories": summary["categories"],
        "highest_utilization_category": highest,
    }


registry.register(
    ToolSpec(
        name="get_budget",
        description=(
            "The authoritative event budget: total, allocated, spent, committed, remaining, "
            "utilization, and the per-category breakdown. Always call this before stating any "
            "budget figure. Never calculate a budget number yourself."
        ),
        risk_action="ReadOperationalState",
        handler=_get_budget,
        parameters=dict(EVENT_ID_PARAM),
    )
)


def _project_budget(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """Answer "can we afford this?" and "what happens if I approve it?" exactly.

    Runs the same projection the write path uses, so the predicted remaining balance is the
    number that will actually result. This is the tool that lets the agent answer a
    hypothetical without ever doing the arithmetic itself.
    """
    from services.shared import budget_service

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    summary = budget_service.get_budget(ctx.organization_id, event_id, table_name=ctx.table_name)
    if not summary["exists"]:
        raise ToolError("This event has no budget set, so nothing can be projected against it.")

    amount = int(arguments["amount_inr"])
    category = str(arguments.get("category", "OTHER"))

    if approval_id := str(arguments.get("approval_id", "")):
        from services.shared.keys import approval_sk
        from services.shared.validation import coerce_int

        approval = ctx.repo.get_item(ctx.organization_id, approval_sk(event_id, approval_id))
        if not approval:
            raise ToolError(f"No approval {approval_id} on this event.", ErrorCategory.NOT_FOUND)
        amount = coerce_int(approval.get("amount_inr"))
        category = str(approval.get("budget_category", "OTHER"))

    projection = budget_service.project_commitment(summary, category, amount)
    return {
        **projection,
        "formatted": {
            "amount": format_inr(int(projection["amount_inr"])),
            "current_remaining": format_inr(int(projection["current_remaining"])),
            "projected_remaining": format_inr(int(projection["projected_remaining"])),
        },
    }


registry.register(
    ToolSpec(
        name="calculate_remaining_budget",
        description=(
            "Compute the exact effect of committing an amount, without changing anything. Use "
            "this for 'can we afford X' and 'what happens if I approve this'. Pass approval_id "
            "to project an existing request, or category and amount_inr for a hypothetical."
        ),
        risk_action="SummarizeData",
        handler=_project_budget,
        parameters={
            **EVENT_ID_PARAM,
            "amount_inr": {
                "type": "integer",
                "money": True,
                "description": "Whole rupees. Ignored when approval_id is given.",
            },
            "category": {
                "type": "string",
                "enum": [
                    "VENUE",
                    "CATERING",
                    "SPEAKER_TRAVEL",
                    "ACCOMMODATION",
                    "EQUIPMENT",
                    "MARKETING",
                    "CERTIFICATES",
                    "TRANSPORTATION",
                    "EMERGENCY",
                    "OTHER",
                ],
            },
            "approval_id": {
                "type": "string",
                "description": "Project an existing approval request instead of a hypothetical.",
            },
        },
    )
)


def _get_event_risk(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """The health score and why it is what it is."""
    from services.shared.health import attention_items, compute_health

    snapshot = _snapshot(ctx, arguments)
    health = compute_health(snapshot)
    return {
        "event_id": snapshot.event_id,
        "health_band": health.band.value,
        "health_score": health.score,
        "score_explanation": (
            "Penalty points are summed from each signal and capped at 100. "
            "0-14 GREEN, 15-34 YELLOW, 35-59 ORANGE, 60+ RED."
        ),
        "signals": [r.to_dict() for r in health.reasons],
        "attention_items": attention_items(snapshot),
    }


registry.register(
    ToolSpec(
        name="get_event_risk",
        description=(
            "The event's health band and score with the signals that produced it, each showing "
            "how many points it contributed, plus the ranked list of what needs attention. Use "
            "this to explain why an event is at a given risk level. The score is computed by "
            "the backend; report it, do not recompute it."
        ),
        risk_action="ComputeEventHealth",
        handler=_get_event_risk,
        parameters=dict(EVENT_ID_PARAM),
    )
)


def _generate_brief(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """The operations brief, assembled by the same code the API endpoint uses."""
    from services.api.operations_handler import build_brief

    snapshot = _snapshot(ctx, arguments)
    return build_brief(snapshot)


registry.register(
    ToolSpec(
        name="generate_event_brief",
        description=(
            "Today's operations brief for an event: decisions required, high-risk items, work "
            "progressing on its own, overdue tasks, incidents, budget position, speaker status, "
            "and a recommended priority order. Every figure is read from operational state."
        ),
        risk_action="GenerateEventBrief",
        handler=_generate_brief,
        parameters=dict(EVENT_ID_PARAM),
    )
)


def _search_documents(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """Find event documents by metadata.

    Filename and category matching only. There is no index over document *contents*, so the
    result says so explicitly — otherwise the model would summarise a policy it has never
    read, on the strength of a matching filename.
    """
    from services.shared.keys import document_prefix

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    documents = ctx.repo.query_all(ctx.organization_id, document_prefix(event_id), max_items=500)

    if category := str(arguments.get("category", "")).upper():
        documents = [d for d in documents if str(d.get("category")) == category]
    if query := str(arguments.get("query", "")).lower():
        documents = [
            d
            for d in documents
            if query in str(d.get("filename", "")).lower()
            or query in str(d.get("description", "")).lower()
        ]

    shaped = [
        {
            "document_id": d.get("document_id"),
            "filename": d.get("filename"),
            "category": d.get("category"),
            "file_type": d.get("file_type"),
            "size_bytes": int(d.get("size_bytes") or 0),
            "description": d.get("description") or None,
            "uploaded_at": d.get("uploaded_at"),
        }
        for d in documents
    ]
    result = truncate_items(shaped)
    result["documents"] = result.pop("items")
    result["search_limitation"] = (
        "Matches filenames, descriptions and categories only. Document contents are not "
        "indexed or searched, so do not summarise or quote what a document says — point the "
        "user to it instead."
    )
    return result


registry.register(
    ToolSpec(
        name="search_event_documents",
        description=(
            "Find event documents by filename, description or category. Returns metadata only; "
            "document contents are not indexed, so you cannot read or summarise what is inside "
            "them."
        ),
        risk_action="SearchEventDocuments",
        handler=_search_documents,
        parameters={
            **EVENT_ID_PARAM,
            "query": {"type": "string", "description": "Match filenames and descriptions."},
            "category": {
                "type": "string",
                "enum": [
                    "SPEAKER",
                    "VENUE",
                    "BUDGET",
                    "VOLUNTEER",
                    "SPONSOR",
                    "POLICY",
                    "RECEIPT",
                    "OTHER",
                ],
            },
        },
    )
)


def _list_notifications(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    from services.shared.notify import list_notifications

    items = list_notifications(
        ctx.organization_id,
        ctx.principal.user_id,
        unread_only=str(arguments.get("unread_only", "")).lower() in ("true", "1", "yes"),
        table_name=ctx.table_name,
    )
    shaped = [
        {
            "notification_id": n.get("notification_id"),
            "type": n.get("type"),
            "severity": n.get("severity"),
            "title": n.get("title"),
            "body": n.get("body"),
            "is_read": bool(n.get("is_read")),
            "created_at": n.get("created_at"),
        }
        for n in items
    ]
    result = truncate_items(shaped)
    result["notifications"] = result.pop("items")
    result["unread_count"] = sum(1 for n in shaped if not n["is_read"])
    return result


registry.register(
    ToolSpec(
        name="list_notifications",
        description="The signed-in user's own notifications, newest first.",
        risk_action="ReadNotifications",
        handler=_list_notifications,
        parameters={"unread_only": {"type": "boolean", "description": "Only unread ones."}},
    )
)


# ===========================================================================
# Auto-authorized write tools
# ===========================================================================


def _create_task(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """Create an internal task.

    LOW risk, so the agent does this without asking. Creating a task is reversible, internal,
    and the alternative — telling the user "you should make a task for that" — is exactly the
    coordination work the product exists to remove.
    """
    from services.shared.keys import (
        event_gsi1pk,
        task_gsi1sk,
        task_gsi2pk,
        task_gsi2sk,
        task_sk,
        team_sk,
    )

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    team_id = str(arguments["team_id"])
    if ctx.repo.get_item(ctx.organization_id, team_sk(event_id, team_id)) is None:
        raise ToolError(
            f"There is no team {team_id} on this event. Call list_teams for the real ids.",
            ErrorCategory.NOT_FOUND,
        )

    task_id = f"TSK-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()
    assignee = str(arguments.get("assigned_to", ""))
    due_date = str(arguments.get("due_date", ""))
    status = TaskStatus.ASSIGNED.value if assignee else TaskStatus.BACKLOG.value
    priority = str(arguments.get("priority", TaskPriority.MEDIUM.value)).upper()
    title = sanitize_name(str(arguments["title"]))

    ctx.repo.put_item(
        ctx.organization_id,
        task_sk(event_id, team_id, task_id),
        {
            "entity_type": "TASK",
            "event_id": event_id,
            "team_id": team_id,
            "task_id": task_id,
            "title": title,
            "description": sanitize_text(str(arguments.get("description", ""))),
            "status": status,
            "priority": priority,
            "risk": "NONE",
            "assigned_to": assignee,
            "assigned_to_name": "",
            "due_date": due_date,
            "depends_on": [str(d) for d in (arguments.get("depends_on") or [])][:20],
            "blocks": [],
            "escalation_level": 0,
            "estimated_effort_hours": 0,
            "blocked_reason": "",
            "notes": "Created by the CommunityOps agent.",
            "created_at": now,
            "updated_at": now,
            "created_by": ctx.principal.user_id,
            "updated_by": ctx.principal.user_id,
            "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
            "GSI1SK": task_gsi1sk(status, now),
            "GSI2PK": task_gsi2pk(ctx.organization_id, event_id),
            "GSI2SK": task_gsi2sk(status, due_date, task_id),
        },
    )

    if assignee and assignee != ctx.principal.user_id:
        from services.shared.models.notification import NotificationType
        from services.shared.notify import notify

        notify(
            ctx.organization_id,
            assignee,
            NotificationType.TASK_ASSIGNED,
            f"Assigned to you: {title}",
            body=f"Due {due_date}" if due_date else "No deadline set.",
            event_id=event_id,
            resource_type="Task",
            resource_id=task_id,
            actor_id=ctx.principal.user_id,
        )

    return {
        "task_id": task_id,
        "status": status,
        "team_id": team_id,
        "resource_type": "Task",
        "resource_id": task_id,
        "message": f"Created task {task_id} for {team_id}.",
    }


registry.register(
    ToolSpec(
        name="create_task",
        description=(
            "Create a task for a team. Call list_teams first to get a real team_id. Use this "
            "whenever the user agrees work needs doing, rather than telling them to create it."
        ),
        risk_action="CreateInternalTask",
        handler=_create_task,
        mutating=True,
        parameters={
            **EVENT_ID_PARAM,
            "team_id": {"type": "string", "description": "Owning team, e.g. TEAM-tech."},
            "title": {"type": "string", "description": "What needs doing, stated as an action."},
            "description": {"type": "string", "description": "Any detail worth recording."},
            "priority": {
                "type": "string",
                "enum": ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
            },
            "due_date": {"type": "string", "description": "ISO-8601 deadline."},
            "assigned_to": {"type": "string", "description": "Assignee's user id, if known."},
            "depends_on": {"type": "array", "description": "Task ids that must finish first."},
        },
        required=["team_id", "title"],
    )
)


def _update_task(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    from services.shared.keys import task_gsi1sk, task_gsi2sk, task_sk
    from services.shared.principal import authorize_task_access

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    team_id = str(arguments["team_id"])
    task_id = str(arguments["task_id"])
    sk = task_sk(event_id, team_id, task_id)

    existing = ctx.repo.get_item(ctx.organization_id, sk)
    if not existing:
        raise ToolError(f"No task {task_id} in {team_id}.", ErrorCategory.NOT_FOUND)

    # The same per-task rule the API applies: a team member may not edit a teammate's
    # in-flight work, and the agent inherits that restriction rather than routing around it.
    if authorize_task_access(ctx.principal, existing, write=True) is not None:
        raise ToolError(
            "That task belongs to another team member. A leader has to reassign it first.",
            ErrorCategory.FORBIDDEN,
        )

    now = utc_now().isoformat()
    updates: dict[str, Any] = {"updated_at": now, "updated_by": ctx.principal.user_id}

    if status := str(arguments.get("status", "")).upper():
        if status == TaskStatus.OVERDUE.value:
            raise ToolError(
                "OVERDUE is derived from the due date and cannot be set. Use BLOCKED if the "
                "task is stuck, or change the due date."
            )
        if (
            status == TaskStatus.BLOCKED.value
            and not str(arguments.get("blocked_reason", "")).strip()
        ):
            raise ToolError("Blocking a task needs a blocked_reason so it can be unblocked.")
        updates["status"] = status
        updates["GSI1SK"] = task_gsi1sk(status, str(existing.get("created_at", now)))
        updates["GSI2SK"] = task_gsi2sk(status, str(existing.get("due_date", "")), task_id)
        if status == TaskStatus.COMPLETED.value:
            updates["completed_at"] = now

    for name, field in (
        ("blocked_reason", "blocked_reason"),
        ("notes", "notes"),
        ("priority", "priority"),
    ):
        if arguments.get(name):
            updates[field] = sanitize_text(str(arguments[name]), 2000)

    if len(updates) <= 2:
        raise ToolError("Nothing to change. Provide status, priority, notes or blocked_reason.")

    ctx.repo.update_item(ctx.organization_id, sk, updates)
    return {
        "task_id": task_id,
        "resource_type": "Task",
        "resource_id": task_id,
        "updated": sorted(k for k in updates if not k.startswith("GSI")),
        "message": f"Updated {task_id}.",
    }


registry.register(
    ToolSpec(
        name="update_task",
        description="Change a task's status, priority, notes or blocked reason.",
        risk_action="UpdateTask",
        handler=_update_task,
        mutating=True,
        parameters={
            **EVENT_ID_PARAM,
            "team_id": {"type": "string"},
            "task_id": {"type": "string"},
            "status": {
                "type": "string",
                "enum": [
                    "BACKLOG",
                    "ASSIGNED",
                    "IN_PROGRESS",
                    "BLOCKED",
                    "REVIEW",
                    "COMPLETED",
                    "CANCELLED",
                ],
            },
            "priority": {"type": "string", "enum": ["CRITICAL", "HIGH", "MEDIUM", "LOW"]},
            "blocked_reason": {"type": "string", "description": "Required when blocking."},
            "notes": {"type": "string"},
        },
        required=["team_id", "task_id"],
    )
)


def _assign_task(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """Assign unowned work within scope.

    Assigning an *unassigned* task is LOW risk: nobody loses work. Taking a task off somebody
    who already has it is a different act, so it is refused here and directed at the leader's
    reassign route, which the agent can only recommend.
    """
    from services.shared.keys import task_gsi1sk, task_gsi2sk, task_sk

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    team_id = str(arguments["team_id"])
    task_id = str(arguments["task_id"])
    assignee = str(arguments["assigned_to"])
    sk = task_sk(event_id, team_id, task_id)

    existing = ctx.repo.get_item(ctx.organization_id, sk)
    if not existing:
        raise ToolError(f"No task {task_id} in {team_id}.", ErrorCategory.NOT_FOUND)

    current = str(existing.get("assigned_to", ""))
    if current and current != assignee:
        raise ToolError(
            f"{task_id} is already assigned to someone else. Moving work off a person is a "
            "reassignment, which a leader has to approve. Recommend it instead of doing it.",
            ErrorCategory.FORBIDDEN,
        )
    if current == assignee:
        return {
            "task_id": task_id,
            "resource_type": "Task",
            "resource_id": task_id,
            "message": "Already assigned to that person; nothing changed.",
        }

    now = utc_now().isoformat()
    status = TaskStatus.ASSIGNED.value
    ctx.repo.update_item(
        ctx.organization_id,
        sk,
        {
            "assigned_to": assignee,
            "assigned_to_name": sanitize_name(str(arguments.get("assigned_to_name", ""))),
            "status": status,
            "updated_at": now,
            "updated_by": ctx.principal.user_id,
            "GSI1SK": task_gsi1sk(status, str(existing.get("created_at", now))),
            "GSI2SK": task_gsi2sk(status, str(existing.get("due_date", "")), task_id),
        },
    )

    from services.shared.models.notification import NotificationType
    from services.shared.notify import notify

    notify(
        ctx.organization_id,
        assignee,
        NotificationType.TASK_ASSIGNED,
        f"Assigned to you: {existing.get('title', 'a task')}",
        event_id=event_id,
        resource_type="Task",
        resource_id=task_id,
        actor_id=ctx.principal.user_id,
    )

    return {
        "task_id": task_id,
        "assigned_to": assignee,
        "resource_type": "Task",
        "resource_id": task_id,
        "message": f"Assigned {task_id} to {assignee}.",
    }


registry.register(
    ToolSpec(
        name="assign_task",
        description=(
            "Assign an unassigned task to somebody. Refuses if the task already has an owner — "
            "moving work between people is a reassignment and needs a leader."
        ),
        risk_action="AssignTask",
        handler=_assign_task,
        mutating=True,
        parameters={
            **EVENT_ID_PARAM,
            "team_id": {"type": "string"},
            "task_id": {"type": "string"},
            "assigned_to": {"type": "string", "description": "Assignee's user id."},
            "assigned_to_name": {"type": "string"},
        },
        required=["team_id", "task_id", "assigned_to"],
    )
)


def _add_incident_comment(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """Post into an incident's discussion as the agent.

    Attributed with ``author_type = agent`` so the thread visibly distinguishes analysis from
    a human observation. A reader needs to know which is which.
    """
    from services.shared.keys import (
        event_gsi1pk,
        incident_comment_gsi1sk,
        incident_comment_sk,
        incident_sk,
    )

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    incident_id = str(arguments["incident_id"])
    if ctx.repo.get_item(ctx.organization_id, incident_sk(event_id, incident_id)) is None:
        raise ToolError(f"No incident {incident_id} on this event.", ErrorCategory.NOT_FOUND)

    comment_id = f"CMT-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()

    ctx.repo.put_item(
        ctx.organization_id,
        incident_comment_sk(event_id, incident_id, comment_id),
        {
            "entity_type": "INCIDENT_COMMENT",
            "event_id": event_id,
            "incident_id": incident_id,
            "comment_id": comment_id,
            "body": sanitize_text(str(arguments["body"]), 5000),
            "author_id": ctx.principal.user_id,
            "author_name": "CommunityOps Agent",
            "author_type": "agent",
            "author_role": ctx.principal.role.value,
            "team_id": "",
            "parent_comment_id": str(arguments.get("parent_comment_id", "")) or None,
            "attachment_document_id": None,
            "created_task_id": None,
            "created_approval_id": None,
            "created_at": now,
            "updated_at": now,
            "created_by": ctx.principal.user_id,
            "updated_by": ctx.principal.user_id,
            "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
            "GSI1SK": incident_comment_gsi1sk(incident_id, now),
        },
    )
    ctx.repo.atomic_update(
        ctx.organization_id,
        incident_sk(event_id, incident_id),
        adds={"comment_count": 1},
        sets={"updated_at": now},
    )
    return {
        "comment_id": comment_id,
        "resource_type": "IncidentComment",
        "resource_id": comment_id,
        "message": f"Posted analysis to {incident_id}.",
    }


registry.register(
    ToolSpec(
        name="add_incident_comment",
        description=(
            "Post to an incident's discussion thread as the agent. Use this to record impact "
            "analysis, dependencies and recommended actions where the team can see them."
        ),
        risk_action="AddIncidentComment",
        handler=_add_incident_comment,
        mutating=True,
        parameters={
            **EVENT_ID_PARAM,
            "incident_id": {"type": "string"},
            "body": {"type": "string", "description": "The analysis or recommendation."},
            "parent_comment_id": {"type": "string", "description": "Reply to a specific comment."},
        },
        required=["incident_id", "body"],
    )
)


def _create_incident(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    from services.shared.keys import event_gsi1pk, incident_gsi1sk, incident_sk
    from services.shared.models.incident import IncidentStatus

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    incident_id = f"INC-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()
    severity = str(arguments.get("severity", "MEDIUM")).upper()
    status = IncidentStatus.DETECTED.value

    ctx.repo.put_item(
        ctx.organization_id,
        incident_sk(event_id, incident_id),
        {
            "entity_type": "INCIDENT",
            "event_id": event_id,
            "incident_id": incident_id,
            "title": sanitize_name(str(arguments["title"])),
            "description": sanitize_text(str(arguments.get("description", ""))),
            "severity": severity,
            "status": status,
            "category": str(arguments.get("category", "OTHER")).upper(),
            "team_id": str(arguments.get("team_id", "")),
            "affected_resource_type": str(arguments.get("affected_resource_type", "")),
            "affected_resource_id": str(arguments.get("affected_resource_id", "")),
            "detected_at": now,
            "detected_by": "agent",
            "reported_by": ctx.principal.user_id,
            "reported_by_name": "CommunityOps Agent",
            "reported_by_role": ctx.principal.role.value,
            "dependencies": [],
            "backup_options": [],
            "actions_taken": [],
            "comment_count": 0,
            "reopened_count": 0,
            "created_at": now,
            "updated_at": now,
            "created_by": ctx.principal.user_id,
            "updated_by": ctx.principal.user_id,
            "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
            "GSI1SK": incident_gsi1sk(status, now),
        },
    )
    return {
        "incident_id": incident_id,
        "severity": severity,
        "resource_type": "Incident",
        "resource_id": incident_id,
        "message": f"Raised {incident_id} at {severity} severity.",
    }


registry.register(
    ToolSpec(
        name="create_incident",
        description=(
            "Record an operational incident. Use this when a real problem is identified that "
            "needs tracking, not for routine observations."
        ),
        risk_action="CreateIncident",
        handler=_create_incident,
        mutating=True,
        parameters={
            **EVENT_ID_PARAM,
            "title": {"type": "string"},
            "description": {"type": "string"},
            "severity": {"type": "string", "enum": ["CRITICAL", "HIGH", "MEDIUM", "LOW"]},
            "category": {
                "type": "string",
                "enum": [
                    "VENUE",
                    "TECHNICAL",
                    "SPEAKER",
                    "REGISTRATION",
                    "CATERING",
                    "SAFETY",
                    "LOGISTICS",
                    "OTHER",
                ],
            },
            "team_id": {"type": "string"},
            "affected_resource_type": {"type": "string"},
            "affected_resource_id": {"type": "string"},
        },
        required=["title"],
    )
)


def _draft_speaker_followup(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """Draft a follow-up and store it on the speaker record. Does not send anything.

    Drafting is LOW risk and sending is HIGH, and separating them is the whole point: the
    leader gets something ready to review instead of a suggestion that they should write one.
    The draft is stored so it survives the conversation and can be edited before it goes.
    """
    from services.shared.keys import speaker_sk

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    speaker_id = str(arguments["speaker_id"])
    sk = speaker_sk(event_id, speaker_id)
    speaker = ctx.repo.get_item(ctx.organization_id, sk)
    if not speaker:
        raise ToolError(f"No speaker {speaker_id} on this event.", ErrorCategory.NOT_FOUND)

    snapshot = load_event_snapshot(
        ctx.organization_id, event_id, table_name=ctx.table_name, include_attendees=False
    )
    silent_hours = snapshot.speaker_silent_hours(speaker)
    event_name = snapshot.event.get("name", "our event")
    topic = str(speaker.get("topic") or "your session")
    name = str(speaker.get("name", "there")).split()[0]

    draft = (
        f"Hi {name},\n\n"
        f'Following up on {event_name}. We had reached out about "{topic}" and '
        f"have not heard back yet.\n\n"
        "Could you confirm whether you are still able to join us? If your availability has "
        "changed, that is completely fine — knowing either way lets us finalise the schedule.\n\n"
        "If it helps, I can send the current agenda and the logistics details.\n\n"
        "Thanks,\nThe organising team"
    )

    now = utc_now().isoformat()
    ctx.repo.update_item(
        ctx.organization_id,
        sk,
        {
            "followup_draft": draft,
            "followup_draft_at": now,
            "updated_at": now,
            "updated_by": ctx.principal.user_id,
        },
    )

    return {
        "speaker_id": speaker_id,
        "speaker_name": speaker.get("name"),
        "silent_hours": silent_hours,
        "followup_count": int(speaker.get("followup_count") or 0),
        "draft": draft,
        "resource_type": "Speaker",
        "resource_id": speaker_id,
        "sent": False,
        "message": (
            "A follow-up has been drafted and saved against the speaker. It has NOT been sent — "
            "sending an external message needs the leader's approval. Show them the draft and "
            "offer to request approval to send it."
        ),
    }


registry.register(
    ToolSpec(
        name="prepare_speaker_followup",
        description=(
            "Draft a follow-up message for a speaker who has not responded, and save it against "
            "their record. This does NOT send anything: sending needs approval. Use this to give "
            "the leader something ready to review."
        ),
        risk_action="GenerateDraft",
        handler=_draft_speaker_followup,
        mutating=True,
        parameters={
            **EVENT_ID_PARAM,
            "speaker_id": {"type": "string", "description": "Speaker id, e.g. SPK-002."},
        },
        required=["speaker_id"],
    )
)


# ===========================================================================
# Approval-gated tools
#
# The registry intercepts these before the handler runs and raises an Approval instead. The
# handlers below execute only when an approval already exists, which today means they are
# reached through the approvals API rather than through a chat turn. They are written as real
# implementations rather than stubs so the approved path is genuinely wired.
# ===========================================================================


def _build_accommodation_approval(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """Assemble the evidence and cost for a speaker accommodation request."""
    from services.shared import budget_service
    from services.shared.keys import speaker_sk
    from services.shared.validation import coerce_int

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    speaker_id = str(arguments.get("speaker_id", ""))
    speaker = ctx.repo.get_item(ctx.organization_id, speaker_sk(event_id, speaker_id)) or {}

    amount = int(arguments.get("amount_inr") or 0) or coerce_int(
        speaker.get("estimated_accommodation_cost")
    )
    summary = budget_service.get_budget(ctx.organization_id, event_id, table_name=ctx.table_name)
    projection = budget_service.project_commitment(summary, "ACCOMMODATION", amount)

    nights = coerce_int(speaker.get("accommodation_nights"))
    return {
        "title": f"Accommodation for {speaker.get('name', speaker_id)}",
        "description": (
            f"{nights} night(s) accommodation for {speaker.get('name', speaker_id)}, "
            f"travelling from {speaker.get('travel_origin') or 'an unspecified location'}."
        ),
        "reason": "Booking accommodation is a financial commitment on the organization's behalf.",
        "amount_inr": amount,
        "budget_category": "ACCOMMODATION",
        "budget_impact": projection["impact_summary"],
        "resource_type": "Speaker",
        "resource_id": speaker_id,
        "recommendation": (
            f"Affordable: {format_inr(projection['current_remaining'])} remaining now, "
            f"{format_inr(projection['projected_remaining'])} after."
            if projection["affordable"]
            else "Not affordable as things stand: " + "; ".join(projection["blockers"])
        ),
        "evidence": {
            "speaker_id": speaker_id,
            "accommodation_nights": nights,
            "estimated_cost_inr": amount,
            "affordable": projection["affordable"],
            "remaining_before_inr": projection["current_remaining"],
            "remaining_after_inr": projection["projected_remaining"],
        },
    }


def _commit_accommodation(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """Record an approved accommodation commitment. Reached only with an approval."""
    from services.shared.keys import speaker_sk

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    speaker_id = str(arguments["speaker_id"])
    now = utc_now().isoformat()
    ctx.repo.update_item(
        ctx.organization_id,
        speaker_sk(event_id, speaker_id),
        {
            "accommodation_details": sanitize_text(
                str(arguments.get("details", "Approved and being booked.")), 1000
            ),
            "updated_at": now,
            "updated_by": ctx.principal.user_id,
        },
    )
    return {
        "speaker_id": speaker_id,
        "resource_type": "Speaker",
        "resource_id": speaker_id,
        "message": "Accommodation commitment recorded.",
    }


registry.register(
    ToolSpec(
        name="commit_speaker_accommodation",
        description=(
            "Commit to booking accommodation for a speaker. This is a financial commitment, so "
            "calling it prepares an approval request with the cost and budget impact; it does "
            "not book anything."
        ),
        risk_action="AccommodationCommitment",
        handler=_commit_accommodation,
        mutating=True,
        roles=LEADER_ONLY,
        approval_title="Speaker accommodation",
        approval_builder=_build_accommodation_approval,
        parameters={
            **EVENT_ID_PARAM,
            "speaker_id": {"type": "string"},
            "amount_inr": {
                "type": "integer",
                "money": True,
                "description": "Cost in whole rupees. Defaults to the speaker's estimate.",
            },
            "details": {"type": "string", "description": "Hotel, dates, any specifics."},
        },
        required=["speaker_id"],
    )
)


def _build_send_message_approval(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    from services.shared.keys import speaker_sk

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    speaker_id = str(arguments.get("speaker_id", ""))
    speaker = ctx.repo.get_item(ctx.organization_id, speaker_sk(event_id, speaker_id)) or {}
    draft = str(arguments.get("message") or speaker.get("followup_draft") or "")
    return {
        "title": f"Send follow-up to {speaker.get('name', speaker_id)}",
        "description": draft[:2000],
        "reason": (
            "Messages leaving the organization are reviewed before they are sent, because they "
            "cannot be recalled."
        ),
        "resource_type": "Speaker",
        "resource_id": speaker_id,
        "recommendation": (
            f"{speaker.get('name', speaker_id)} has not responded and a draft is ready. "
            "Approve to send it, or edit the wording first."
        ),
        "evidence": {
            "speaker_id": speaker_id,
            "followup_count": int(speaker.get("followup_count") or 0),
            "draft_present": bool(draft),
        },
    }


def _send_speaker_message(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """Queue an approved external message.

    No email transport is configured in this environment, so the message is recorded as queued
    with the approval that authorised it, and the follow-up counter advances. Reporting it as
    sent would be a claim the system cannot substantiate.
    """
    from services.shared.keys import speaker_sk

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    speaker_id = str(arguments["speaker_id"])
    sk = speaker_sk(event_id, speaker_id)
    speaker = ctx.repo.get_item(ctx.organization_id, sk)
    if not speaker:
        raise ToolError(f"No speaker {speaker_id}.", ErrorCategory.NOT_FOUND)

    now = utc_now().isoformat()
    ctx.repo.atomic_update(
        ctx.organization_id,
        sk,
        adds={"followup_count": 1},
        sets={
            "status": "FOLLOWUP_SENT",
            "last_contacted_at": now,
            "followup_queued_at": now,
            "updated_at": now,
            "updated_by": ctx.principal.user_id,
        },
    )
    return {
        "speaker_id": speaker_id,
        "resource_type": "Speaker",
        "resource_id": speaker_id,
        "delivery": "QUEUED",
        "message": (
            "The follow-up is queued and the speaker's record is updated. No email transport is "
            "configured in this environment, so say it is queued for delivery rather than sent."
        ),
    }


registry.register(
    ToolSpec(
        name="send_speaker_message",
        description=(
            "Send a message to a speaker. External communication needs approval, so calling "
            "this prepares a request containing the draft for the leader to approve or edit."
        ),
        risk_action="SendExternalSpeakerMessage",
        handler=_send_speaker_message,
        mutating=True,
        roles=LEADER_ONLY,
        approval_title="Send speaker message",
        approval_builder=_build_send_message_approval,
        parameters={
            **EVENT_ID_PARAM,
            "speaker_id": {"type": "string"},
            "message": {
                "type": "string",
                "description": "Message body. Defaults to the saved draft.",
            },
        },
        required=["speaker_id"],
    )
)


def _build_expenditure_approval(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    from services.shared import budget_service

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    amount = int(arguments.get("amount_inr") or 0)
    category = str(arguments.get("category", "OTHER")).upper()
    summary = budget_service.get_budget(ctx.organization_id, event_id, table_name=ctx.table_name)
    projection = budget_service.project_commitment(summary, category, amount)
    return {
        "title": sanitize_name(str(arguments.get("description", "Expenditure"))),
        "description": sanitize_text(str(arguments.get("description", "")), 2000),
        "reason": "Spending commits the organization's money and cannot be undone once paid.",
        "amount_inr": amount,
        "budget_category": category,
        "budget_impact": projection["impact_summary"],
        "resource_type": "Budget",
        "resource_id": event_id,
        "recommendation": (
            f"Within budget. {format_inr(projection['projected_remaining'])} would remain."
            if projection["affordable"]
            else "Cannot be afforded: " + "; ".join(projection["blockers"])
        ),
        "evidence": {
            "affordable": projection["affordable"],
            "blockers": projection["blockers"],
            "remaining_before_inr": projection["current_remaining"],
            "remaining_after_inr": projection["projected_remaining"],
            "utilization_after_percent": projection["projected_utilization_percent"],
        },
    }


def _record_expense(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    from services.shared import budget_service
    from services.shared.budget_service import BudgetError

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    try:
        expense_id, summary = budget_service.record_expense(
            ctx.organization_id,
            event_id,
            str(arguments["category"]),
            int(arguments["amount_inr"]),
            str(arguments["description"]),
            actor_id=ctx.principal.user_id,
            from_committed=bool(arguments.get("from_committed")),
            table_name=ctx.table_name,
        )
    except BudgetError as exc:
        raise ToolError(exc.message, exc.category) from exc

    return {
        "expense_id": expense_id,
        "resource_type": "Expense",
        "resource_id": expense_id,
        "remaining_inr": summary.remaining,
        "message": f"Recorded. {format_inr(summary.remaining)} remaining.",
    }


registry.register(
    ToolSpec(
        name="record_expense",
        description=(
            "Record money spent against a budget category. Financial, so calling this prepares "
            "an approval request showing the effect on the remaining budget."
        ),
        risk_action="RecordExpense",
        handler=_record_expense,
        mutating=True,
        roles=LEADER_ONLY,
        approval_title="Record expense",
        approval_builder=_build_expenditure_approval,
        parameters={
            **EVENT_ID_PARAM,
            "category": {
                "type": "string",
                "enum": [
                    "VENUE",
                    "CATERING",
                    "SPEAKER_TRAVEL",
                    "ACCOMMODATION",
                    "EQUIPMENT",
                    "MARKETING",
                    "CERTIFICATES",
                    "TRANSPORTATION",
                    "EMERGENCY",
                    "OTHER",
                ],
            },
            "amount_inr": {"type": "integer", "money": True},
            "description": {"type": "string"},
            "from_committed": {
                "type": "boolean",
                "description": "True when this spend was already approved and reserved.",
            },
        },
        required=["category", "amount_inr", "description"],
    )
)


def _build_resolve_incident_approval(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    from services.shared.keys import incident_sk

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    incident_id = str(arguments.get("incident_id", ""))
    incident = ctx.repo.get_item(ctx.organization_id, incident_sk(event_id, incident_id)) or {}
    return {
        "title": f"Resolve: {incident.get('title', incident_id)}",
        "description": sanitize_text(str(arguments.get("resolution_summary", "")), 2000),
        "reason": (
            "Deciding that an operational problem is actually over is a judgement about the "
            "world, not a status change, so a person confirms it."
        ),
        "resource_type": "Incident",
        "resource_id": incident_id,
        "recommendation": str(arguments.get("resolution_summary", "")),
        "evidence": {
            "incident_id": incident_id,
            "severity": incident.get("severity"),
            "current_status": incident.get("status"),
        },
    }


def _resolve_incident(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    from services.shared.keys import incident_gsi1sk, incident_sk
    from services.shared.models.incident import IncidentStatus

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    incident_id = str(arguments["incident_id"])
    sk = incident_sk(event_id, incident_id)
    existing = ctx.repo.get_item(ctx.organization_id, sk)
    if not existing:
        raise ToolError(f"No incident {incident_id}.", ErrorCategory.NOT_FOUND)

    now = utc_now().isoformat()
    ctx.repo.update_item(
        ctx.organization_id,
        sk,
        {
            "status": IncidentStatus.RESOLVED.value,
            "resolution_summary": sanitize_text(str(arguments["resolution_summary"]), 2000),
            "root_cause": sanitize_text(str(arguments.get("root_cause", "")), 2000),
            "resolved_at": now,
            "resolved_by": ctx.principal.user_id,
            "updated_at": now,
            "updated_by": ctx.principal.user_id,
            "GSI1SK": incident_gsi1sk(
                IncidentStatus.RESOLVED.value, str(existing.get("detected_at", now))
            ),
        },
    )
    return {
        "incident_id": incident_id,
        "resource_type": "Incident",
        "resource_id": incident_id,
        "message": "Incident resolved.",
    }


registry.register(
    ToolSpec(
        name="resolve_incident",
        description=(
            "Mark an incident resolved. Needs human confirmation, so calling this prepares an "
            "approval request rather than closing it."
        ),
        risk_action="ResolveIncident",
        handler=_resolve_incident,
        mutating=True,
        roles=LEADER_ONLY,
        approval_title="Resolve incident",
        approval_builder=_build_resolve_incident_approval,
        parameters={
            **EVENT_ID_PARAM,
            "incident_id": {"type": "string"},
            "resolution_summary": {"type": "string", "description": "What was done and why."},
            "root_cause": {"type": "string"},
        },
        required=["incident_id", "resolution_summary"],
    )
)


def _build_allocate_approval(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    from services.shared import budget_service

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    summary = budget_service.get_budget(ctx.organization_id, event_id, table_name=ctx.table_name)
    amount = int(arguments.get("amount_inr") or 0)
    category = str(arguments.get("category", "OTHER")).upper()
    return {
        "title": f"Allocate {format_inr(amount)} to {category}",
        "description": (
            f"Set the {category} allocation to {format_inr(amount)}. "
            f"{format_inr(summary['unallocated'])} is currently unallocated."
        ),
        "reason": "Budget allocation decides what the event's money is available for.",
        "amount_inr": 0,
        "budget_category": category,
        "budget_impact": (f"Unallocated {format_inr(summary['unallocated'])} before this change"),
        "resource_type": "Budget",
        "resource_id": event_id,
        "recommendation": f"{format_inr(summary['unallocated'])} is available to allocate.",
        "evidence": {
            "category": category,
            "requested_allocation_inr": amount,
            "unallocated_inr": summary["unallocated"],
            "total_budget_inr": summary.total_budget,
        },
    }


def _allocate_budget(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    from services.shared import budget_service
    from services.shared.budget_service import BudgetError

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    try:
        summary = budget_service.allocate(
            ctx.organization_id,
            event_id,
            str(arguments["category"]),
            int(arguments["amount_inr"]),
            actor_id=ctx.principal.user_id,
            table_name=ctx.table_name,
        )
    except BudgetError as exc:
        raise ToolError(exc.message, exc.category) from exc
    return {
        "resource_type": "BudgetAllocation",
        "resource_id": str(arguments["category"]).upper(),
        "unallocated_inr": summary["unallocated"],
        "message": f"Allocated. {format_inr(summary['unallocated'])} still unallocated.",
    }


registry.register(
    ToolSpec(
        name="create_budget_allocation",
        description=(
            "Set a budget category's allocation. Financial, so calling this prepares an approval "
            "request rather than changing the budget."
        ),
        risk_action="AllocateBudget",
        handler=_allocate_budget,
        mutating=True,
        roles=LEADER_ONLY,
        approval_title="Budget allocation",
        approval_builder=_build_allocate_approval,
        parameters={
            **EVENT_ID_PARAM,
            "category": {
                "type": "string",
                "enum": [
                    "VENUE",
                    "CATERING",
                    "SPEAKER_TRAVEL",
                    "ACCOMMODATION",
                    "EQUIPMENT",
                    "MARKETING",
                    "CERTIFICATES",
                    "TRANSPORTATION",
                    "EMERGENCY",
                    "OTHER",
                ],
            },
            "amount_inr": {"type": "integer", "money": True},
        },
        required=["category", "amount_inr"],
    )
)


def _build_confirm_speaker_approval(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    from services.shared.keys import speaker_sk

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    speaker_id = str(arguments.get("speaker_id", ""))
    speaker = ctx.repo.get_item(ctx.organization_id, speaker_sk(event_id, speaker_id)) or {}
    return {
        "title": f"Confirm {speaker.get('name', speaker_id)} as a speaker",
        "description": (
            f'Confirm "{speaker.get("topic", "their session")}" '
            f"({speaker.get('session_type', 'TALK')})."
        ),
        "reason": (
            "Confirming a speaker is a public commitment to them and to attendees, and it is "
            "awkward to reverse."
        ),
        "resource_type": "Speaker",
        "resource_id": speaker_id,
        "recommendation": (
            "Availability is confirmed."
            if speaker.get("availability_confirmed")
            else "Availability has not been confirmed yet — worth checking before committing."
        ),
        "evidence": {
            "speaker_id": speaker_id,
            "current_status": speaker.get("status"),
            "availability_confirmed": bool(speaker.get("availability_confirmed")),
            "slides_submitted": bool(speaker.get("slides_submitted")),
        },
    }


def _confirm_speaker(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    from services.shared.keys import speaker_gsi1sk, speaker_sk

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    speaker_id = str(arguments["speaker_id"])
    sk = speaker_sk(event_id, speaker_id)
    existing = ctx.repo.get_item(ctx.organization_id, sk)
    if not existing:
        raise ToolError(f"No speaker {speaker_id}.", ErrorCategory.NOT_FOUND)

    now = utc_now().isoformat()
    ctx.repo.update_item(
        ctx.organization_id,
        sk,
        {
            "status": "CONFIRMED",
            "availability_confirmed": True,
            "response_received_at": now,
            "updated_at": now,
            "updated_by": ctx.principal.user_id,
            "GSI1SK": speaker_gsi1sk("CONFIRMED", str(existing.get("created_at", now))),
        },
    )
    return {
        "speaker_id": speaker_id,
        "resource_type": "Speaker",
        "resource_id": speaker_id,
        "message": "Speaker confirmed.",
    }


registry.register(
    ToolSpec(
        name="confirm_speaker",
        description=(
            "Confirm a speaker's participation. A public commitment, so calling this prepares an "
            "approval request rather than confirming them."
        ),
        risk_action="ConfirmSpeaker",
        handler=_confirm_speaker,
        mutating=True,
        roles=LEADER_ONLY,
        approval_title="Confirm speaker",
        approval_builder=_build_confirm_speaker_approval,
        parameters={**EVENT_ID_PARAM, "speaker_id": {"type": "string"}},
        required=["speaker_id"],
    )
)


def _recommend_reassignment(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """Produce a reassignment recommendation with the workload evidence behind it.

    Reassignment itself is a leader action, so this tool deliberately does not perform one. It
    exists so the agent's suggestion arrives with numbers attached — "Rahul has 11 open tasks,
    Priya has 4" — rather than as an unsupported opinion.
    """
    from services.shared.keys import task_sk

    event_id = ctx.resolve_event_id(str(arguments.get("event_id", "")))
    team_id = str(arguments["team_id"])
    task_id = str(arguments["task_id"])

    task = ctx.repo.get_item(ctx.organization_id, task_sk(event_id, team_id, task_id))
    if not task:
        raise ToolError(f"No task {task_id} in {team_id}.", ErrorCategory.NOT_FOUND)

    snapshot = load_event_snapshot(
        ctx.organization_id, event_id, table_name=ctx.table_name, include_attendees=False
    )
    workloads = [m for m in snapshot.member_workloads() if m["user_id"]]
    team_members = [m for m in workloads if m.get("team_id") == team_id]
    candidates = team_members or workloads

    current_assignee = str(task.get("assigned_to", ""))
    current_load = next((m for m in workloads if m["user_id"] == current_assignee), None)
    suggestion = min(
        (c for c in candidates if c["user_id"] != current_assignee),
        key=lambda m: m["open_tasks"],
        default=None,
    )

    return {
        "task_id": task_id,
        "task_title": task.get("title"),
        "is_overdue": snapshot.is_task_overdue(task),
        "current_assignee": current_assignee or None,
        "current_assignee_open_tasks": current_load["open_tasks"] if current_load else None,
        "suggested_assignee": suggestion,
        "team_workloads": candidates,
        "recommendation_action_required": "reassign_task",
        "message": (
            "This is a recommendation only. Reassigning a task is a leader action, so present "
            "the workload numbers and let the leader decide."
        ),
    }


registry.register(
    ToolSpec(
        name="recommend_task_reassignment",
        description=(
            "Work out who a task would be better assigned to, using real open-task counts per "
            "person. Returns a recommendation with the evidence; it does not reassign anything."
        ),
        risk_action="SummarizeData",
        handler=_recommend_reassignment,
        parameters={
            **EVENT_ID_PARAM,
            "team_id": {"type": "string"},
            "task_id": {"type": "string"},
        },
        required=["team_id", "task_id"],
    )
)


def _decide_approval(ctx: ToolContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """Deciding an approval is never done by the agent.

    Registered so the model has an explicit, informative refusal to relay. Without it, a leader
    asking the agent to "just approve that" gets a vague "I cannot do that"; with it, the model
    can explain that a human decision is the mechanism being protected and point at the
    Approval Center. The action is in the NEVER tier, so the registry refuses before this runs.
    """
    raise ToolError(
        "Approvals are decided by a person in the Approval Center. That is the point of the "
        "approval: the agent prepares the request and the leader decides.",
        ErrorCategory.FORBIDDEN,
    )


registry.register(
    ToolSpec(
        name="decide_approval",
        description=(
            "Approve or reject an approval request. NOT AVAILABLE: approvals are always decided "
            "by a person in the Approval Center. Use list_approvals to show what is waiting and "
            "explain the impact instead."
        ),
        risk_action="ModifyAuthorizationPolicy",
        handler=_decide_approval,
        roles=LEADER_ONLY,
        parameters={
            "approval_id": {"type": "string"},
            "decision": {"type": "string", "enum": ["APPROVED", "DECLINED"]},
        },
        required=["approval_id", "decision"],
    )
)


def tool_catalogue() -> list[dict[str, Any]]:
    """The catalogue, for documentation and the console's transparency panel.

    Exposed so the console can show a leader exactly what the agent is able to do and which
    capabilities are approval-gated. A boundary nobody can inspect is hard to trust.
    """
    return [
        {
            "name": spec.name,
            "description": spec.description,
            "risk_action": spec.risk_action,
            "risk_tier": spec.risk_tier.value,
            "requires_approval": spec.risk_tier.value in ("HIGH", "NEVER"),
            "mutating": spec.mutating,
            "roles": sorted(r.value for r in spec.roles),
        }
        for spec in registry.all()
    ]
