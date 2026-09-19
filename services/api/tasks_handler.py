"""Tasks — the unit of work everything else produces.

Routes:
    GET  /events/{eventId}/tasks                                    every task in scope
    GET  /events/{eventId}/teams/{teamId}/tasks                     one team's tasks
    POST /events/{eventId}/teams/{teamId}/tasks                     create
    PUT  /events/{eventId}/teams/{teamId}/tasks/{taskId}            update
    POST /events/{eventId}/teams/{teamId}/tasks/{taskId}/reassign    reassign      (leader)

Authorization here is finer-grained than elsewhere, because tasks are what a team member
actually spends their time in. A leader manages everything. A team member reads any task
belonging to one of their teams — coordinating requires seeing a teammate's work — but may
only write a task assigned to them or unassigned in their own team. Writing a teammate's
in-flight task is refused: two people silently editing one task is how work gets lost, and
reassignment is a leader's decision.

``OVERDUE`` is derived, never written. Lateness is a function of the deadline and the
current time, so storing it would make a record stale the moment its deadline passed. The
enum retains the value only because older records use it.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from boto3.dynamodb.conditions import Attr

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
from services.shared.keys import (
    event_gsi1pk,
    task_gsi1sk,
    task_gsi2pk,
    task_gsi2sk,
    task_prefix,
    task_sk,
    team_sk,
)
from services.shared.models.base import ErrorCategory, utc_now
from services.shared.models.team import TERMINAL_TASK_STATUSES, TaskPriority, TaskRisk, TaskStatus
from services.shared.principal import Role, authorize_scope, authorize_task_access
from services.shared.validation import sanitize_name, sanitize_text, validate_user_id

logger = logging.getLogger(__name__)

TASK_UPDATE_FIELDS = [
    "title",
    "description",
    "status",
    "priority",
    "risk",
    "assigned_to",
    "assigned_to_name",
    "due_date",
    "depends_on",
    "blocks",
    "escalation_level",
    "estimated_effort_hours",
    "blocked_reason",
    "notes",
]

# Fields a team member may change on their own task. They report progress; they do not
# re-scope the work, move its deadline, or hand it to somebody else.
TEAM_MEMBER_UPDATE_FIELDS = frozenset({"status", "notes", "blocked_reason", "risk"})

VALID_STATUSES = {s.value for s in TaskStatus}
VALID_PRIORITIES = {p.value for p in TaskPriority}
VALID_RISKS = {r.value for r in TaskRisk}


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    method = event.get("httpMethod", "GET")
    event_id = path_param(event, "eventId")
    team_id = path_param(event, "teamId")
    task_id = path_param(event, "taskId")
    path = str(event.get("resource") or event.get("path") or "")

    if path.endswith("/reassign") and method == "POST":
        return reassign_task(event, event_id, team_id, task_id)

    if method == "GET" and not team_id:
        return list_event_tasks(event, event_id)
    if method == "GET":
        return list_team_tasks(event, event_id, team_id)
    if method == "POST":
        return create_task(event, event_id, team_id)
    if method == "PUT" and task_id:
        return update_task(event, event_id, team_id, task_id)

    return error(ErrorCategory.VALIDATION_ERROR, "Unsupported operation")


def _decorate(task: dict[str, Any], now: Any) -> dict[str, Any]:
    """Attach derived lateness so every consumer agrees on it.

    Computed once here rather than in the console and the agent separately, which would let
    two views of the same task disagree across a second boundary.
    """
    from services.shared.aggregate import parse_timestamp

    status = str(task.get("status", ""))
    is_open = status not in TERMINAL_TASK_STATUSES
    due = parse_timestamp(task.get("due_date"))
    is_overdue = bool(is_open and ((due is not None and due < now) or status == "OVERDUE"))
    hours_until_due = None
    if due is not None and is_open:
        hours_until_due = round((due - now).total_seconds() / 3600, 1)
    return {**task, "is_overdue": is_overdue, "hours_until_due": hours_until_due}


@handle_dynamodb_errors
def list_event_tasks(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Every task for an event that the caller may see.

    Supports the leader's event-wide task board, which previously did not exist: the console
    fanned out one request per team and flattened the results client-side, meaning eight
    round trips to render one page.

    Filters: ``status``, ``assigned_to``, ``team_id``, and ``mine=true``.
    """
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    if not event_id:
        return error(ErrorCategory.VALIDATION_ERROR, "eventId is required")

    scope_denied = authorize_scope(ctx.principal, event_id=event_id)
    if scope_denied:
        return scope_denied

    tasks = ctx.repo.query_gsi_all(
        "GSI1",
        event_gsi1pk(ctx.organization_id, event_id),
        sk_begins_with="TASK#",
        max_items=2000,
    )

    # A team member sees their teams' work. Enforced here as well as in the scope gate
    # because this route has no team in its path to check.
    if not ctx.principal.is_leader:
        tasks = [t for t in tasks if str(t.get("team_id")) in ctx.principal.team_ids]

    if status := query_param(event, "status").upper():
        if status == "OVERDUE":
            # Asked for by status, but it is a derived property, so it is applied as a
            # predicate rather than matched against the stored value.
            now = utc_now()
            tasks = [t for t in tasks if _decorate(t, now)["is_overdue"]]
        else:
            tasks = [t for t in tasks if str(t.get("status")) == status]
    if assignee := query_param(event, "assigned_to"):
        tasks = [t for t in tasks if str(t.get("assigned_to")) == assignee]
    if team_filter := query_param(event, "team_id"):
        tasks = [t for t in tasks if str(t.get("team_id")) == team_filter]
    if query_param(event, "mine").lower() == "true":
        tasks = [t for t in tasks if str(t.get("assigned_to")) == ctx.user_id]

    now = utc_now()
    decorated = [_decorate(t, now) for t in tasks]

    priority_rank = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    decorated.sort(
        key=lambda t: (
            1 if str(t.get("status")) in TERMINAL_TASK_STATUSES else 0,
            0 if t["is_overdue"] else 1,
            priority_rank.get(str(t.get("priority")), 9),
            str(t.get("due_date") or "~"),
        )
    )

    return success(
        {
            "tasks": decorated,
            "count": len(decorated),
            "overdue_count": sum(1 for t in decorated if t["is_overdue"]),
            "blocked_count": sum(1 for t in decorated if str(t.get("status")) == "BLOCKED"),
            "completed_count": sum(1 for t in decorated if str(t.get("status")) == "COMPLETED"),
            "in_progress_count": sum(1 for t in decorated if str(t.get("status")) == "IN_PROGRESS"),
        }
    )


