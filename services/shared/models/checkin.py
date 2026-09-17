"""Check-in and recovery case models."""

from datetime import datetime
from enum import Enum

from pydantic import Field

from services.shared.models.base import DomainEntity, utc_now


class CheckInStatus(str, Enum):
    CHECKED_IN = "CHECKED_IN"
    PENDING = "PENDING"


class RecoveryCaseStatus(str, Enum):
    OPEN = "OPEN"
    RESOLVED = "RESOLVED"
    UNRESOLVED = "UNRESOLVED"
    ESCALATED = "ESCALATED"


class CheckIn(DomainEntity):
    """Records that an attendee has physically checked in at the venue.

    Idempotent by design: if the attendee is already CHECKED_IN,
    subsequent check-in attempts return the existing record without
    creating duplicates or raising errors.
    """

    event_id: str = Field(..., min_length=1)
    registration_id: str = Field(..., min_length=1)
    attendee_name: str = ""
    status: CheckInStatus = CheckInStatus.CHECKED_IN
    checked_in_at: datetime = Field(default_factory=utc_now)
    checked_in_by: str = Field(default="", description="Volunteer or system who completed check-in")
    method: str = Field(default="RECOVERY", description="QR_SCAN, MANUAL, RECOVERY")


class RecoveryCase(DomainEntity):
    """Tracks unresolved ticket recovery attempts.

    Created when registration cannot be found and payment reconciliation
    either fails or produces ambiguous results. Provides a paper trail
    for manual resolution by the registration team.
    """

    event_id: str = Field(..., min_length=1)
    case_id: str = Field(..., min_length=1)
    status: RecoveryCaseStatus = RecoveryCaseStatus.OPEN
    reason: str = Field(
        ...,
        description="NO_MATCH, AMBIGUOUS_PAYMENT, EXTERNAL_SYSTEM_FAILURE, CANCELLED_REGISTRATION, REFUNDED",
    )
    search_criteria: dict[str, str] = Field(
        default_factory=dict,
        description="What the volunteer searched for (no PII beyond what's needed)",
    )
    payment_reference: str = ""
    matched_candidates: list[str] = Field(
        default_factory=list,
        description="Registration IDs that partially matched (for AMBIGUOUS cases)",
    )
    resolution_notes: str = ""
    resolved_at: datetime | None = None
    resolved_by: str = ""
