"""Teams and team membership.

Routes:
    GET    /events/{eventId}/teams                          list teams with workload
    POST   /events/{eventId}/teams                          create a team          (leader)
    GET    /events/{eventId}/teams/{teamId}                  one team in detail
    PUT    /events/{eventId}/teams/{teamId}                  update a team          (leader)
    GET    /events/{eventId}/teams/{teamId}/members          list members
    POST   /events/{eventId}/teams/{teamId}/members          add a member           (leader)
    DELETE /events/{eventId}/teams/{teamId}/members/{userId}  remove a member       (leader)

Team composition is leader-controlled. A team member can read their teams — coordinating
with teammates requires seeing who they are and what they hold — but cannot change who is
on one, because membership is what authorization is derived from and a role that can widen
its own scope is not a boundary.
"""

from __future__ import annotations

import logging
from typing import Any

from boto3.dynamodb.conditions import Attr

from services.api._common import (
    MAIN_TABLE,
    begin_request,
    handle_dynamodb_errors,
    list_response,
    path_param,
    pick,
    require_fields,
)
from services.shared.api_response import error, success
from services.shared.audit import create_audit_event
from services.shared.keys import (
    event_gsi1pk,
    team_member_gsi1sk,
    team_member_gsi2sk,
    team_member_prefix,
    team_member_sk,
    team_prefix,
    team_sk,
    user_gsi2pk,
)
from services.shared.models.base import ErrorCategory, utc_now
from services.shared.models.team import TeamRole
from services.shared.principal import Role, authorize_scope
from services.shared.validation import sanitize_name, sanitize_text, validate_user_id

logger = logging.getLogger(__name__)

# The eight operational teams a community event is organised around. Used by the
# "prepare this event" plan generator so a new event starts with a real structure rather
# than an empty page.
DEFAULT_TEAMS: list[dict[str, Any]] = [
    {
        "team_id": "TEAM-marketing",
        "name": "Marketing",
        "responsibilities": ["Announcements", "Social media", "Speaker cards", "Reminders"],
    },
    {
        "team_id": "TEAM-registration",
        "name": "Registration",
        "responsibilities": ["Registration list", "Payment reconciliation", "Ticketing"],
    },
    {
        "team_id": "TEAM-speakers",
        "name": "Speaker Management",
        "responsibilities": ["Outreach", "Confirmations", "Travel", "Presentations"],
    },
    {
        "team_id": "TEAM-venue",
        "name": "Venue & Logistics",
        "responsibilities": ["Seating", "Signage", "Power", "Access"],
    },
    {
        "team_id": "TEAM-sponsorship",
        "name": "Sponsorship",
        "responsibilities": ["Sponsor deliverables", "Booths", "Logos"],
    },
    {
        "team_id": "TEAM-tech",
        "name": "Technical",
        "responsibilities": ["AV", "Livestream", "Microphones", "Backup equipment"],
    },
    {
        "team_id": "TEAM-volunteers",
        "name": "Volunteer Coordination",
        "responsibilities": ["Rostering", "Briefing", "Badges", "Desk cover"],
    },
    {
        "team_id": "TEAM-attendee-ops",
        "name": "Attendee Experience",
        "responsibilities": ["Accommodation", "Dietary needs", "Arrival coordination"],
    },
]

TEAM_UPDATE_FIELDS = [
    "name",
    "description",
    "responsibilities",
    "lead_user_id",
    "lead_name",
    "is_active",
]


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    method = event.get("httpMethod", "GET")
    event_id = path_param(event, "eventId")
    team_id = path_param(event, "teamId")
    user_id = path_param(event, "userId")
    path = str(event.get("resource") or event.get("path") or "")
    is_members_route = "/members" in path

    if is_members_route:
        if method == "GET":
            return list_members(event, event_id, team_id)
        if method == "POST":
            return add_member(event, event_id, team_id)
        if method == "DELETE" and user_id:
            return remove_member(event, event_id, team_id, user_id)
        return error(ErrorCategory.VALIDATION_ERROR, "Unsupported member operation")

    if method == "GET" and team_id:
        return get_team(event, event_id, team_id)
    if method == "GET":
        return list_teams(event, event_id)
    if method == "POST":
        return create_team(event, event_id)
    if method == "PUT" and team_id:
        return update_team(event, event_id, team_id)

    return error(ErrorCategory.VALIDATION_ERROR, "Unsupported operation")


