"""Incidents, their discussion threads, and their resolution.

Routes:
    GET  /events/{eventId}/incidents                               list incidents
    POST /events/{eventId}/incidents                               report an incident
    GET  /events/{eventId}/incidents/{incidentId}                  incident with discussion
    PUT  /events/{eventId}/incidents/{incidentId}                  update / acknowledge
    POST /events/{eventId}/incidents/{incidentId}/comments         add a comment
    GET  /events/{eventId}/incidents/{incidentId}/comments         read the discussion
    POST /events/{eventId}/incidents/{incidentId}/resolve          resolve         (leader)
    POST /events/{eventId}/incidents/{incidentId}/reopen           reopen          (leader)

Reporting is open to team members, and deliberately so: the person who notices the
projector has failed is the volunteer testing it, not the leader. Resolving is a leader
action, because deciding that a problem is actually gone is a judgement about the world
rather than a status change.

A discussion is a first-class part of an incident rather than a comment list bolted on.
Work and approvals can be created from a comment and link back to it, so the reasoning that
produced a decision stays reachable from the decision.
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
    incident_comment_gsi1sk,
    incident_comment_prefix,
    incident_comment_sk,
    incident_gsi1sk,
    incident_prefix,
    incident_sk,
)
from services.shared.models.base import ErrorCategory, utc_now
from services.shared.models.incident import (
    CLOSED_INCIDENT_STATUSES,
    IncidentCategory,
    IncidentSeverity,
    IncidentStatus,
)
from services.shared.principal import Role, authorize_scope
from services.shared.validation import sanitize_name, sanitize_text

logger = logging.getLogger(__name__)

INCIDENT_UPDATE_FIELDS = [
    "title",
    "description",
    "severity",
    "status",
    "category",
    "assigned_to",
    "assigned_to_name",
    "impact_analysis",
    "dependencies",
    "backup_options",
    "recommendation",
    "evidence",
    "team_id",
]

# Statuses a team member may set. They can pick work up and report progress; escalating or
# closing an incident is a leader's call about how serious it is and whether it is over.
TEAM_MEMBER_SETTABLE_STATUSES = frozenset(
    {
        IncidentStatus.ACKNOWLEDGED.value,
        IncidentStatus.ANALYZING.value,
    }
)


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    method = event.get("httpMethod", "GET")
    event_id = path_param(event, "eventId")
    incident_id = path_param(event, "incidentId")
    path = str(event.get("resource") or event.get("path") or "")

    if "/comments" in path:
        if method == "GET":
            return list_comments(event, event_id, incident_id)
        if method == "POST":
            return add_comment(event, event_id, incident_id)
        return error(ErrorCategory.VALIDATION_ERROR, "Unsupported comment operation")

    if path.endswith("/resolve") and method == "POST":
        return resolve_incident(event, event_id, incident_id)
    if path.endswith("/reopen") and method == "POST":
        return reopen_incident(event, event_id, incident_id)

    if method == "GET" and incident_id:
        return get_incident(event, event_id, incident_id)
    if method == "GET":
        return list_incidents(event, event_id)
    if method == "POST":
        return report_incident(event, event_id)
    if method == "PUT" and incident_id:
        return update_incident(event, event_id, incident_id)

    return error(ErrorCategory.VALIDATION_ERROR, "Unsupported operation")


@handle_dynamodb_errors
def list_incidents(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """List incidents, open first and most severe first within that.

    Ordering is by severity rather than recency because an incident list is read to find
    the worst thing happening, not the newest.
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

    # The incident prefix also matches comment records, which nest beneath it, so the
    # entity_type filter is what keeps a busy thread out of the incident list.
    items = ctx.repo.query_all(
        ctx.organization_id,
        incident_prefix(event_id),
        filter_expression=Attr("entity_type").eq("INCIDENT"),
        max_items=500,
    )

    if query_param(event, "open_only").lower() == "true":
        items = [i for i in items if str(i.get("status")) not in CLOSED_INCIDENT_STATUSES]

    severity_rank = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    items.sort(
        key=lambda i: (
            1 if str(i.get("status")) in CLOSED_INCIDENT_STATUSES else 0,
            severity_rank.get(str(i.get("severity")), 9),
            str(i.get("detected_at", "")),
        )
    )

    open_items = [i for i in items if str(i.get("status")) not in CLOSED_INCIDENT_STATUSES]
    return success(
        {
            "incidents": items,
            "count": len(items),
            "open_count": len(open_items),
            "critical_open_count": sum(
                1 for i in open_items if str(i.get("severity")) == "CRITICAL"
            ),
        }
    )


