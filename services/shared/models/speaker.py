"""Speaker model for SpeakerOps workflow."""

from datetime import datetime
from enum import Enum

from pydantic import Field

from services.shared.models.base import DomainEntity


class SpeakerStatus(str, Enum):
    IDENTIFIED = "IDENTIFIED"
    INVITED = "INVITED"
    AWAITING_RESPONSE = "AWAITING_RESPONSE"
    FOLLOWUP_SENT = "FOLLOWUP_SENT"
    CONFIRMED = "CONFIRMED"
    DECLINED = "DECLINED"
    CANCELLED = "CANCELLED"
    BACKUP = "BACKUP"


class Speaker(DomainEntity):
    """A speaker for an event.

    Tracks the full outreach lifecycle from identification through
    confirmation, including follow-up state, topic details, and
    logistics requirements. SpeakerOps agent manages the workflow;
    irreversible commitments require human approval.
    """

    event_id: str = Field(..., min_length=1)
    speaker_id: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    email: str = ""
    phone: str = ""
    status: SpeakerStatus = SpeakerStatus.IDENTIFIED
    topic: str = ""
    bio: str = ""
    session_type: str = Field(
        default="TALK", description="TALK, WORKSHOP, PANEL, KEYNOTE, LIGHTNING"
    )
    session_duration_minutes: int = Field(default=30, ge=5)

    # Outreach tracking
    invited_at: datetime | None = None
    last_contacted_at: datetime | None = None
    followup_count: int = 0
    max_followups: int = Field(default=3, description="Policy-driven limit on automated follow-ups")
    response_received_at: datetime | None = None

    # Logistics
    travel_required: bool = False
    accommodation_required: bool = False
    travel_details: str = ""
    accommodation_details: str = ""
    special_requirements: str = ""
    availability_notes: str = ""

    # Session readiness
    slides_submitted: bool = False
    av_requirements: str = ""
    is_backup: bool = False
    backup_for_speaker_id: str | None = None
