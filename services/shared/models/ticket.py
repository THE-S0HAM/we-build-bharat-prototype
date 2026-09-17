"""Ticket model.

Ticket ID always equals Registration ID. This is a deliberate business rule:
recovery must never create a new identity for an existing registration.
"""

from enum import Enum

from pydantic import Field

from services.shared.models.base import DomainEntity


class TicketStatus(str, Enum):
    ACTIVE = "ACTIVE"
    USED = "USED"
    REVOKED = "REVOKED"


class Ticket(DomainEntity):
    """Generated ticket artifact metadata.

    The actual PDF is stored in S3. This record tracks generation state,
    the S3 key, and the QR signature for server-side verification.
    """

    event_id: str = Field(..., min_length=1)
    ticket_id: str = Field(
        ...,
        min_length=1,
        description="Always equals registration_id — e.g. REG-2026-004821",
    )
    registration_id: str = Field(..., min_length=1)
    attendee_name: str = Field(..., min_length=1)
    attendee_email: str
    status: TicketStatus = TicketStatus.ACTIVE
    s3_key: str = Field(default="", description="S3 object key for the PDF artifact")
    qr_signature: str = Field(default="", description="HMAC signature for QR verification")
    generated_count: int = Field(
        default=1,
        description="How many times this ticket has been generated (for audit, not duplication)",
    )
