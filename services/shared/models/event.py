"""Event model."""

from datetime import datetime
from enum import Enum

from pydantic import Field

from services.shared.models.base import DomainEntity


class EventStatus(str, Enum):
    DRAFT = "DRAFT"
    PUBLISHED = "PUBLISHED"
    ACTIVE = "ACTIVE"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class Event(DomainEntity):
    """A community event managed by OrbitOps."""

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
    registration_open: bool = False
    tags: list[str] = Field(default_factory=list)