@handle_dynamodb_errors
def list_teams(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """List an event's teams with their derived workload.

    Built from a single event snapshot rather than a query per team. Eight teams would
    otherwise mean eight task queries to answer one screen, and the counts could disagree
    with the command centre's if the two computed them separately.
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

    from services.shared.aggregate import load_event_snapshot

    snapshot = load_event_snapshot(
        ctx.organization_id, event_id, table_name=ctx.repo.table_name, include_attendees=False
    )

    teams = [
        {
            "team_id": team.team_id,
            "event_id": event_id,
            "name": team.name,
            "lead_user_id": team.lead_user_id,
            "lead_name": team.lead_name,
            "member_count": team.member_count,
            "total_tasks": team.total_tasks,
            "open_tasks": team.open_tasks,
            "completed_tasks": team.completed_tasks,
            "overdue_tasks": team.overdue_tasks,
            "blocked_tasks": team.blocked_tasks,
            "in_progress_tasks": team.in_progress_tasks,
            "progress_percent": team.progress_percent,
            "workload_per_member": team.workload_per_member,
            "risk": team.risk,
        }
        # A team member sees only their own teams; a leader sees all of them.
        for team in snapshot.teams
        if ctx.principal.may_see_team(team.team_id)
    ]
    teams.sort(key=lambda t: t["name"])
    return list_response("teams", teams)


@handle_dynamodb_errors
def get_team(event: dict[str, Any], event_id: str, team_id: str) -> dict[str, Any]:
    """One team with its members and tasks."""
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    scope_denied = authorize_scope(ctx.principal, event_id=event_id, team_id=team_id)
    if scope_denied:
        return scope_denied

    team = ctx.repo.get_item(ctx.organization_id, team_sk(event_id, team_id))
    if not team:
        return error(ErrorCategory.NOT_FOUND, "Team not found")

    members = ctx.repo.query_all(ctx.organization_id, team_member_prefix(event_id, team_id))
    from services.shared.keys import task_prefix

    tasks = ctx.repo.query_all(ctx.organization_id, task_prefix(event_id, team_id))

    return success({"team": team, "members": members, "tasks": tasks})


@handle_dynamodb_errors
def create_team(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Create a team.

    The team id is derived from the name rather than randomly generated, because team ids
    appear in sort keys and in the console's URLs, and ``TEAM-venue`` is far easier to
    reason about in a DynamoDB item than ``TEAM-a3f9c1``. Collisions are rejected rather
    than suffixed, so two teams cannot end up with confusingly similar ids.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    if not event_id:
        return error(ErrorCategory.VALIDATION_ERROR, "eventId is required")
    missing = require_fields(ctx.body, "name")
    if missing:
        return missing

    name = sanitize_name(str(ctx.body["name"]))
    team_id = str(ctx.body.get("team_id") or "").strip() or _slug_team_id(name)

    from services.shared.validation import validate_team_id

    if not validate_team_id(team_id):
        return error(
            ErrorCategory.VALIDATION_ERROR,
            "team_id must look like TEAM-venue: the TEAM- prefix followed by letters, "
            "digits or hyphens.",
        )

    now = utc_now().isoformat()
    item = {
        "entity_type": "TEAM",
        "event_id": event_id,
        "team_id": team_id,
        "name": name,
        "description": sanitize_text(str(ctx.body.get("description", ""))),
        "responsibilities": [
            sanitize_name(str(r)) for r in (ctx.body.get("responsibilities") or [])
        ][:20],
        "lead_user_id": str(ctx.body.get("lead_user_id", "")),
        "lead_name": sanitize_name(str(ctx.body.get("lead_name", ""))),
        "member_count": 0,
        "is_active": True,
        "created_at": now,
        "updated_at": now,
        "created_by": ctx.user_id,
        "updated_by": ctx.user_id,
        "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
        "GSI1SK": f"TEAM#{team_id}",
    }

    created = ctx.repo.put_item_idempotent(ctx.organization_id, team_sk(event_id, team_id), item)
    if not created:
        return error(
            ErrorCategory.DUPLICATE,
            f"A team with id {team_id} already exists for this event.",
        )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="TEAM_CREATED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Team",
        resource_id=team_id,
        event_id=event_id,
        details={"name": name},
    )
    return success({"team_id": team_id, "message": "Team created"}, status_code=201)


def _slug_team_id(name: str) -> str:
    """Derive ``TEAM-venue-logistics`` from ``Venue & Logistics``."""
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in name)
    parts = [part for part in cleaned.split("-") if part]
    return "TEAM-" + "-".join(parts)[:34]


@handle_dynamodb_errors
def update_team(event: dict[str, Any], event_id: str, team_id: str) -> dict[str, Any]:
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    sk = team_sk(event_id, team_id)
    if ctx.repo.get_item(ctx.organization_id, sk) is None:
        return error(ErrorCategory.NOT_FOUND, "Team not found")

    updates = pick(ctx.body, TEAM_UPDATE_FIELDS)
    if not updates:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            f"Provide at least one field to update: {', '.join(TEAM_UPDATE_FIELDS)}",
        )
    if "name" in updates:
        updates["name"] = sanitize_name(str(updates["name"]))
    updates["updated_at"] = utc_now().isoformat()
    updates["updated_by"] = ctx.user_id

    ctx.repo.update_item(ctx.organization_id, sk, updates)
    create_audit_event(
        organization_id=ctx.organization_id,
        action="TEAM_UPDATED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Team",
        resource_id=team_id,
        event_id=event_id,
        details={"updated_fields": sorted(updates)},
    )
    return success({"team_id": team_id, "message": "Team updated"})


@handle_dynamodb_errors
def list_members(event: dict[str, Any], event_id: str, team_id: str) -> dict[str, Any]:
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    scope_denied = authorize_scope(ctx.principal, event_id=event_id, team_id=team_id)
    if scope_denied:
        return scope_denied

    members = ctx.repo.query_all(ctx.organization_id, team_member_prefix(event_id, team_id))
    members.sort(key=lambda m: (m.get("team_role") != "LEAD", str(m.get("display_name", ""))))
    return list_response("members", members)


@handle_dynamodb_errors
def add_member(event: dict[str, Any], event_id: str, team_id: str) -> dict[str, Any]:
    """Add somebody to a team.

    The team's ``member_count`` is incremented with an atomic ``ADD`` rather than a
    read-then-write, because two leaders adding members at once would otherwise each read
    the same count and one increment would be lost. The counter carries no cross-attribute
    invariant, so ``ADD`` is both correct and cheaper than the optimistic-concurrency
    approach the budget needs.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    missing = require_fields(ctx.body, "user_id", "display_name")
    if missing:
        return missing

    user_id = validate_user_id(str(ctx.body["user_id"]))
    if not user_id:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            "user_id contains characters that are not allowed in an identifier.",
        )

    if ctx.repo.get_item(ctx.organization_id, team_sk(event_id, team_id)) is None:
        return error(ErrorCategory.NOT_FOUND, "Team not found")

    team_role = str(ctx.body.get("team_role", TeamRole.MEMBER.value)).upper()
    if team_role not in {r.value for r in TeamRole}:
        return error(ErrorCategory.VALIDATION_ERROR, "team_role must be LEAD or MEMBER")

    now = utc_now().isoformat()
    item = {
        "entity_type": "TEAM_MEMBER",
        "event_id": event_id,
        "team_id": team_id,
        "user_id": user_id,
        "display_name": sanitize_name(str(ctx.body["display_name"])),
        "email": str(ctx.body.get("email", "")).strip().lower(),
        "team_role": team_role,
        "skills": [sanitize_name(str(s)) for s in (ctx.body.get("skills") or [])][:20],
        "is_active": True,
        "active_task_count": 0,
        "completed_task_count": 0,
        "created_at": now,
        "updated_at": now,
        "created_by": ctx.user_id,
        "updated_by": ctx.user_id,
        "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
        "GSI1SK": team_member_gsi1sk(team_id, user_id),
        # Indexed per user too, because resolving a principal's scope asks "which teams
        # does this person belong to", which the event-scoped GSI1 cannot answer.
        "GSI2PK": user_gsi2pk(ctx.organization_id, user_id),
        "GSI2SK": team_member_gsi2sk(event_id, team_id),
    }

    created = ctx.repo.put_item_idempotent(
        ctx.organization_id, team_member_sk(event_id, team_id, user_id), item
    )
    if not created:
        # Re-adding an existing member is treated as reactivation rather than an error:
        # the caller's intent is "this person is on this team", which is now true.
        ctx.repo.update_item(
            ctx.organization_id,
            team_member_sk(event_id, team_id, user_id),
            {
                "is_active": True,
                "team_role": team_role,
                "updated_at": now,
                "updated_by": ctx.user_id,
            },
        )
        return success(
            {
                "user_id": user_id,
                "team_id": team_id,
                "message": "Member was already on this team; membership reactivated.",
                "already_existed": True,
            }
        )

    ctx.repo.atomic_update(
        ctx.organization_id,
        team_sk(event_id, team_id),
        adds={"member_count": 1},
        sets={"updated_at": now},
    )

    if team_role == TeamRole.LEAD.value:
        ctx.repo.update_item(
            ctx.organization_id,
            team_sk(event_id, team_id),
            {
                "lead_user_id": user_id,
                "lead_name": item["display_name"],
                "updated_at": now,
                "updated_by": ctx.user_id,
            },
        )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="TEAM_MEMBER_ADDED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="TeamMember",
        resource_id=user_id,
        event_id=event_id,
        details={"team_id": team_id, "team_role": team_role},
    )

    from services.shared.models.notification import NotificationType
    from services.shared.notify import notify

    notify(
        ctx.organization_id,
        user_id,
        NotificationType.TASK_ASSIGNED,
        f"You joined {team_id.replace('TEAM-', '').replace('-', ' ').title()}",
        body="You have been added to this team for the event.",
        event_id=event_id,
        resource_type="Team",
        resource_id=team_id,
        actor_id=ctx.user_id,
    )

    return success(
        {"user_id": user_id, "team_id": team_id, "message": "Member added"}, status_code=201
    )


