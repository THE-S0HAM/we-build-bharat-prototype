"""Event model."""

from datetime import datetime
from enum import Enum

from pydantic import Field

from services.shared.models.base import DomainEntity


class EventStatus(str, Enum):
    """Event lifecycle.

    ``PAUSED`` suspends agent-initiated operations without ending the event.
    ``ARCHIVED`` removes the event from active listings while preserving its records,
    because operational history is what the audit log is for.
    """

    DRAFT = "DRAFT"
    PUBLISHED = "PUBLISHED"
    ACTIVE = "ACTIVE"
    PAUSED = "PAUSED"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"
    ARCHIVED = "ARCHIVED"


class HealthBand(str, Enum):
    """Event health, worst-last so comparisons read naturally."""

    GREEN = "GREEN"
    YELLOW = "YELLOW"
    ORANGE = "ORANGE"
    RED = "RED"


class Event(DomainEntity):
    """A community event managed by CommunityOps."""

    event_id: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1, max_length=300)
    description: str = ""
    status: EventStatus = EventStatus.DRAFT
    venue: str = ""
    city: str = ""
    start_date: datetime | None = None
    end_date: datetime | None = None
    timezone: str = "Asia/Kolkata"
    expected_attendees: int = Field(default=0, ge=0)
    registration_target: int = Field(default=0, ge=0)
    registration_open: bool = False
    total_budget: int = Field(default=0, ge=0, description="Whole rupees")
    tags: list[str] = Field(default_factory=list)

    # Health is recomputed by the deterministic engine and cached here so listings do
    # not each have to load a full event snapshot. The cache is advisory; the engine
    # output is authoritative.
    health_band: HealthBand = HealthBand.GREEN
    health_score: int = Field(default=0, ge=0, le=100)
    health_reasons: list[str] = Field(default_factory=list)
    health_computed_at: datetime | None = None

    paused_at: datetime | None = None
    completed_at: datetime | None = None
    archived_at: datetime | None = None
    duplicated_from_event_id: str | None = None
