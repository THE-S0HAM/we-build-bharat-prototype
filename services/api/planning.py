"""Operational plan generation.

When a leader says "prepare this event", this produces the structure the event will be run
through: the eight standard teams, a starting checklist per team, and a list of the approvals
the plan will eventually need.

Deliberately deterministic
--------------------------
The plan is a template rendered against the event's dates, not something a model invents.
Two reasons. First, the tasks needed to run a community event are well known — the value is
in having them created, assigned and deadline-anchored, not in rediscovering them. Second, a
generated plan that varies between runs cannot be tested, and a leader who regenerates a
plan and gets a different one loses confidence in all of it.

The agent's contribution is what happens *after*: noticing that a deadline is slipping,
comparing workloads, drafting the follow-up. That is the part where reasoning over changing
state is genuinely needed.

Nothing here is consequential
-----------------------------
Every record written is a team or an internal task, both LOW risk under the policy catalogue.
The approvals the plan implies are returned as a list for the leader to read, not raised.
Generating a plan should never cost money or contact anybody.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

from services.shared.aggregate import parse_timestamp
from services.shared.dynamodb import DynamoDBRepository
from services.shared.keys import (
    event_gsi1pk,
    task_gsi1sk,
    task_gsi2pk,
    task_gsi2sk,
    task_sk,
)
from services.shared.models.base import utc_now
from services.shared.models.team import TaskStatus

logger = logging.getLogger(__name__)

# The checklist, per team. ``days_before`` anchors each deadline to the event start, so the
# plan is ordered by when work actually has to happen rather than by when it was created.
# Numbers are the lead times community organisers actually work to: marketing runs early,
# venue and technical checks land the day before.
PLAN_TEMPLATE: dict[str, list[tuple[str, int, str, int]]] = {
    "TEAM-marketing": [
        ("Publish event announcement", 21, "HIGH", 3),
        ("Prepare speaker announcement cards", 14, "MEDIUM", 4),
        ("Schedule registration reminder sequence", 10, "MEDIUM", 2),
        ("Publish final agenda", 3, "HIGH", 2),
    ],
    "TEAM-registration": [
        ("Open registration and verify the form", 21, "CRITICAL", 2),
        ("Reconcile payment records against registrations", 7, "HIGH", 4),
        ("Generate tickets for confirmed registrations", 3, "HIGH", 3),
        ("Prepare check-in desk kits", 1, "CRITICAL", 3),
    ],
    "TEAM-speakers": [
        ("Send speaker invitations", 30, "CRITICAL", 4),
        ("Confirm speaker availability and topics", 21, "CRITICAL", 5),
        ("Collect travel and accommodation requirements", 14, "HIGH", 3),
        ("Collect presentations and AV requirements", 5, "HIGH", 4),
        ("Share final schedule with speakers", 2, "MEDIUM", 1),
    ],
    "TEAM-venue": [
        ("Confirm venue booking and capacity", 21, "CRITICAL", 3),
        ("Verify seating layout against expected attendance", 7, "HIGH", 2),
        ("Confirm power backup and internet", 3, "CRITICAL", 2),
        ("Install signage and wayfinding", 1, "MEDIUM", 3),
    ],
    "TEAM-sponsorship": [
        ("Confirm sponsor commitments", 21, "HIGH", 4),
        ("Collect sponsor logos and branding assets", 14, "MEDIUM", 2),
        ("Confirm booth requirements and placement", 5, "MEDIUM", 3),
    ],
    "TEAM-tech": [
        ("Test microphones and sound system", 2, "CRITICAL", 3),
        ("Test projector and screen", 2, "CRITICAL", 2),
        ("Configure and rehearse livestream", 2, "HIGH", 4),
        ("Prepare backup laptop and adapters", 1, "HIGH", 2),
    ],
    "TEAM-volunteers": [
        ("Recruit and confirm volunteers", 14, "HIGH", 5),
        ("Assign registration desk shifts", 3, "HIGH", 2),
        ("Prepare volunteer badges and briefing pack", 2, "MEDIUM", 3),
        ("Run the volunteer briefing", 1, "HIGH", 2),
    ],
    "TEAM-attendee-ops": [
        ("Collect dietary requirements from attendees", 7, "HIGH", 3),
        ("Compile the accommodation list", 7, "MEDIUM", 2),
        ("Confirm catering headcount with the vendor", 2, "CRITICAL", 2),
        ("Coordinate attendee arrival logistics", 1, "MEDIUM", 3),
    ],
}

# Dependencies between plan tasks, expressed by title because ids do not exist yet. Only the
# genuine ones: catering cannot be confirmed before the final headcount is known, and tickets
# cannot be generated before payments reconcile.
PLAN_DEPENDENCIES: dict[str, str] = {
    "Generate tickets for confirmed registrations": (
        "Reconcile payment records against registrations"
    ),
    "Confirm catering headcount with the vendor": ("Collect dietary requirements from attendees"),
    "Prepare check-in desk kits": "Generate tickets for confirmed registrations",
    "Publish final agenda": "Confirm speaker availability and topics",
    "Share final schedule with speakers": "Publish final agenda",
    "Install signage and wayfinding": "Verify seating layout against expected attendance",
}

# The approvals a plan of this shape will eventually need. Listed for the leader, not raised:
# an event that has just been planned has no speaker who needs a hotel yet.
ANTICIPATED_APPROVALS: list[dict[str, str]] = [
    {
        "requested_action": "AccommodationCommitment",
        "title": "Speaker accommodation booking",
        "reason": "Booking a hotel is a financial commitment on the organization's behalf.",
    },
    {
        "requested_action": "FinancialCommitment",
        "title": "Venue and catering deposits",
        "reason": "Deposits are irreversible once paid.",
    },
    {
        "requested_action": "ConfirmSpeaker",
        "title": "Speaker confirmations",
        "reason": "Confirming a speaker is a public commitment to them and to attendees.",
    },
    {
        "requested_action": "SendExternalSpeakerMessage",
        "title": "Outbound speaker communication",
        "reason": "Messages leaving the organization are reviewed before they are sent.",
    },
]


def _deadline(start: datetime | None, days_before: int, now: datetime) -> str:
    """Compute a task deadline from the event start date.

    Falls back to spacing deadlines forward from today when the event has no start date yet,
    which is common for a freshly created draft. A plan with no dates at all would leave every
    task looking equally urgent.

    Deadlines are clamped to at least an hour from now: an event starting tomorrow would
    otherwise be planned with three-week lead times already in the past, and the new plan
    would be born entirely overdue.
    """
    if start is None:
        target = now + timedelta(days=max(1, 30 - days_before))
    else:
        target = start - timedelta(days=days_before)
    if target < now + timedelta(hours=1):
        target = now + timedelta(hours=1)
    return target.isoformat()


def generate_operational_plan(
    organization_id: str,
    event_id: str,
    event_record: dict[str, Any],
    *,
    actor_id: str,
    table_name: str,
) -> dict[str, Any]:
    """Create the teams and starting tasks for an event.

    Idempotent by intent: teams already present are left alone, and a team that already has
    tasks is skipped rather than having the checklist appended a second time. Re-running
    ``prepare`` on a half-planned event fills the gaps instead of duplicating work.
    """
    from boto3.dynamodb.conditions import Attr

    from services.api.teams_handler import DEFAULT_TEAMS, create_default_teams
    from services.shared.keys import task_prefix

    repo = DynamoDBRepository(table_name)
    now = utc_now()
    now_iso = now.isoformat()
    start = parse_timestamp(event_record.get("start_date"))

    teams_created = create_default_teams(
        organization_id, event_id, actor_id=actor_id, table_name=table_name
    )

    # Titles already present, so re-running does not duplicate the checklist. Compared by
    # title because the plan template has no stable task ids.
    existing_titles: dict[str, set[str]] = {}
    for spec in DEFAULT_TEAMS:
        team_id = spec["team_id"]
        existing_titles[team_id] = {
            str(t.get("title", ""))
            for t in repo.query_all(
                organization_id,
                task_prefix(event_id, team_id),
                filter_expression=Attr("entity_type").eq("TASK"),
            )
        }

    writes: list[tuple[str, dict[str, Any]]] = []
    plan_tasks: list[dict[str, Any]] = []
    # Two passes: ids have to exist before dependencies can reference them.
    title_to_id: dict[str, str] = {}

    for team_id, checklist in PLAN_TEMPLATE.items():
        for title, days_before, priority, effort in checklist:
            if title in existing_titles.get(team_id, set()):
                continue
            task_id = f"TSK-{uuid.uuid4().hex[:8]}"
            title_to_id[title] = task_id
            plan_tasks.append(
                {
                    "task_id": task_id,
                    "team_id": team_id,
                    "title": title,
                    "priority": priority,
                    "due_date": _deadline(start, days_before, now),
                    "estimated_effort_hours": effort,
                }
            )

    for task in plan_tasks:
        dependency_title = PLAN_DEPENDENCIES.get(str(task["title"]))
        depends_on = (
            [title_to_id[dependency_title]]
            if dependency_title and dependency_title in title_to_id
            else []
        )
        blocks = [
            title_to_id[blocked_title]
            for blocked_title, prerequisite in PLAN_DEPENDENCIES.items()
            if prerequisite == task["title"] and blocked_title in title_to_id
        ]

        status = TaskStatus.BACKLOG.value
        writes.append(
            (
                task_sk(event_id, str(task["team_id"]), str(task["task_id"])),
                {
                    "entity_type": "TASK",
                    "event_id": event_id,
                    "team_id": task["team_id"],
                    "task_id": task["task_id"],
                    "title": task["title"],
                    "description": "",
                    "status": status,
                    "priority": task["priority"],
                    "risk": "NONE",
                    "assigned_to": "",
                    "assigned_to_name": "",
                    "due_date": task["due_date"],
                    "depends_on": depends_on,
                    "blocks": blocks,
                    "escalation_level": 0,
                    "estimated_effort_hours": task["estimated_effort_hours"],
                    "blocked_reason": "",
                    "notes": "Created by the CommunityOps operational plan.",
                    "created_at": now_iso,
                    "updated_at": now_iso,
                    "created_by": actor_id,
                    "updated_by": actor_id,
                    "GSI1PK": event_gsi1pk(organization_id, event_id),
                    "GSI1SK": task_gsi1sk(status, now_iso),
                    "GSI2PK": task_gsi2pk(organization_id, event_id),
                    "GSI2SK": task_gsi2sk(status, str(task["due_date"]), str(task["task_id"])),
                },
            )
        )
        task["depends_on"] = depends_on

    if writes:
        repo.batch_put(organization_id, writes)

    logger.info(
        "Generated operational plan",
        extra={
            "organization_id": organization_id,
            "event_id": event_id,
            "teams_created": len(teams_created),
            "tasks_created": len(writes),
        },
    )

    checklist_by_team = [
        {
            "team_id": spec["team_id"],
            "team_name": spec["name"],
            "responsibilities": spec["responsibilities"],
            "tasks": [t for t in plan_tasks if t["team_id"] == spec["team_id"]],
        }
        for spec in DEFAULT_TEAMS
    ]

    return {
        "event_id": event_id,
        "event_name": event_record.get("name", ""),
        "generated_at": now_iso,
        "teams_created": teams_created,
        "tasks_created": len(writes),
        "plan": checklist_by_team,
        "anticipated_approvals": ANTICIPATED_APPROVALS,
        "message": (
            f"Created {len(teams_created)} teams and {len(writes)} tasks. "
            "Review the plan, assign owners, then set the event live. "
            "No approvals were raised — the listed ones will be requested when they are "
            "actually needed."
        ),
        "next_steps": [
            "Assign a lead to each team",
            "Add team members and assign the critical tasks",
            "Set the event budget and allocate it across categories",
            "Move the event from DRAFT to PUBLISHED when you are ready",
        ],
    }