@handle_dynamodb_errors
def remove_member(
    event: dict[str, Any], event_id: str, team_id: str, user_id: str
) -> dict[str, Any]:
    """Remove somebody from a team.

    The membership record is deactivated rather than deleted. Tasks reference their
    assignee by id, so deleting the record would leave work attributed to a person the
    system can no longer name. Deactivation removes their access — ``resolve_principal``
    skips inactive memberships — while keeping the history readable.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    sk = team_member_sk(event_id, team_id, user_id)
    existing = ctx.repo.get_item(ctx.organization_id, sk)
    if existing is None:
        return error(ErrorCategory.NOT_FOUND, "This person is not a member of that team")
    if existing.get("is_active") is False:
        return success({"user_id": user_id, "message": "Membership was already inactive"})

    now = utc_now().isoformat()
    ctx.repo.update_item(
        ctx.organization_id,
        sk,
        {"is_active": False, "updated_at": now, "updated_by": ctx.user_id},
    )
    ctx.repo.atomic_update(
        ctx.organization_id,
        team_sk(event_id, team_id),
        adds={"member_count": -1},
        sets={"updated_at": now},
    )

    # Work assigned to somebody who has left the team would otherwise sit unnoticed, so
    # it is surfaced for reassignment rather than silently orphaned.
    from services.shared.keys import task_prefix

    orphaned = ctx.repo.query_all(
        ctx.organization_id,
        task_prefix(event_id, team_id),
        filter_expression=Attr("assigned_to").eq(user_id),
    )
    open_orphaned = [t for t in orphaned if str(t.get("status")) not in ("COMPLETED", "CANCELLED")]

    create_audit_event(
        organization_id=ctx.organization_id,
        action="TEAM_MEMBER_REMOVED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="TeamMember",
        resource_id=user_id,
        event_id=event_id,
        details={"team_id": team_id, "open_tasks_needing_reassignment": len(open_orphaned)},
    )

    return success(
        {
            "user_id": user_id,
            "team_id": team_id,
            "message": "Membership deactivated",
            "tasks_needing_reassignment": [
                {"task_id": t.get("task_id"), "title": t.get("title")} for t in open_orphaned
            ],
        }
    )


def create_default_teams(
    organization_id: str,
    event_id: str,
    *,
    actor_id: str,
    table_name: str | None = None,
) -> list[str]:
    """Create the eight standard operational teams for a new event.

    Used by the agent's event-preparation plan. Written as one batch because eight
    sequential writes for a single user action is needlessly slow, and the teams are
    idempotent by key so a partial batch can simply be re-run.
    """
    from services.shared.dynamodb import DynamoDBRepository

    repo = DynamoDBRepository(table_name or MAIN_TABLE)
    now = utc_now().isoformat()
    existing = {
        str(t.get("team_id"))
        for t in repo.query_all(
            organization_id, team_prefix(event_id), filter_expression=Attr("entity_type").eq("TEAM")
        )
    }

    to_write: list[tuple[str, dict[str, Any]]] = []
    created: list[str] = []
    for spec in DEFAULT_TEAMS:
        if spec["team_id"] in existing:
            continue
        created.append(spec["team_id"])
        to_write.append(
            (
                team_sk(event_id, spec["team_id"]),
                {
                    "entity_type": "TEAM",
                    "event_id": event_id,
                    "team_id": spec["team_id"],
                    "name": spec["name"],
                    "description": "",
                    "responsibilities": spec["responsibilities"],
                    "lead_user_id": "",
                    "lead_name": "",
                    "member_count": 0,
                    "is_active": True,
                    "created_at": now,
                    "updated_at": now,
                    "created_by": actor_id,
                    "updated_by": actor_id,
                    "GSI1PK": event_gsi1pk(organization_id, event_id),
                    "GSI1SK": f"TEAM#{spec['team_id']}",
                },
            )
        )

    if to_write:
        repo.batch_put(organization_id, to_write)
    return created
