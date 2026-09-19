"""Events and their lifecycle.

Routes:
    GET  /events                            list events with cached health
    POST /events                            create                          (leader)
    GET  /events/{eventId}                   one event with derived counts
    PUT  /events/{eventId}                   update                          (leader)
    POST /events/{eventId}/lifecycle         publish / activate / pause / complete (leader)
    POST /events/{eventId}/archive           archive                         (leader)
    POST /events/{eventId}/duplicate         copy structure to a new event   (leader)
    POST /events/{eventId}/prepare           generate the operational plan   (leader)

Lifecycle transitions are validated rather than free-form. An event that can jump from
DRAFT straight to COMPLETED makes every downstream count meaningless, and the health engine
reads status to decide whether proximity to the start date matters.

Archiving is a status change, never a delete. Events own registrations, tickets, budget
records and an audit trail; removing the parent would orphan all of it, and the audit trail
exists precisely so past decisions stay inspectable.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from services.api._common import (
    begin_request,
    handle_dynamodb_errors,
    path_param,
    pick,
    query_param,
    require_fields,
)
from services.shared.api_response import error, success
from services.shared.audit import create_audit_event
from services.shared.keys import event_gsi1pk, event_sk, event_status_gsi1sk, events_gsi1pk
from services.shared.models.base import ErrorCategory, utc_now
from services.shared.models.event import EventStatus
from services.shared.principal import Role, authorize_scope
from services.shared.validation import (
    coerce_int,
    sanitize_name,
    sanitize_text,
    validate_amount_inr,
)

logger = logging.getLogger(__name__)

EVENT_UPDATE_FIELDS = [
    "name",
    "description",
    "venue",
    "city",
    "start_date",
    "end_date",
    "timezone",
    "expected_attendees",
    "registration_target",
    "registration_open",
    "tags",
]

# Which statuses each status may move to. Anything absent is rejected, so an unexpected
# transition is a 409 rather than a silently corrupted lifecycle.
ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    EventStatus.DRAFT.value: {EventStatus.PUBLISHED.value, EventStatus.CANCELLED.value},
    EventStatus.PUBLISHED.value: {
        EventStatus.ACTIVE.value,
        EventStatus.DRAFT.value,
        EventStatus.CANCELLED.value,
    },
    EventStatus.ACTIVE.value: {
        EventStatus.PAUSED.value,
        EventStatus.COMPLETED.value,
        EventStatus.CANCELLED.value,
    },
    EventStatus.PAUSED.value: {EventStatus.ACTIVE.value, EventStatus.CANCELLED.value},
    EventStatus.COMPLETED.value: {EventStatus.ARCHIVED.value},
    EventStatus.CANCELLED.value: {EventStatus.ARCHIVED.value},
    EventStatus.ARCHIVED.value: set(),
}


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    method = event.get("httpMethod", "GET")
    event_id = path_param(event, "eventId")
    path = str(event.get("resource") or event.get("path") or "")

    if method == "POST":
        if path.endswith("/lifecycle"):
            return change_lifecycle(event, event_id)
        if path.endswith("/archive"):
            return archive_event(event, event_id)
        if path.endswith("/duplicate"):
            return duplicate_event(event, event_id)
        if path.endswith("/prepare"):
            return prepare_event(event, event_id)
        return create_event(event)

    if method == "GET" and event_id:
        return get_event(event, event_id)
    if method == "GET":
        return list_events(event)
    if method == "PUT" and event_id:
        return update_event(event, event_id)

    return error(ErrorCategory.VALIDATION_ERROR, "Unsupported operation")


@handle_dynamodb_errors
def list_events(event: dict[str, Any]) -> dict[str, Any]:
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    from services.shared.aggregate import list_organization_events

    include_archived = query_param(event, "include_archived").lower() == "true"
    events = list_organization_events(
        ctx.organization_id,
        table_name=ctx.repo.table_name,
        include_archived=include_archived,
    )

    if not ctx.principal.is_leader:
        events = [e for e in events if str(e.get("event_id")) in ctx.principal.event_ids]

    return success({"events": events, "count": len(events)})


@handle_dynamodb_errors
def get_event(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """One event with its derived operational counts.

    The counts come from a single snapshot rather than the caller making six follow-up
    requests to populate the page.
    """
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    scope_denied = authorize_scope(ctx.principal, event_id=event_id)
    if scope_denied:
        return scope_denied

    from services.shared.aggregate import load_event_snapshot
    from services.shared.health import compute_health

    snapshot = load_event_snapshot(ctx.organization_id, event_id, table_name=ctx.repo.table_name)
    if not snapshot.event:
        return error(ErrorCategory.NOT_FOUND, "Event not found")

    health = compute_health(snapshot)
    return success(
        {
            **snapshot.event,
            **health.to_dict(),
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
            "budget": {
                "total_inr": snapshot.budget.total_budget,
                "remaining_inr": snapshot.budget.remaining,
                "utilization_percent": snapshot.budget.utilization_percent,
            },
        }
    )


@handle_dynamodb_errors
def create_event(event: dict[str, Any]) -> dict[str, Any]:
    """Create an event, and its budget record when a total was supplied."""
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    missing = require_fields(ctx.body, "name")
    if missing:
        return missing

    total_budget = 0
    if ctx.body.get("total_budget") not in (None, "", 0, "0"):
        validated = validate_amount_inr(ctx.body["total_budget"])
        if validated is None:
            return error(
                ErrorCategory.VALIDATION_ERROR,
                "total_budget must be a whole number of rupees.",
            )
        total_budget = validated

    event_id = f"EVT-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()
    status = EventStatus.DRAFT.value

    ctx.repo.put_item(
        ctx.organization_id,
        event_sk(event_id),
        {
            "entity_type": "EVENT",
            "event_id": event_id,
            "name": sanitize_name(str(ctx.body["name"])),
            "description": sanitize_text(str(ctx.body.get("description", ""))),
            "status": status,
            "venue": sanitize_name(str(ctx.body.get("venue", ""))),
            "city": sanitize_name(str(ctx.body.get("city", ""))),
            "start_date": str(ctx.body.get("start_date", "")),
            "end_date": str(ctx.body.get("end_date", "")),
            "timezone": str(ctx.body.get("timezone", "Asia/Kolkata")),
            "expected_attendees": coerce_int(ctx.body.get("expected_attendees")),
            "registration_target": coerce_int(ctx.body.get("registration_target")),
            "registration_open": bool(ctx.body.get("registration_open", False)),
            "total_budget": total_budget,
            "tags": [sanitize_name(str(t)) for t in (ctx.body.get("tags") or [])][:20],
            "health_band": "GREEN",
            "health_score": 0,
            "health_reasons": [],
            "created_at": now,
            "updated_at": now,
            "created_by": ctx.user_id,
            "updated_by": ctx.user_id,
            "GSI1PK": events_gsi1pk(ctx.organization_id),
            "GSI1SK": event_status_gsi1sk(status, now),
        },
    )

    if total_budget:
        from services.shared import budget_service

        budget_service.ensure_budget(
            ctx.organization_id,
            event_id,
            total_budget,
            actor_id=ctx.user_id,
            table_name=ctx.repo.table_name,
        )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="EVENT_CREATED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Event",
        resource_id=event_id,
        event_id=event_id,
        details={"name": str(ctx.body["name"]), "total_budget": total_budget},
        policy_evaluated="CreateEvent",
    )

    return success(
        {
            "event_id": event_id,
            "status": status,
            "message": "Event created. Use /prepare to generate an operational plan.",
        },
        status_code=201,
    )


@handle_dynamodb_errors
def update_event(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Update event metadata.

    ``status`` is deliberately not updatable here; it goes through the lifecycle route so
    transitions stay validated. ``total_budget`` is not either, because changing it has to
    respect what is already spent, which ``budget_service`` enforces.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    if ctx.repo.get_item(ctx.organization_id, event_sk(event_id)) is None:
        return error(ErrorCategory.NOT_FOUND, "Event not found")

    if "status" in ctx.body:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            "Use POST /events/{eventId}/lifecycle to change the status, so the transition "
            "can be validated.",
        )
    if "total_budget" in ctx.body:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            "Use PUT /events/{eventId}/budget to change the budget, so existing spending "
            "is respected.",
        )

    updates = pick(ctx.body, EVENT_UPDATE_FIELDS)
    if not updates:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            f"Provide at least one field to update: {', '.join(EVENT_UPDATE_FIELDS)}",
        )
    if "name" in updates:
        updates["name"] = sanitize_name(str(updates["name"]))
    updates["updated_at"] = utc_now().isoformat()
    updates["updated_by"] = ctx.user_id

    ctx.repo.update_item(ctx.organization_id, event_sk(event_id), updates)
    create_audit_event(
        organization_id=ctx.organization_id,
        action="EVENT_UPDATED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Event",
        resource_id=event_id,
        event_id=event_id,
        details={"updated_fields": sorted(updates)},
        policy_evaluated="UpdateEventMetadata",
    )
    return success({"event_id": event_id, "message": "Event updated"})


@handle_dynamodb_errors
def change_lifecycle(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Move an event to a new status, if the transition is legal."""
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    missing = require_fields(ctx.body, "status")
    if missing:
        return missing

    target = str(ctx.body["status"]).upper()
    if target not in {s.value for s in EventStatus}:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            f"status must be one of: {', '.join(s.value for s in EventStatus)}",
        )

    existing = ctx.repo.get_item(ctx.organization_id, event_sk(event_id))
    if existing is None:
        return error(ErrorCategory.NOT_FOUND, "Event not found")

    current = str(existing.get("status", EventStatus.DRAFT.value))
    if target == current:
        return success({"event_id": event_id, "status": current, "message": "No change"})

    permitted = ALLOWED_TRANSITIONS.get(current, set())
    if target not in permitted:
        return error(
            ErrorCategory.CONFLICT,
            f"An event cannot move from {current} to {target}. "
            f"From {current} it can go to: {', '.join(sorted(permitted)) or 'nowhere'}.",
        )

    now = utc_now().isoformat()
    updates: dict[str, Any] = {
        "status": target,
        "updated_at": now,
        "updated_by": ctx.user_id,
        # The status is in the index sort key used to list events by status, so it is
        # rewritten on every transition.
        "GSI1SK": event_status_gsi1sk(target, str(existing.get("created_at", now))),
    }
    if target == EventStatus.PAUSED.value:
        updates["paused_at"] = now
    elif target == EventStatus.COMPLETED.value:
        updates["completed_at"] = now
    elif target == EventStatus.ACTIVE.value:
        updates["paused_at"] = None

    ctx.repo.update_item(ctx.organization_id, event_sk(event_id), updates)
    create_audit_event(
        organization_id=ctx.organization_id,
        action=f"EVENT_{target}",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Event",
        resource_id=event_id,
        event_id=event_id,
        details={"from": current, "to": target},
        policy_evaluated="ModifyPublishedEvent" if current != "DRAFT" else "UpdateEventMetadata",
    )
    return success({"event_id": event_id, "status": target, "message": f"Event is now {target}"})