@handle_dynamodb_errors
def list_team_tasks(event: dict[str, Any], event_id: str, team_id: str) -> dict[str, Any]:
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    if not event_id or not team_id:
        return error(ErrorCategory.VALIDATION_ERROR, "eventId and teamId are required")

    scope_denied = authorize_scope(ctx.principal, event_id=event_id, team_id=team_id)
    if scope_denied:
        return scope_denied

    items = ctx.repo.query_all(ctx.organization_id, task_prefix(event_id, team_id), max_items=500)
    now = utc_now()
    decorated = [_decorate(t, now) for t in items]
    return success(
        {
            "tasks": decorated,
            "count": len(decorated),
            "overdue_count": sum(1 for t in decorated if t["is_overdue"]),
        }
    )


@handle_dynamodb_errors
def create_task(event: dict[str, Any], event_id: str, team_id: str) -> dict[str, Any]:
    """Create a task.

    Open to both roles within scope: a volunteer writing down work they have discovered is
    exactly the behaviour worth encouraging, and ``CreateInternalTask`` is LOW risk under the
    policy catalogue for the same reason.
    """
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    if not event_id or not team_id:
        return error(ErrorCategory.VALIDATION_ERROR, "eventId and teamId are required")

    scope_denied = authorize_scope(ctx.principal, event_id=event_id, team_id=team_id)
    if scope_denied:
        return scope_denied

    missing = require_fields(ctx.body, "title")
    if missing:
        return missing

    if ctx.repo.get_item(ctx.organization_id, team_sk(event_id, team_id)) is None:
        return error(ErrorCategory.NOT_FOUND, f"Team {team_id} does not exist for this event")

    priority = str(ctx.body.get("priority", TaskPriority.MEDIUM.value)).upper()
    if priority not in VALID_PRIORITIES:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            f"priority must be one of: {', '.join(sorted(VALID_PRIORITIES))}",
        )

    risk = str(ctx.body.get("risk", TaskRisk.NONE.value)).upper()
    if risk not in VALID_RISKS:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            f"risk must be one of: {', '.join(sorted(VALID_RISKS))}",
        )

    assigned_to = str(ctx.body.get("assigned_to", "")).strip()
    if assigned_to and not validate_user_id(assigned_to):
        return error(ErrorCategory.VALIDATION_ERROR, "assigned_to is not a valid user id")

    # Status follows from whether the work has an owner, rather than being a separate thing
    # the caller has to remember to set consistently with the assignee.
    status = TaskStatus.ASSIGNED.value if assigned_to else TaskStatus.BACKLOG.value

    task_id = f"TSK-{uuid.uuid4().hex[:8]}"
    now_iso = utc_now().isoformat()
    due_date = str(ctx.body.get("due_date", ""))

    ctx.repo.put_item(
        ctx.organization_id,
        task_sk(event_id, team_id, task_id),
        {
            "entity_type": "TASK",
            "event_id": event_id,
            "team_id": team_id,
            "task_id": task_id,
            "title": sanitize_name(str(ctx.body["title"])),
            "description": sanitize_text(str(ctx.body.get("description", ""))),
            "status": status,
            "priority": priority,
            "risk": risk,
            "assigned_to": assigned_to,
            "assigned_to_name": sanitize_name(str(ctx.body.get("assigned_to_name", ""))),
            "due_date": due_date,
            "depends_on": [str(d) for d in (ctx.body.get("depends_on") or [])][:20],
            "blocks": [str(b) for b in (ctx.body.get("blocks") or [])][:20],
            "escalation_level": 0,
            "estimated_effort_hours": int(ctx.body.get("estimated_effort_hours") or 0),
            "blocked_reason": "",
            "notes": "",
            "source_comment_id": None,
            "source_incident_id": None,
            "created_at": now_iso,
            "updated_at": now_iso,
            "created_by": ctx.user_id,
            "updated_by": ctx.user_id,
            "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
            "GSI1SK": task_gsi1sk(status, now_iso),
            # GSI2 orders by status then deadline, which is what "what is open and due
            # soonest" needs; GSI1's creation-ordered key cannot answer that.
            "GSI2PK": task_gsi2pk(ctx.organization_id, event_id),
            "GSI2SK": task_gsi2sk(status, due_date, task_id),
        },
    )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="TASK_CREATED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Task",
        resource_id=task_id,
        event_id=event_id,
        details={"team_id": team_id, "title": str(ctx.body["title"]), "priority": priority},
        policy_evaluated="CreateInternalTask",
    )

    if assigned_to and assigned_to != ctx.user_id:
        _notify_assignee(ctx, event_id, task_id, assigned_to, str(ctx.body["title"]), due_date)

    return success(
        {"task_id": task_id, "status": status, "message": "Task created"}, status_code=201
    )


