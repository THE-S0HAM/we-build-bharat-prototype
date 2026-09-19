"""One read of an event's operational state, shared by everything that needs it.

The command centre previously issued a query per entity kind per event: list events, then
for each active event query approvals, then incidents, then tasks. With the event health
engine, the operations brief, the attention list and a dozen agent read tools all wanting
overlapping slices of the same data, that pattern multiplies badly — the same tasks get
fetched four times to answer one question.

So state is loaded once into an :class:`EventSnapshot` and every count, band, risk and
summary is derived from it in memory. One query per entity family, no fan-out per
consumer, and — more importantly — every consumer sees *the same* numbers. When the agent
says "three overdue tasks" and the dashboard says three, it is because both read the same
snapshot rather than because two independent count implementations happened to agree.

Derived, not stored
-------------------
Overdue-ness is computed here against a single ``now`` captured when the snapshot is
built. Storing it would mean a task became stale the instant its deadline passed, and
computing it per consumer would mean two consumers disagreeing across a second boundary.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from boto3.dynamodb.conditions import Attr

from services.shared.dynamodb import DynamoDBRepository
from services.shared.keys import (
    GSI1_INDEX,
    attendee_prefix,
    budget_allocation_prefix,
    budget_sk,
    checkin_prefix,
    event_gsi1pk,
    event_sk,
    registration_prefix,
    team_prefix,
)
from services.shared.models.base import utc_now
from services.shared.models.incident import CLOSED_INCIDENT_STATUSES
from services.shared.models.team import TERMINAL_TASK_STATUSES
from services.shared.validation import coerce_int

logger = logging.getLogger(__name__)

MAIN_TABLE = os.environ.get("MAIN_TABLE", "CommunityOps-Main-dev")

# A speaker who was contacted and has not replied within this window needs a follow-up.
SPEAKER_SILENCE_HOURS = 72

# An approval nobody has decided within this window is itself an operational problem:
# the work it gates is stalled and the requester is waiting.
APPROVAL_STALE_HOURS = 24

# Statuses meaning a speaker's participation is still unsettled.
UNSETTLED_SPEAKER_STATUSES = frozenset(
    {"IDENTIFIED", "INVITED", "AWAITING_RESPONSE", "FOLLOWUP_SENT"}
)


def parse_timestamp(value: Any) -> datetime | None:
    """Read an ISO-8601 timestamp from a stored attribute, tolerating what we wrote.

    Records were written by several generations of code, so timestamps appear with a
    ``Z`` suffix, with a ``+00:00`` offset, and occasionally with no zone at all. A naive
    value is assumed UTC, because every writer in this codebase uses ``utc_now``.

    Returns ``None`` for anything unparseable rather than raising: one malformed
    timestamp should not take down an aggregate that is summarising two hundred records.
    """
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=utc_now().tzinfo)
    return parsed


@dataclass
class TeamState:
    """One team plus the derived shape of its workload."""

    team_id: str
    name: str
    lead_user_id: str = ""
    lead_name: str = ""
    member_count: int = 0
    members: list[dict[str, Any]] = field(default_factory=list)
    tasks: list[dict[str, Any]] = field(default_factory=list)

    total_tasks: int = 0
    open_tasks: int = 0
    completed_tasks: int = 0
    overdue_tasks: int = 0
    blocked_tasks: int = 0
    in_progress_tasks: int = 0

    @property
    def progress_percent(self) -> int:
        if self.total_tasks == 0:
            return 0
        return round(self.completed_tasks * 100 / self.total_tasks)

    @property
    def risk(self) -> str:
        """A team's risk, from the work it is actually carrying.

        Overdue work is weighted above blocked work: blocked usually means waiting on a
        named dependency and is visible, while overdue means a deadline passed and nobody
        raised it.
        """
        if self.overdue_tasks >= 3 or (self.overdue_tasks >= 1 and self.blocked_tasks >= 2):
            return "HIGH"
        if self.overdue_tasks >= 1 or self.blocked_tasks >= 1:
            return "MEDIUM"
        return "LOW"

    @property
    def workload_per_member(self) -> float:
        if self.member_count == 0:
            return float(self.open_tasks)
        return round(self.open_tasks / self.member_count, 1)


@dataclass
class BudgetState:
    """Event budget with derived figures.

    ``remaining`` and ``utilization_percent`` are computed here rather than read, because
    only the counters are maintained by atomic writes; a stored total would be one more
    thing that could fall out of step with them.
    """

    total_budget: int = 0
    allocated: int = 0
    spent: int = 0
    committed: int = 0
    currency: str = "INR"
    categories: list[dict[str, Any]] = field(default_factory=list)
    exists: bool = False

    @property
    def remaining(self) -> int:
        return self.total_budget - self.spent - self.committed

    @property
    def unallocated(self) -> int:
        return self.total_budget - self.allocated

    @property
    def utilization_percent(self) -> int:
        if self.total_budget <= 0:
            return 0
        return round((self.spent + self.committed) * 100 / self.total_budget)

    def highest_utilization_category(self) -> dict[str, Any] | None:
        """The category closest to exhausting its allocation, if any is allocated."""
        allocated = [c for c in self.categories if coerce_int(c.get("allocated")) > 0]
        if not allocated:
            return None
        return max(allocated, key=lambda c: c.get("utilization_percent", 0))


@dataclass
class AttendeeState:
    """Attendee operations counts, derived from registrations, attendees and check-ins."""

    total_registered: int = 0
    confirmed: int = 0
    cancelled: int = 0
    waitlisted: int = 0
    checked_in: int = 0
    accommodation_required: int = 0
    dietary_provided: int = 0
    dietary_missing: int = 0
    arrival_confirmed: int = 0
    arrival_conflicts: int = 0
    missing_information: int = 0

    @property
    def not_checked_in(self) -> int:
        return max(0, self.confirmed - self.checked_in)

    @property
    def data_completeness_percent(self) -> int:
        """Share of registrations with no missing operational information."""
        if self.total_registered == 0:
            return 100
        complete = self.total_registered - self.missing_information
        return round(max(0, complete) * 100 / self.total_registered)


@dataclass
class EventSnapshot:
    """Everything one event's operational state, read once.

    Consumers derive; they do not re-query. If something is missing from this structure
    the fix is to add it here, not to issue another query downstream, because a
    downstream query is how two views of the same event start disagreeing.
    """

    organization_id: str
    event_id: str
    now: datetime
    event: dict[str, Any] = field(default_factory=dict)

    teams: list[TeamState] = field(default_factory=list)
    tasks: list[dict[str, Any]] = field(default_factory=list)
    speakers: list[dict[str, Any]] = field(default_factory=list)
    incidents: list[dict[str, Any]] = field(default_factory=list)
    approvals: list[dict[str, Any]] = field(default_factory=list)
    budget: BudgetState = field(default_factory=BudgetState)
    attendees: AttendeeState = field(default_factory=AttendeeState)

    # ---- tasks -----------------------------------------------------------

    def is_task_open(self, task: dict[str, Any]) -> bool:
        return str(task.get("status", "")) not in TERMINAL_TASK_STATUSES

    def is_task_overdue(self, task: dict[str, Any]) -> bool:
        """Late, computed against the snapshot's single ``now``.

        A stored ``OVERDUE`` status is also honoured, because older records use it and
        ignoring them would under-report real lateness.
        """
        if not self.is_task_open(task):
            return False
        if str(task.get("status")) == "OVERDUE":
            return True
        due = parse_timestamp(task.get("due_date"))
        return due is not None and due < self.now

    @property
    def open_tasks(self) -> list[dict[str, Any]]:
        return [t for t in self.tasks if self.is_task_open(t)]

    @property
    def overdue_tasks(self) -> list[dict[str, Any]]:
        return [t for t in self.tasks if self.is_task_overdue(t)]

    @property
    def blocked_tasks(self) -> list[dict[str, Any]]:
        return [t for t in self.tasks if str(t.get("status")) == "BLOCKED"]

    @property
    def completed_tasks(self) -> list[dict[str, Any]]:
        return [t for t in self.tasks if str(t.get("status")) == "COMPLETED"]

    @property
    def in_progress_tasks(self) -> list[dict[str, Any]]:
        return [t for t in self.tasks if str(t.get("status")) == "IN_PROGRESS"]

    def tasks_due_within(self, hours: int) -> list[dict[str, Any]]:
        """Open tasks whose deadline falls inside the next ``hours``, excluding late ones.

        Already-overdue work is reported separately; mixing the two would hide a passed
        deadline inside an "upcoming" count.
        """
        horizon = self.now + timedelta(hours=hours)
        upcoming = []
        for task in self.open_tasks:
            due = parse_timestamp(task.get("due_date"))
            if due is not None and self.now <= due <= horizon:
                upcoming.append(task)
        return upcoming

    # ---- incidents -------------------------------------------------------

    @property
    def open_incidents(self) -> list[dict[str, Any]]:
        return [
            i for i in self.incidents if str(i.get("status", "")) not in CLOSED_INCIDENT_STATUSES
        ]

    def open_incidents_by_severity(self, severity: str) -> list[dict[str, Any]]:
        return [i for i in self.open_incidents if str(i.get("severity")) == severity]

    # ---- speakers --------------------------------------------------------

    @property
    def confirmed_speakers(self) -> list[dict[str, Any]]:
        return [s for s in self.speakers if str(s.get("status")) == "CONFIRMED"]

    @property
    def unsettled_speakers(self) -> list[dict[str, Any]]:
        """Speakers whose participation is still open, excluding backups.

        A backup is not a gap in the programme, so counting one as unsettled would
        overstate the risk.
        """
        return [
            s
            for s in self.speakers
            if str(s.get("status")) in UNSETTLED_SPEAKER_STATUSES and not s.get("is_backup")
        ]

    @property
    def silent_speakers(self) -> list[dict[str, Any]]:
        """Speakers contacted more than ``SPEAKER_SILENCE_HOURS`` ago with no reply.

        The clock runs from the last contact, not from the invitation, so a speaker who
        replied once and then went quiet is measured from the most recent outreach.
        """
        silent = []
        for speaker in self.speakers:
            if speaker.get("response_received_at"):
                continue
            if str(speaker.get("status")) in ("CONFIRMED", "DECLINED", "CANCELLED"):
                continue
            last_contact = parse_timestamp(
                speaker.get("last_contacted_at") or speaker.get("invited_at")
            )
            if last_contact is None:
                continue
            if (self.now - last_contact) >= timedelta(hours=SPEAKER_SILENCE_HOURS):
                silent.append(speaker)
        return silent

    def speaker_silent_hours(self, speaker: dict[str, Any]) -> int:
        last_contact = parse_timestamp(
            speaker.get("last_contacted_at") or speaker.get("invited_at")
        )
        if last_contact is None or speaker.get("response_received_at"):
            return 0
        return int((self.now - last_contact).total_seconds() // 3600)

    @property
    def speakers_needing_accommodation(self) -> list[dict[str, Any]]:
        return [s for s in self.speakers if s.get("accommodation_required")]

    # ---- approvals -------------------------------------------------------

    @property
    def pending_approvals(self) -> list[dict[str, Any]]:
        """Approvals still awaiting a decision.

        Filtered on the ``status`` attribute rather than trusting the index sort key,
        because ``GSI1SK`` encodes the status at creation time and a decided approval
        keeps a ``PENDING`` key unless the writer rewrote it.
        """
        return [a for a in self.approvals if str(a.get("status")) == "PENDING"]

    @property
    def stale_approvals(self) -> list[dict[str, Any]]:
        cutoff = self.now - timedelta(hours=APPROVAL_STALE_HOURS)
        stale = []
        for approval in self.pending_approvals:
            requested = parse_timestamp(approval.get("requested_at"))
            if requested is not None and requested < cutoff:
                stale.append(approval)
        return stale

    @property
    def financial_approvals(self) -> list[dict[str, Any]]:
        return [a for a in self.pending_approvals if coerce_int(a.get("amount_inr")) > 0]

    @property
    def pending_financial_exposure(self) -> int:
        """Total rupees that would be committed if every pending request were approved."""
        return sum(coerce_int(a.get("amount_inr")) for a in self.financial_approvals)

    # ---- event timing ----------------------------------------------------

    @property
    def hours_until_start(self) -> float | None:
        start = parse_timestamp(self.event.get("start_date"))
        if start is None:
            return None
        return (start - self.now).total_seconds() / 3600.0

    @property
    def is_imminent(self) -> bool:
        hours = self.hours_until_start
        return hours is not None and 0 <= hours <= 24

    # ---- team lookups ----------------------------------------------------

    def team(self, team_id: str) -> TeamState | None:
        return next((t for t in self.teams if t.team_id == team_id), None)

    @property
    def teams_at_risk(self) -> list[TeamState]:
        return [t for t in self.teams if t.risk in ("HIGH", "MEDIUM")]

    def member_workloads(self) -> list[dict[str, Any]]:
        """Open task count per assignee, busiest first.

        Used for reassignment recommendations, which need to compare people rather than
        teams. Unassigned work is reported under an empty assignee so it is visible
        instead of vanishing from the totals.
        """
        counts: dict[str, dict[str, Any]] = {}
        for team in self.teams:
            for member in team.members:
                user_id = str(member.get("user_id", ""))
                if not user_id:
                    continue
                counts.setdefault(
                    user_id,
                    {
                        "user_id": user_id,
                        "display_name": member.get("display_name", ""),
                        "team_id": team.team_id,
                        "team_name": team.name,
                        "open_tasks": 0,
                        "overdue_tasks": 0,
                    },
                )

        unassigned = {
            "user_id": "",
            "display_name": "Unassigned",
            "open_tasks": 0,
            "overdue_tasks": 0,
        }
        for task in self.open_tasks:
            assignee = str(task.get("assigned_to", ""))
            bucket = counts.get(assignee) if assignee else unassigned
            if bucket is None:
                # Assigned to somebody who is no longer a team member. Surface them
                # rather than dropping the task from the totals.
                bucket = counts.setdefault(
                    assignee,
                    {
                        "user_id": assignee,
                        "display_name": task.get("assigned_to_name") or assignee,
                        "team_id": task.get("team_id", ""),
                        "team_name": "",
                        "open_tasks": 0,
                        "overdue_tasks": 0,
                    },
                )
            bucket["open_tasks"] += 1
            if self.is_task_overdue(task):
                bucket["overdue_tasks"] += 1

        result = list(counts.values())
        if unassigned["open_tasks"]:
            result.append(unassigned)
        return sorted(result, key=lambda m: (-m["open_tasks"], m["display_name"]))


def _build_budget_state(
    budget_item: dict[str, Any], allocations: list[dict[str, Any]]
) -> BudgetState:
    categories = []
    for allocation in allocations:
        allocated = coerce_int(allocation.get("allocated"))
        spent = coerce_int(allocation.get("spent"))
        committed = coerce_int(allocation.get("committed"))
        categories.append(
            {
                "category": allocation.get("category", "OTHER"),
                "allocated": allocated,
                "spent": spent,
                "committed": committed,
                "remaining": allocated - spent - committed,
                "utilization_percent": (
                    round((spent + committed) * 100 / allocated) if allocated > 0 else 0
                ),
                "notes": allocation.get("notes", ""),
            }
        )
    categories.sort(key=lambda c: -c["allocated"])

    return BudgetState(
        total_budget=coerce_int(budget_item.get("total_budget")),
        allocated=coerce_int(budget_item.get("allocated")),
        spent=coerce_int(budget_item.get("spent")),
        committed=coerce_int(budget_item.get("committed")),
        currency=str(budget_item.get("currency", "INR")),
        categories=categories,
        exists=bool(budget_item),
    )


def _build_attendee_state(
    registrations: list[dict[str, Any]],
    attendees: list[dict[str, Any]],
    checkins: list[dict[str, Any]],
) -> AttendeeState:
    """Fold registration, attendee-detail and check-in records into one set of counts.

    Registrations are the population; attendee records carry the operational detail.
    A registration with no attendee record counts as missing information, because from
    the catering team's point of view an unanswered dietary question and an unasked one
    are the same problem.
    """
    state = AttendeeState(total_registered=len(registrations))
    detail_by_registration = {
        str(a.get("registration_id", "")): a for a in attendees if a.get("registration_id")
    }
    checked_in_ids = {str(c.get("registration_id", "")) for c in checkins}

    for registration in registrations:
        status = str(registration.get("status", ""))
        if status == "CONFIRMED":
            state.confirmed += 1
        elif status == "CANCELLED":
            state.cancelled += 1
        elif status == "WAITLISTED":
            state.waitlisted += 1

        registration_id = str(registration.get("registration_id", ""))
        if registration_id in checked_in_ids or registration.get("is_checked_in"):
            state.checked_in += 1

        # Cancelled registrations are not an operational data gap.
        if status == "CANCELLED":
            continue

        detail = detail_by_registration.get(registration_id)
        if detail is None:
            state.dietary_missing += 1
            state.missing_information += 1
            continue

        if detail.get("accommodation_required"):
            state.accommodation_required += 1

        if detail.get("dietary_requirements"):
            state.dietary_provided += 1
        else:
            state.dietary_missing += 1

        if detail.get("arrival_confirmed"):
            state.arrival_confirmed += 1

        declared_missing = detail.get("missing_fields") or []
        if declared_missing or not detail.get("dietary_requirements"):
            state.missing_information += 1

        # An arrival date recorded without confirmation is a conflict waiting to happen:
        # somebody wrote down a plan that nobody verified.
        if detail.get("arrival_date") and not detail.get("arrival_confirmed"):
            state.arrival_conflicts += 1

    return state


def load_event_snapshot(
    organization_id: str,
    event_id: str,
    *,
    table_name: str | None = None,
    include_attendees: bool = True,
) -> EventSnapshot:
    """Load one event's operational state.

    Queries issued: the event itself, one GSI1 query for the event's child records, one
    prefix query each for budget allocations, and — when ``include_attendees`` — one each
    for registrations, attendee details and check-ins.

    The bulk of the work is a single GSI1 query over the event partition, which returns
    tasks, speakers, incidents, approvals, teams and members together; they are then
    sorted by ``entity_type`` in memory. Fetching them individually would be six round
    trips for data DynamoDB already returns in one.

    Args:
        include_attendees: skip the three attendee-side queries when the caller only
            needs task, speaker, incident and approval state. Event health needs attendee
            completeness; a team member's task list does not.
    """
    repo = DynamoDBRepository(table_name or MAIN_TABLE)
    now = utc_now()

    event_item = repo.get_item(organization_id, event_sk(event_id)) or {}

    # One pass over the event's child records. GSI1PK partitions by event, so this is a
    # single query rather than one per entity kind.
    children = repo.query_gsi_all(
        GSI1_INDEX,
        event_gsi1pk(organization_id, event_id),
        max_items=4000,
    )

    by_type: dict[str, list[dict[str, Any]]] = {}
    for item in children:
        by_type.setdefault(str(item.get("entity_type", "")), []).append(item)

    tasks = by_type.get("TASK", [])
    speakers = by_type.get("SPEAKER", [])
    incidents = by_type.get("INCIDENT", [])
    approvals = by_type.get("APPROVAL", [])
    team_items = by_type.get("TEAM", [])
    member_items = by_type.get("TEAM_MEMBER", [])

    # Teams sometimes predate the GSI1 attributes, and a team missing from the index
    # would drop its tasks out of every team view. Fall back to the prefix query when the
    # index returned nothing.
    if not team_items:
        team_items = [
            item
            for item in repo.query_all(
                organization_id,
                team_prefix(event_id),
                filter_expression=Attr("entity_type").eq("TEAM"),
            )
        ]

    teams: list[TeamState] = []
    for team_item in team_items:
        team_id = str(team_item.get("team_id", ""))
        members = [m for m in member_items if str(m.get("team_id")) == team_id]
        team_tasks = [t for t in tasks if str(t.get("team_id")) == team_id]
        state = TeamState(
            team_id=team_id,
            name=str(team_item.get("name", team_id)),
            lead_user_id=str(team_item.get("lead_user_id", "")),
            lead_name=str(team_item.get("lead_name", "")),
            member_count=coerce_int(team_item.get("member_count")) or len(members),
            members=members,
            tasks=team_tasks,
        )
        state.total_tasks = len(team_tasks)
        state.completed_tasks = sum(1 for t in team_tasks if str(t.get("status")) == "COMPLETED")
        state.blocked_tasks = sum(1 for t in team_tasks if str(t.get("status")) == "BLOCKED")
        state.in_progress_tasks = sum(
            1 for t in team_tasks if str(t.get("status")) == "IN_PROGRESS"
        )
        state.open_tasks = sum(
            1 for t in team_tasks if str(t.get("status", "")) not in TERMINAL_TASK_STATUSES
        )
        teams.append(state)

    snapshot = EventSnapshot(
        organization_id=organization_id,
        event_id=event_id,
        now=now,
        event=event_item,
        teams=teams,
        tasks=tasks,
        speakers=speakers,
        incidents=incidents,
        approvals=approvals,
    )

    # Overdue counts need the snapshot's `now`, so they are filled in once it exists
    # rather than duplicating the date comparison inside the team loop above.
    for team in teams:
        team.overdue_tasks = sum(1 for t in team.tasks if snapshot.is_task_overdue(t))

    budget_item = repo.get_item(organization_id, budget_sk(event_id)) or {}
    allocations = repo.query_all(organization_id, budget_allocation_prefix(event_id))
    snapshot.budget = _build_budget_state(budget_item, allocations)

    if include_attendees:
        registrations = repo.query_all(organization_id, registration_prefix(event_id))
        attendee_details = repo.query_all(organization_id, attendee_prefix(event_id))
        checkins = repo.query_all(organization_id, checkin_prefix(event_id))
        snapshot.attendees = _build_attendee_state(registrations, attendee_details, checkins)

    logger.info(
        "Loaded event snapshot",
        extra={
            "organization_id": organization_id,
            "event_id": event_id,
            "tasks": len(tasks),
            "speakers": len(speakers),
            "incidents": len(incidents),
            "approvals": len(approvals),
            "teams": len(teams),
        },
    )
    return snapshot


def load_incident_comments(
    organization_id: str,
    event_id: str,
    incident_id: str,
    *,
    table_name: str | None = None,
) -> list[dict[str, Any]]:
    """Load one incident's discussion in order.

    Comments are excluded from :func:`load_event_snapshot` deliberately: a busy incident
    can carry dozens and the snapshot is built for every health calculation, where the
    discussion text is never read.
    """
    from services.shared.keys import incident_comment_prefix

    repo = DynamoDBRepository(table_name or MAIN_TABLE)
    comments = repo.query_all(
        organization_id, incident_comment_prefix(event_id, incident_id), max_items=500
    )
    return sorted(comments, key=lambda c: str(c.get("created_at", "")))


def list_organization_events(
    organization_id: str,
    *,
    table_name: str | None = None,
    include_archived: bool = False,
) -> list[dict[str, Any]]:
    """List an organization's events.

    The ``EVENT#`` sort-key prefix also matches every event-scoped child record, so the
    ``entity_type`` filter is what makes this return events rather than everything. That
    filter is applied by DynamoDB rather than in Python so the read cost reflects the
    events, not the whole partition.
    """
    repo = DynamoDBRepository(table_name or MAIN_TABLE)
    items = repo.query_all(
        organization_id,
        "EVENT#",
        filter_expression=Attr("entity_type").eq("EVENT"),
        max_items=500,
    )
    if not include_archived:
        items = [e for e in items if str(e.get("status")) != "ARCHIVED"]
    return sorted(items, key=lambda e: str(e.get("start_date", "")), reverse=True)
