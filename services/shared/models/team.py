"""Team, team membership and task models for TeamOps workflow."""

from datetime import datetime
from enum import Enum

from pydantic import Field

from services.shared.models.base import DomainEntity


class TaskStatus(str, Enum):
    """Task lifecycle.

    ``BACKLOG → ASSIGNED → IN_PROGRESS → BLOCKED → REVIEW → COMPLETED`` is the
    intended flow, with ``CANCELLED`` as an exit from any state.

    ``PENDING`` predates ``BACKLOG``/``ASSIGNED`` and is retained because existing
    records use it; treat it as equivalent to ``BACKLOG``.

    ``OVERDUE`` is retained for the same reason but is a trap: lateness is a function
    of ``due_date`` and the current time, so storing it means it goes stale the moment
    a deadline passes. Derive lateness with ``Task.is_overdue`` instead of writing this
    value on new records.
    """

    BACKLOG = "BACKLOG"
    PENDING = "PENDING"
    ASSIGNED = "ASSIGNED"
    IN_PROGRESS = "IN_PROGRESS"
    BLOCKED = "BLOCKED"
    REVIEW = "REVIEW"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"
    OVERDUE = "OVERDUE"


# Statuses that represent work no longer in flight. Used by aggregation and the health
# engine so "open work" has one definition across the codebase.
TERMINAL_TASK_STATUSES: frozenset[str] = frozenset(
    {TaskStatus.COMPLETED.value, TaskStatus.CANCELLED.value}
)


class TaskPriority(str, Enum):
    CRITICAL = "CRITICAL"
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"


class TaskRisk(str, Enum):
    NONE = "NONE"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class TeamRole(str, Enum):
    LEAD = "LEAD"
    MEMBER = "MEMBER"


class Team(DomainEntity):
    """An operational team for an event (e.g., Marketing, Volunteers, Venue)."""

    event_id: str = Field(..., min_length=1)
    team_id: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1, max_length=200)
    description: str = ""
    responsibilities: list[str] = Field(default_factory=list)
    lead_user_id: str = ""
    lead_name: str = ""
    member_count: int = Field(default=0, ge=0)
    is_active: bool = True


class TeamMember(DomainEntity):
    """A person assigned to a team for an event.

    This record, not the Cognito token, is the authority on team membership. Membership
    changes often and ID tokens are cached for their lifetime, so deriving scope from
    the token would let a removed member keep access until their token expired.
    """

    event_id: str = Field(..., min_length=1)
    team_id: str = Field(..., min_length=1)
    user_id: str = Field(..., min_length=1, description="Cognito sub")
    display_name: str = Field(..., min_length=1, max_length=200)
    email: str = ""
    team_role: TeamRole = TeamRole.MEMBER
    skills: list[str] = Field(default_factory=list)
    is_active: bool = True

    # Denormalized workload counters, maintained by the task write path so the team
    # workload view does not have to scan every task to render.
    active_task_count: int = Field(default=0, ge=0)
    completed_task_count: int = Field(default=0, ge=0)


class Task(DomainEntity):
    """A trackable unit of work within a team.

    Tasks support dependencies (blocks/blocked-by), priority ordering,
    deadlines, and escalation levels. TeamOps uses these to surface
    overdue work, blocked dependencies, and items needing attention.
    """

    event_id: str = Field(..., min_length=1)
    team_id: str = Field(..., min_length=1)
    task_id: str = Field(..., min_length=1)
    title: str = Field(..., min_length=1, max_length=500)
    description: str = ""
    status: TaskStatus = TaskStatus.BACKLOG
    priority: TaskPriority = TaskPriority.MEDIUM
    risk: TaskRisk = TaskRisk.NONE
    assigned_to: str = ""
    assigned_to_name: str = ""
    due_date: datetime | None = None
    completed_at: datetime | None = None
    estimated_effort_hours: int = Field(default=0, ge=0)

    # Dependencies — task IDs that must complete before this one can start
    depends_on: list[str] = Field(default_factory=list)
    # Tasks that this task blocks
    blocks: list[str] = Field(default_factory=list)

    escalation_level: int = Field(
        default=0,
        ge=0,
        le=3,
        description="0=normal, 1=attention, 2=warning, 3=critical",
    )
    blocked_reason: str = ""
    notes: str = ""

    # Provenance: set when the task was created from an incident discussion, so the
    # thread that produced the work stays reachable from the work itself.
    source_comment_id: str | None = None
    source_incident_id: str | None = None

    def is_overdue(self, now: datetime) -> bool:
        """Whether this task is late, computed rather than stored."""
        if self.status.value in TERMINAL_TASK_STATUSES or self.due_date is None:
            return False
        return self.due_date < now