@handle_dynamodb_errors
def update_task(event: dict[str, Any], event_id: str, team_id: str, task_id: str) -> dict[str, Any]:
    """Update a task, with both index sort keys kept in step with the status."""
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    sk = task_sk(event_id, team_id, task_id)
    existing = ctx.repo.get_item(ctx.organization_id, sk)
    if not existing:
        return error(ErrorCategory.NOT_FOUND, "Task not found")

    access_denied = authorize_task_access(ctx.principal, existing, write=True)
    if access_denied:
        return access_denied

    updates = pick(ctx.body, TASK_UPDATE_FIELDS)
    if not updates:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            f"Provide at least one field to update: {', '.join(TASK_UPDATE_FIELDS)}",
        )

    if not ctx.principal.is_leader:
        forbidden = sorted(set(updates) - TEAM_MEMBER_UPDATE_FIELDS)
        if forbidden:
            return error(
                ErrorCategory.FORBIDDEN,
                f"You can update {', '.join(sorted(TEAM_MEMBER_UPDATE_FIELDS))} on your own "
                f"tasks. Ask a leader to change: {', '.join(forbidden)}.",
            )

    if "status" in updates:
        status = str(updates["status"]).upper()
        if status not in VALID_STATUSES:
            return error(
                ErrorCategory.VALIDATION_ERROR,
                f"status must be one of: {', '.join(sorted(VALID_STATUSES))}",
            )
        if status == TaskStatus.OVERDUE.value:
            return error(
                ErrorCategory.VALIDATION_ERROR,
                "OVERDUE is derived from the due date and cannot be set directly. "
                "Change the due date, or use BLOCKED if the task is stuck.",
            )
        if (
            status == TaskStatus.BLOCKED.value
            and not str(ctx.body.get("blocked_reason", existing.get("blocked_reason", ""))).strip()
        ):
            return error(
                ErrorCategory.VALIDATION_ERROR,
                "Blocking a task needs a blocked_reason, so somebody can unblock it.",
            )
        updates["status"] = status

    if "priority" in updates:
        priority = str(updates["priority"]).upper()
        if priority not in VALID_PRIORITIES:
            return error(ErrorCategory.VALIDATION_ERROR, "Unrecognised priority")
        updates["priority"] = priority

    if "risk" in updates:
        risk = str(updates["risk"]).upper()
        if risk not in VALID_RISKS:
            return error(ErrorCategory.VALIDATION_ERROR, "Unrecognised risk")
        updates["risk"] = risk

    now = utc_now()
    now_iso = now.isoformat()
    updates["updated_at"] = now_iso
    updates["updated_by"] = ctx.user_id

    new_status = str(updates.get("status", existing.get("status", "")))
    if "status" in updates:
        if new_status == TaskStatus.COMPLETED.value and str(existing.get("status")) != new_status:
            updates["completed_at"] = now_iso
        # Both index sort keys carry the status, so a transition rewrites both. Missing
        # either leaves the task invisible to one of the two query paths.
        updates["GSI1SK"] = task_gsi1sk(new_status, str(existing.get("created_at", now_iso)))
        updates["GSI2SK"] = task_gsi2sk(
            new_status, str(updates.get("due_date", existing.get("due_date", ""))), task_id
        )
    elif "due_date" in updates:
        updates["GSI2SK"] = task_gsi2sk(new_status, str(updates["due_date"]), task_id)

    ctx.repo.update_item(ctx.organization_id, sk, updates)

    create_audit_event(
        organization_id=ctx.organization_id,
        action="TASK_UPDATED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Task",
        resource_id=task_id,
        event_id=event_id,
        details={
            "team_id": team_id,
            "updated_fields": sorted(k for k in updates if not k.startswith("GSI")),
            "status": new_status,
        },
        policy_evaluated="UpdateTask",
    )

    new_assignee = str(updates.get("assigned_to", ""))
    if new_assignee and new_assignee != str(existing.get("assigned_to", "")):
        _notify_assignee(
            ctx,
            event_id,
            task_id,
            new_assignee,
            str(existing.get("title", "")),
            str(updates.get("due_date", existing.get("due_date", ""))),
        )

    return success({"task_id": task_id, "status": new_status, "message": "Task updated"})