@handle_dynamodb_errors
def archive_event(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Archive an event: hide it from active listings, keep every record.

    Only permitted from a terminal status. Archiving a running event would remove it from
    the command centre while its tasks and incidents were still live, which is how work
    quietly stops being anybody's problem.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    existing = ctx.repo.get_item(ctx.organization_id, event_sk(event_id))
    if existing is None:
        return error(ErrorCategory.NOT_FOUND, "Event not found")

    current = str(existing.get("status", ""))
    if current == EventStatus.ARCHIVED.value:
        return success({"event_id": event_id, "message": "Event is already archived"})
    if EventStatus.ARCHIVED.value not in ALLOWED_TRANSITIONS.get(current, set()):
        return error(
            ErrorCategory.CONFLICT,
            f"An event can only be archived once it is completed or cancelled. "
            f"This one is {current}.",
        )

    now = utc_now().isoformat()
    ctx.repo.update_item(
        ctx.organization_id,
        event_sk(event_id),
        {
            "status": EventStatus.ARCHIVED.value,
            "archived_at": now,
            "updated_at": now,
            "updated_by": ctx.user_id,
            "GSI1SK": event_status_gsi1sk(
                EventStatus.ARCHIVED.value, str(existing.get("created_at", now))
            ),
        },
    )
    create_audit_event(
        organization_id=ctx.organization_id,
        action="EVENT_ARCHIVED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Event",
        resource_id=event_id,
        event_id=event_id,
        details={"from": current},
        policy_evaluated="ArchiveEvent",
    )
    return success({"event_id": event_id, "message": "Event archived"})


@handle_dynamodb_errors
def duplicate_event(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Copy an event's structure into a new DRAFT event.

    Teams and their tasks are copied; registrations, tickets, incidents, approvals, expenses
    and audit history are not. The structure is the reusable part — last year's volunteer
    roster is a useful starting point, last year's attendees are not, and copying an incident
    would fabricate a problem that has not happened.

    Copied tasks are reset to BACKLOG with no assignee or deadline, because carrying a stale
    deadline into a new event would make the new event start life overdue.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    source = ctx.repo.get_item(ctx.organization_id, event_sk(event_id))
    if source is None:
        return error(ErrorCategory.NOT_FOUND, "Event not found")

    from boto3.dynamodb.conditions import Attr

    from services.shared.keys import task_gsi2pk, task_gsi2sk, task_sk, team_prefix, team_sk
    from services.shared.models.team import TaskStatus

    new_event_id = f"EVT-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()
    new_name = sanitize_name(str(ctx.body.get("name") or f"{source.get('name', 'Event')} (copy)"))
    total_budget = coerce_int(source.get("total_budget"))

    ctx.repo.put_item(
        ctx.organization_id,
        event_sk(new_event_id),
        {
            **{
                k: v
                for k, v in source.items()
                # Identity, keys, health and lifecycle timestamps all belong to the source
                # event; copying them would make the new event claim the old one's history.
                if k
                not in {
                    "PK",
                    "SK",
                    "GSI1PK",
                    "GSI1SK",
                    "event_id",
                    "name",
                    "status",
                    "health_band",
                    "health_score",
                    "health_reasons",
                    "health_computed_at",
                    "paused_at",
                    "completed_at",
                    "archived_at",
                    "created_at",
                    "updated_at",
                    "created_by",
                    "updated_by",
                }
            },
            "entity_type": "EVENT",
            "event_id": new_event_id,
            "name": new_name,
            "status": EventStatus.DRAFT.value,
            "start_date": str(ctx.body.get("start_date", "")),
            "end_date": str(ctx.body.get("end_date", "")),
            "registration_open": False,
            "health_band": "GREEN",
            "health_score": 0,
            "health_reasons": [],
            "duplicated_from_event_id": event_id,
            "created_at": now,
            "updated_at": now,
            "created_by": ctx.user_id,
            "updated_by": ctx.user_id,
            "GSI1PK": events_gsi1pk(ctx.organization_id),
            "GSI1SK": event_status_gsi1sk(EventStatus.DRAFT.value, now),
        },
    )

    teams = ctx.repo.query_all(
        ctx.organization_id,
        team_prefix(event_id),
        filter_expression=Attr("entity_type").eq("TEAM"),
    )
    writes: list[tuple[str, dict[str, Any]]] = []
    copied_tasks = 0

    for team in teams:
        team_id = str(team.get("team_id", ""))
        if not team_id:
            continue
        writes.append(
            (
                team_sk(new_event_id, team_id),
                {
                    "entity_type": "TEAM",
                    "event_id": new_event_id,
                    "team_id": team_id,
                    "name": team.get("name", team_id),
                    "description": team.get("description", ""),
                    "responsibilities": team.get("responsibilities", []),
                    "lead_user_id": "",
                    "lead_name": "",
                    "member_count": 0,
                    "is_active": True,
                    "created_at": now,
                    "updated_at": now,
                    "created_by": ctx.user_id,
                    "updated_by": ctx.user_id,
                    "GSI1PK": event_gsi1pk(ctx.organization_id, new_event_id),
                    "GSI1SK": f"TEAM#{team_id}",
                },
            )
        )

        if not ctx.body.get("include_tasks", True):
            continue

        from services.shared.keys import task_prefix

        for task in ctx.repo.query_all(ctx.organization_id, task_prefix(event_id, team_id)):
            new_task_id = f"TSK-{uuid.uuid4().hex[:8]}"
            copied_tasks += 1
            writes.append(
                (
                    task_sk(new_event_id, team_id, new_task_id),
                    {
                        "entity_type": "TASK",
                        "event_id": new_event_id,
                        "team_id": team_id,
                        "task_id": new_task_id,
                        "title": task.get("title", ""),
                        "description": task.get("description", ""),
                        "status": TaskStatus.BACKLOG.value,
                        "priority": task.get("priority", "MEDIUM"),
                        "risk": "NONE",
                        "assigned_to": "",
                        "assigned_to_name": "",
                        "due_date": "",
                        "depends_on": [],
                        "blocks": [],
                        "escalation_level": 0,
                        "estimated_effort_hours": coerce_int(task.get("estimated_effort_hours")),
                        "blocked_reason": "",
                        "notes": "",
                        "created_at": now,
                        "updated_at": now,
                        "created_by": ctx.user_id,
                        "updated_by": ctx.user_id,
                        "GSI1PK": event_gsi1pk(ctx.organization_id, new_event_id),
                        "GSI1SK": f"TASK#{TaskStatus.BACKLOG.value}#{now}",
                        "GSI2PK": task_gsi2pk(ctx.organization_id, new_event_id),
                        "GSI2SK": task_gsi2sk(TaskStatus.BACKLOG.value, "", new_task_id),
                    },
                )
            )

    if writes:
        ctx.repo.batch_put(ctx.organization_id, writes)

    if total_budget:
        from services.shared import budget_service

        budget_service.ensure_budget(
            ctx.organization_id,
            new_event_id,
            total_budget,
            actor_id=ctx.user_id,
            table_name=ctx.repo.table_name,
        )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="EVENT_DUPLICATED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Event",
        resource_id=new_event_id,
        event_id=new_event_id,
        details={
            "source_event_id": event_id,
            "teams_copied": len(teams),
            "tasks_copied": copied_tasks,
        },
        policy_evaluated="CreateEvent",
    )

    return success(
        {
            "event_id": new_event_id,
            "source_event_id": event_id,
            "teams_copied": len(teams),
            "tasks_copied": copied_tasks,
            "message": f"Created {new_name} as a DRAFT copy.",
        },
        status_code=201,
    )


@handle_dynamodb_errors
def prepare_event(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Generate the initial operational plan for an event.

    Creates the eight standard teams and a starting checklist of tasks per team, derived from
    each team's responsibilities. Deadlines are anchored to the event start date and spaced
    backwards, so a plan for an event three weeks out has different dates than one for
    tomorrow.

    Nothing consequential happens here. The plan is teams and internal tasks, both LOW risk,
    and the approvals the plan will eventually need are *listed* rather than raised — the
    leader reviews the plan before anything asks for money.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    existing = ctx.repo.get_item(ctx.organization_id, event_sk(event_id))
    if existing is None:
        return error(ErrorCategory.NOT_FOUND, "Event not found")

    from services.api.planning import generate_operational_plan

    plan = generate_operational_plan(
        ctx.organization_id,
        event_id,
        existing,
        actor_id=ctx.user_id,
        table_name=ctx.repo.table_name,
    )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="EVENT_PLAN_GENERATED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Event",
        resource_id=event_id,
        event_id=event_id,
        details={
            "teams_created": len(plan["teams_created"]),
            "tasks_created": plan["tasks_created"],
        },
        policy_evaluated="CreateInternalTask",
    )
    return success(plan, status_code=201)