@handle_dynamodb_errors
def get_incident(event: dict[str, Any], event_id: str, incident_id: str) -> dict[str, Any]:
    """One incident with its full discussion."""
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    incident = ctx.repo.get_item(ctx.organization_id, incident_sk(event_id, incident_id))
    if not incident:
        return error(ErrorCategory.NOT_FOUND, "Incident not found")

    scope_denied = authorize_scope(ctx.principal, event_id=event_id)
    if scope_denied:
        return scope_denied

    comments = ctx.repo.query_all(
        ctx.organization_id, incident_comment_prefix(event_id, incident_id), max_items=500
    )
    comments.sort(key=lambda c: str(c.get("created_at", "")))

    return success({"incident": incident, "comments": comments, "comment_count": len(comments)})


@handle_dynamodb_errors
def report_incident(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Report an incident. Available to both roles.

    A team member may only file against a team they belong to. That is not a restriction on
    reporting — anyone can report anything about their own event — it just keeps the
    incident attributed to a team whose members will actually see it.
    """
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    if not event_id:
        return error(ErrorCategory.VALIDATION_ERROR, "eventId is required")

    missing = require_fields(ctx.body, "title")
    if missing:
        return missing

    team_id = str(ctx.body.get("team_id", "")).strip()
    scope_denied = authorize_scope(ctx.principal, event_id=event_id, team_id=team_id)
    if scope_denied:
        return scope_denied

    severity = str(ctx.body.get("severity", IncidentSeverity.MEDIUM.value)).upper()
    if severity not in {s.value for s in IncidentSeverity}:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            f"severity must be one of: {', '.join(s.value for s in IncidentSeverity)}",
        )

    category = str(ctx.body.get("category", IncidentCategory.OTHER.value)).upper()
    if category not in {c.value for c in IncidentCategory}:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            f"category must be one of: {', '.join(c.value for c in IncidentCategory)}",
        )

    incident_id = f"INC-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()

    ctx.repo.put_item(
        ctx.organization_id,
        incident_sk(event_id, incident_id),
        {
            "entity_type": "INCIDENT",
            "event_id": event_id,
            "incident_id": incident_id,
            "title": sanitize_name(str(ctx.body["title"])),
            "description": sanitize_text(str(ctx.body.get("description", ""))),
            "severity": severity,
            "status": IncidentStatus.REPORTED.value,
            "category": category,
            "team_id": team_id,
            "affected_resource_type": str(ctx.body.get("affected_resource_type", "")),
            "affected_resource_id": str(ctx.body.get("affected_resource_id", "")),
            "detected_at": now,
            "detected_by": ctx.actor_type,
            "reported_by": ctx.user_id,
            "reported_by_name": ctx.principal.display_name or ctx.principal.email,
            "reported_by_role": ctx.principal.role.value,
            "dependencies": [],
            "backup_options": [],
            "actions_taken": [],
            "comment_count": 0,
            "reopened_count": 0,
            "source_task_id": str(ctx.body.get("source_task_id", "")),
            "created_at": now,
            "updated_at": now,
            "created_by": ctx.user_id,
            "updated_by": ctx.user_id,
            "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
            "GSI1SK": incident_gsi1sk(IncidentStatus.REPORTED.value, now),
        },
    )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="INCIDENT_REPORTED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Incident",
        resource_id=incident_id,
        event_id=event_id,
        details={"severity": severity, "category": category, "team_id": team_id},
    )

    _notify_leads_of_incident(ctx, event_id, incident_id, str(ctx.body["title"]), severity)

    return success(
        {
            "incident_id": incident_id,
            "status": IncidentStatus.REPORTED.value,
            "message": "Incident reported. A leader has been notified.",
        },
        status_code=201,
    )


@handle_dynamodb_errors
def update_incident(event: dict[str, Any], event_id: str, incident_id: str) -> dict[str, Any]:
    """Update an incident.

    A team member may take ownership and record analysis on an incident in their scope, but
    cannot change severity or drive the status to a terminal state: how bad a problem is and
    whether it is finished are the two judgements a leader needs to keep.
    """
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    sk = incident_sk(event_id, incident_id)
    existing = ctx.repo.get_item(ctx.organization_id, sk)
    if not existing:
        return error(ErrorCategory.NOT_FOUND, "Incident not found")

    scope_denied = authorize_scope(ctx.principal, event_id=event_id)
    if scope_denied:
        return scope_denied

    updates = pick(ctx.body, INCIDENT_UPDATE_FIELDS)
    if not updates:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            f"Provide at least one field to update: {', '.join(INCIDENT_UPDATE_FIELDS)}",
        )

    if not ctx.principal.is_leader:
        if "severity" in updates:
            return error(
                ErrorCategory.FORBIDDEN,
                "Only a community leader can change an incident's severity.",
            )
        new_status = str(updates.get("status", "")).upper()
        if new_status and new_status not in TEAM_MEMBER_SETTABLE_STATUSES:
            return error(
                ErrorCategory.FORBIDDEN,
                f"You can move this incident to "
                f"{' or '.join(sorted(TEAM_MEMBER_SETTABLE_STATUSES))}. "
                "Resolving, closing or escalating is a leader action.",
            )

    if "status" in updates:
        status = str(updates["status"]).upper()
        if status not in {s.value for s in IncidentStatus}:
            return error(
                ErrorCategory.VALIDATION_ERROR,
                f"status must be one of: {', '.join(s.value for s in IncidentStatus)}",
            )
        updates["status"] = status
        # The status is embedded in the index sort key, so a transition has to rewrite it
        # or status-scoped queries keep reporting the old value.
        updates["GSI1SK"] = incident_gsi1sk(
            status, str(existing.get("detected_at", utc_now().isoformat()))
        )
        if status == IncidentStatus.ACKNOWLEDGED.value and not existing.get("acknowledged_at"):
            updates["acknowledged_at"] = utc_now().isoformat()
            updates["acknowledged_by"] = ctx.user_id
        if status == IncidentStatus.ESCALATED.value:
            updates["escalated_at"] = utc_now().isoformat()

    if "severity" in updates:
        severity = str(updates["severity"]).upper()
        if severity not in {s.value for s in IncidentSeverity}:
            return error(ErrorCategory.VALIDATION_ERROR, "Unrecognised severity")
        updates["severity"] = severity

    updates["updated_at"] = utc_now().isoformat()
    updates["updated_by"] = ctx.user_id

    ctx.repo.update_item(ctx.organization_id, sk, updates)

    create_audit_event(
        organization_id=ctx.organization_id,
        action="INCIDENT_UPDATED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Incident",
        resource_id=incident_id,
        event_id=event_id,
        details={
            "updated_fields": sorted(k for k in updates if not k.startswith("GSI")),
            "status": updates.get("status", existing.get("status")),
        },
    )
    return success({"incident_id": incident_id, "message": "Incident updated"})


@handle_dynamodb_errors
def list_comments(event: dict[str, Any], event_id: str, incident_id: str) -> dict[str, Any]:
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    scope_denied = authorize_scope(ctx.principal, event_id=event_id)
    if scope_denied:
        return scope_denied

    comments = ctx.repo.query_all(
        ctx.organization_id, incident_comment_prefix(event_id, incident_id), max_items=500
    )
    comments.sort(key=lambda c: str(c.get("created_at", "")))
    return success({"comments": comments, "count": len(comments)})


@handle_dynamodb_errors
def add_comment(event: dict[str, Any], event_id: str, incident_id: str) -> dict[str, Any]:
    """Add a message to an incident's discussion.

    Optionally creates a task from the comment in the same call. That linkage is the point
    of having a discussion at all: "the technical team must test the backup before 5pm"
    should become tracked work without anybody re-typing it, and the resulting task keeps a
    reference to the comment that produced it.
    """
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    missing = require_fields(ctx.body, "body")
    if missing:
        return missing

    incident = ctx.repo.get_item(ctx.organization_id, incident_sk(event_id, incident_id))
    if not incident:
        return error(ErrorCategory.NOT_FOUND, "Incident not found")

    scope_denied = authorize_scope(ctx.principal, event_id=event_id)
    if scope_denied:
        return scope_denied

    comment_id = f"CMT-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()

    parent_id = str(ctx.body.get("parent_comment_id", "")).strip() or None
    if (
        parent_id
        and ctx.repo.get_item(
            ctx.organization_id, incident_comment_sk(event_id, incident_id, parent_id)
        )
        is None
    ):
        return error(ErrorCategory.NOT_FOUND, "The comment being replied to does not exist")

    created_task_id: str | None = None
    if ctx.body.get("create_task"):
        created_task_id = _create_task_from_comment(
            ctx, event_id, incident_id, comment_id, ctx.body
        )
        if isinstance(created_task_id, dict):
            return created_task_id  # an error response

    ctx.repo.put_item(
        ctx.organization_id,
        incident_comment_sk(event_id, incident_id, comment_id),
        {
            "entity_type": "INCIDENT_COMMENT",
            "event_id": event_id,
            "incident_id": incident_id,
            "comment_id": comment_id,
            "body": sanitize_text(str(ctx.body["body"]), 5000),
            "author_id": ctx.user_id,
            "author_name": ctx.principal.display_name or ctx.principal.email or ctx.user_id,
            "author_type": ctx.actor_type,
            "author_role": ctx.principal.role.value,
            "team_id": str(ctx.body.get("team_id", "")),
            "parent_comment_id": parent_id,
            "attachment_document_id": str(ctx.body.get("attachment_document_id", "")) or None,
            "created_task_id": created_task_id,
            "created_approval_id": None,
            "created_at": now,
            "updated_at": now,
            "created_by": ctx.user_id,
            "updated_by": ctx.user_id,
            "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
            "GSI1SK": incident_comment_gsi1sk(incident_id, now),
        },
    )

    # An atomic ADD rather than a read-then-write: several people commenting at once on a
    # live incident is the normal case, and a lost increment would understate the thread.
    ctx.repo.atomic_update(
        ctx.organization_id,
        incident_sk(event_id, incident_id),
        adds={"comment_count": 1},
        sets={"updated_at": now},
    )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="INCIDENT_COMMENT_ADDED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="IncidentComment",
        resource_id=comment_id,
        event_id=event_id,
        details={"incident_id": incident_id, "created_task_id": created_task_id},
    )

    _notify_thread_participants(ctx, event_id, incident_id, incident)

    return success(
        {
            "comment_id": comment_id,
            "created_task_id": created_task_id,
            "message": "Comment added",
        },
        status_code=201,
    )


def _create_task_from_comment(
    ctx: Any, event_id: str, incident_id: str, comment_id: str, body: dict[str, Any]
) -> Any:
    """Create a task from a discussion comment, linked in both directions."""
    team_id = str(body.get("task_team_id", "")).strip()
    title = sanitize_name(str(body.get("task_title", "")))
    if not team_id or not title:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            "create_task also needs task_team_id and task_title.",
        )

    scope_denied = authorize_scope(ctx.principal, event_id=event_id, team_id=team_id)
    if scope_denied:
        return scope_denied

    from services.shared.keys import task_gsi2pk, task_gsi2sk, task_sk

    task_id = f"TSK-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()
    due_date = str(body.get("task_due_date", ""))
    status = "ASSIGNED" if body.get("task_assigned_to") else "BACKLOG"

    ctx.repo.put_item(
        ctx.organization_id,
        task_sk(event_id, team_id, task_id),
        {
            "entity_type": "TASK",
            "event_id": event_id,
            "team_id": team_id,
            "task_id": task_id,
            "title": title,
            "description": sanitize_text(str(body.get("task_description", ""))),
            "status": status,
            "priority": str(body.get("task_priority", "HIGH")).upper(),
            "risk": "NONE",
            "assigned_to": str(body.get("task_assigned_to", "")),
            "assigned_to_name": str(body.get("task_assigned_to_name", "")),
            "due_date": due_date,
            "depends_on": [],
            "blocks": [],
            "escalation_level": 0,
            "estimated_effort_hours": 0,
            # Provenance, so the task explains where it came from.
            "source_comment_id": comment_id,
            "source_incident_id": incident_id,
            "created_at": now,
            "updated_at": now,
            "created_by": ctx.user_id,
            "updated_by": ctx.user_id,
            "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
            "GSI1SK": f"TASK#{status}#{now}",
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
        details={
            "team_id": team_id,
            "title": title,
            "from_incident": incident_id,
            "from_comment": comment_id,
        },
        policy_evaluated="CreateInternalTask",
    )
    return task_id


@handle_dynamodb_errors
def resolve_incident(event: dict[str, Any], event_id: str, incident_id: str) -> dict[str, Any]:
    """Resolve an incident. Leader only.

    A resolution summary is required. An incident closed with no explanation teaches nobody
    anything, and post-event review is most of the value of having recorded it.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    missing = require_fields(ctx.body, "resolution_summary")
    if missing:
        return missing

    sk = incident_sk(event_id, incident_id)
    existing = ctx.repo.get_item(ctx.organization_id, sk)
    if not existing:
        return error(ErrorCategory.NOT_FOUND, "Incident not found")
    if str(existing.get("status")) in CLOSED_INCIDENT_STATUSES:
        return error(
            ErrorCategory.CONFLICT,
            f"This incident is already {str(existing.get('status')).lower()}.",
        )

    now = utc_now().isoformat()
    actions = [sanitize_name(str(a)) for a in (ctx.body.get("actions_taken") or [])][:20]

    ctx.repo.update_item(
        ctx.organization_id,
        sk,
        {
            "status": IncidentStatus.RESOLVED.value,
            "resolution_summary": sanitize_text(str(ctx.body["resolution_summary"]), 2000),
            "root_cause": sanitize_text(str(ctx.body.get("root_cause", "")), 2000),
            "actions_taken": actions,
            "resolved_at": now,
            "resolved_by": ctx.user_id,
            "updated_at": now,
            "updated_by": ctx.user_id,
            "GSI1SK": incident_gsi1sk(
                IncidentStatus.RESOLVED.value, str(existing.get("detected_at", now))
            ),
        },
    )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="INCIDENT_RESOLVED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Incident",
        resource_id=incident_id,
        event_id=event_id,
        details={
            "severity": str(existing.get("severity", "")),
            "root_cause": sanitize_text(str(ctx.body.get("root_cause", "")), 500),
            "actions_taken_count": len(actions),
        },
        policy_evaluated="ResolveIncident",
    )

    # Resolving removes a health signal, so the cached band is refreshed rather than left
    # showing a problem the leader has just dealt with.
    _refresh_health(ctx, event_id)

    reporter = str(existing.get("reported_by", ""))
    if reporter and reporter != ctx.user_id:
        from services.shared.models.notification import NotificationType
        from services.shared.notify import notify

        notify(
            ctx.organization_id,
            reporter,
            NotificationType.INCIDENT_UPDATED,
            f"Resolved: {existing.get('title', 'your incident')}",
            body=sanitize_text(str(ctx.body["resolution_summary"]), 500),
            event_id=event_id,
            resource_type="Incident",
            resource_id=incident_id,
            actor_id=ctx.user_id,
        )

    return success(
        {
            "incident_id": incident_id,
            "status": IncidentStatus.RESOLVED.value,
            "message": "Incident resolved",
        }
    )


