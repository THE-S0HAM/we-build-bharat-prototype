"""Registration and payment reference models.

Registration ID is the stable identity throughout the system.
Ticket recovery must never create a second identity — ticket ID always equals registration ID.
"""

from enum import Enum

from pydantic import Field

from services.shared.models.base import DomainEntity


class RegistrationStatus(str, Enum):
    CONFIRMED = "CONFIRMED"
    PENDING = "PENDING"
    CANCELLED = "CANCELLED"
    WAITLISTED = "WAITLISTED"


class PaymentStatus(str, Enum):
    CAPTURED = "CAPTURED"
    PENDING = "PENDING"
    FAILED = "FAILED"
    REFUNDED = "REFUNDED"
    NOT_REQUIRED = "NOT_REQUIRED"


class Registration(DomainEntity):
    """An attendee's registration for an event.

    The registration_id is the authoritative identity for the attendee
    within this event. It is also used as the ticket ID — they are the
    same value by design so that ticket recovery never creates a parallel
    identity.
    """

    event_id: str = Field(..., min_length=1)
    registration_id: str = Field(..., min_length=1, description="Stable identity, e.g. REG-2026-004821")
    attendee_name: str = Field(..., min_length=1)
    attendee_email: str = Field(..., min_length=1)
    attendee_phone: str = ""
    status: RegistrationStatus = RegistrationStatus.CONFIRMED
    payment_status: PaymentStatus = PaymentStatus.NOT_REQUIRED
    payment_reference: str = ""
    ticket_type: str = "GENERAL"
    is_checked_in: bool = False


class PaymentReference(DomainEntity):
    """A payment transaction linked to a registration.

    Used for reconciliation when a registration cannot be found by
    attendee identifiers — the volunteer provides a payment/transaction
    reference and we look up which registration it belongs to.
    """

    event_id: str = Field(..., min_length=1)
    transaction_id: str = Field(..., min_length=1, description="Payment gateway transaction reference")
    registration_id: str = Field(..., min_length=1, description="Linked registration")
    amount: str = ""
    currency: str = "INR"
    status: PaymentStatus = PaymentStatus.CAPTURED
    payment_method: str = ""
    payer_email: str = ""
    payer_name: str = ""
