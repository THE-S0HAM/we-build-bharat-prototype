"""Team and task models for TeamOps workflow."""

from datetime import datetime
from enum import Enum

from pydantic import Field

from services.shared.models.base import DomainEntity


class TaskStatus(str, Enum):
    PENDING = "PENDING"
    IN_PROGRESS = "IN_PROGRESS"
    BLOCKED = "BLOCKED"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"
    OVERDUE = "OVERDUE"


class TaskPriority(str, Enum):
    CRITICAL = "CRITICAL"
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"


class Team(DomainEntity):
    """An operational team for an event (e.g., Marketing, Volunteers, Venue)."""

    event_id: str = Field(..., min_length=1)
    team_id: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1, max_length=200)
    description: str = ""
    lead_user_id: str = ""
    member_count: int = Field(default=0, ge=0)
    is_active: bool = True


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
    status: TaskStatus = TaskStatus.PENDING
    priority: TaskPriority = TaskPriority.MEDIUM
    assigned_to: str = ""
    due_date: datetime | None = None
    completed_at: datetime | None = None

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
    notes: str = ""
