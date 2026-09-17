"""Attendee operational model for AttendeeOps."""

from pydantic import Field

from services.shared.models.base import DomainEntity


class Attendee(DomainEntity):
    """Operational attendee data beyond basic registration.

    Tracks logistics requirements that AttendeeOps monitors — dietary
    needs, accommodation, accessibility, arrival details. The agent
    identifies missing information, prepares follow-up actions, and
    tracks completion against deadlines.
    """

    event_id: str = Field(..., min_length=1)
    registration_id: str = Field(..., min_length=1)
    attendee_name: str = Field(..., min_length=1)
    attendee_email: str = ""

    # Logistics
    dietary_requirements: str = ""
    dietary_confirmed: bool = False
    accommodation_required: bool = False
    accommodation_details: str = ""
    accessibility_requirements: str = ""
    arrival_date: str = ""
    arrival_confirmed: bool = False
    special_assistance: str = ""

    # Communication state
    info_request_sent: bool = False
    info_request_responded: bool = False
    missing_fields: list[str] = Field(
        default_factory=list,
        description="Fields still needed, e.g. ['dietary_requirements', 'arrival_date']",
    )
    tags: list[str] = Field(
        default_factory=list,
        description="Segmentation tags, e.g. ['vip', 'speaker-guest', 'first-time']",
    )