@handle_dynamodb_errors
def reopen_incident(event: dict[str, Any], event_id: str, incident_id: str) -> dict[str, Any]:
    """Reopen a resolved incident.

    The reopen count is kept because an incident reopened three times is a different and
    more interesting problem than three separate incidents, and collapsing it into a fresh
    report would lose that.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    sk = incident_sk(event_id, incident_id)
    existing = ctx.repo.get_item(ctx.organization_id, sk)
    if not existing:
        return error(ErrorCategory.NOT_FOUND, "Incident not found")
    if str(existing.get("status")) not in CLOSED_INCIDENT_STATUSES:
        return error(
            ErrorCategory.CONFLICT,
            "This incident is still open, so there is nothing to reopen.",
        )

    now = utc_now().isoformat()
    ctx.repo.atomic_update(
        ctx.organization_id,
        sk,
        adds={"reopened_count": 1},
        sets={
            "status": IncidentStatus.REOPENED.value,
            "resolved_at": None,
            "updated_at": now,
            "updated_by": ctx.user_id,
            "GSI1SK": incident_gsi1sk(
                IncidentStatus.REOPENED.value, str(existing.get("detected_at", now))
            ),
        },
    )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="INCIDENT_REOPENED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Incident",
        resource_id=incident_id,
        event_id=event_id,
        details={"reason": sanitize_text(str(ctx.body.get("reason", "")), 500)},
    )
    _refresh_health(ctx, event_id)
    return success(
        {
            "incident_id": incident_id,
            "status": IncidentStatus.REOPENED.value,
            "message": "Incident reopened",
        }
    )


def _notify_leads_of_incident(
    ctx: Any, event_id: str, incident_id: str, title: str, severity: str
) -> None:
    from services.shared.keys import team_prefix
    from services.shared.models.notification import NotificationSeverity, NotificationType
    from services.shared.notify import notify_many

    teams = ctx.repo.query_all(
        ctx.organization_id,
        team_prefix(event_id),
        filter_expression=Attr("entity_type").eq("TEAM"),
    )
    lead_ids = [str(t.get("lead_user_id", "")) for t in teams if t.get("lead_user_id")]
    notify_many(
        ctx.organization_id,
        lead_ids,
        NotificationType.INCIDENT_REPORTED,
        f"{severity}: {title}",
        body=f"Reported by {ctx.principal.display_name or ctx.user_id}",
        event_id=event_id,
        resource_type="Incident",
        resource_id=incident_id,
        severity=(
            NotificationSeverity.CRITICAL
            if severity in ("CRITICAL", "HIGH")
            else NotificationSeverity.WARNING
        ),
        actor_id=ctx.user_id,
    )


def _notify_thread_participants(
    ctx: Any, event_id: str, incident_id: str, incident: dict[str, Any]
) -> None:
    """Tell the reporter and assignee that the discussion moved.

    Only those two, and never the commenter themselves. Notifying everyone who ever posted
    would make a busy thread unusable, and the people who need to act are the one who
    raised it and the one who owns it.
    """
    from services.shared.models.notification import NotificationType
    from services.shared.notify import notify_many

    recipients = [
        str(incident.get("reported_by", "")),
        str(incident.get("assigned_to", "")),
    ]
    recipients = [r for r in recipients if r and r != ctx.user_id]
    if not recipients:
        return

    notify_many(
        ctx.organization_id,
        recipients,
        NotificationType.INCIDENT_UPDATED,
        f"New comment on {incident.get('title', 'an incident')}",
        body=f"{ctx.principal.display_name or ctx.user_id} commented.",
        event_id=event_id,
        resource_type="Incident",
        resource_id=incident_id,
        actor_id=ctx.user_id,
    )


def _refresh_health(ctx: Any, event_id: str) -> None:
    """Recompute the cached event health. Never fails the caller."""
    try:
        from services.shared.aggregate import load_event_snapshot
        from services.shared.health import compute_health
        from services.shared.keys import event_sk

        snapshot = load_event_snapshot(
            ctx.organization_id, event_id, table_name=ctx.repo.table_name
        )
        result = compute_health(snapshot)
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
    except Exception:  # noqa: BLE001 - a stale band must not fail a resolution
        logger.warning("Could not refresh event health", exc_info=True)