@handle_dynamodb_errors
def reassign_task(
    event: dict[str, Any], event_id: str, team_id: str, task_id: str
) -> dict[str, Any]:
    """Reassign a task to somebody else. Leader only.

    A separate route from a general update because reassignment is the action the agent
    recommends and a leader approves, so it deserves its own audit action and its own
    notifications — both the new owner and the previous one need to know.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    missing = require_fields(ctx.body, "assigned_to")
    if missing:
        return missing

    new_assignee = validate_user_id(str(ctx.body["assigned_to"]))
    if not new_assignee:
        return error(ErrorCategory.VALIDATION_ERROR, "assigned_to is not a valid user id")

    sk = task_sk(event_id, team_id, task_id)
    existing = ctx.repo.get_item(ctx.organization_id, sk)
    if not existing:
        return error(ErrorCategory.NOT_FOUND, "Task not found")

    previous = str(existing.get("assigned_to", ""))
    if previous == new_assignee:
        return success({"task_id": task_id, "message": "That person is already the assignee."})

    now_iso = utc_now().isoformat()
    status = str(existing.get("status", ""))
    updates: dict[str, Any] = {
        "assigned_to": new_assignee,
        "assigned_to_name": sanitize_name(str(ctx.body.get("assigned_to_name", ""))),
        "updated_at": now_iso,
        "updated_by": ctx.user_id,
    }
    # Unowned work becomes owned work, so the status moves with the assignment rather than
    # leaving a task that has an assignee but still reads as backlog.
    if status in (TaskStatus.BACKLOG.value, TaskStatus.PENDING.value):
        updates["status"] = TaskStatus.ASSIGNED.value
        updates["GSI1SK"] = task_gsi1sk(
            TaskStatus.ASSIGNED.value, str(existing.get("created_at", now_iso))
        )
        updates["GSI2SK"] = task_gsi2sk(
            TaskStatus.ASSIGNED.value, str(existing.get("due_date", "")), task_id
        )

    ctx.repo.update_item(ctx.organization_id, sk, updates)

    create_audit_event(
        organization_id=ctx.organization_id,
        action="TASK_REASSIGNED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Task",
        resource_id=task_id,
        event_id=event_id,
        details={
            "team_id": team_id,
            "from": previous or "(unassigned)",
            "to": new_assignee,
            "reason": sanitize_text(str(ctx.body.get("reason", "")), 500),
        },
        policy_evaluated="ReassignTask",
    )

    _notify_assignee(
        ctx,
        event_id,
        task_id,
        new_assignee,
        str(existing.get("title", "")),
        str(existing.get("due_date", "")),
    )
    if previous and previous != ctx.user_id:
        from services.shared.models.notification import NotificationType
        from services.shared.notify import notify

        notify(
            ctx.organization_id,
            previous,
            NotificationType.TASK_ASSIGNED,
            f"Reassigned: {existing.get('title', 'a task')}",
            body="This task has been moved to another team member.",
            event_id=event_id,
            resource_type="Task",
            resource_id=task_id,
            actor_id=ctx.user_id,
        )

    return success(
        {
            "task_id": task_id,
            "assigned_to": new_assignee,
            "previous_assignee": previous,
            "message": "Task reassigned",
        }
    )


def _notify_assignee(
    ctx: Any, event_id: str, task_id: str, assignee: str, title: str, due_date: str
) -> None:
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
        actor_id=ctx.user_id,
    )


def find_overdue_tasks(
    organization_id: str, event_id: str, *, table_name: str | None = None
) -> list[dict[str, Any]]:
    """Open tasks whose deadline has passed.

    Shared with the agent's overdue-detection tool so the console and the agent identify the
    same set. Filtering excludes terminal statuses in DynamoDB rather than in Python so a
    long-running event does not pay to transfer its completed history on every check.
    """
    from services.api._common import MAIN_TABLE
    from services.shared.dynamodb import DynamoDBRepository

    repo = DynamoDBRepository(table_name or MAIN_TABLE)
    tasks = repo.query_gsi_all(
        "GSI1",
        event_gsi1pk(organization_id, event_id),
        sk_begins_with="TASK#",
        filter_expression=~Attr("status").is_in(list(TERMINAL_TASK_STATUSES)),
        max_items=2000,
    )
    now = utc_now()
    return [t for t in tasks if _decorate(t, now)["is_overdue"]]
