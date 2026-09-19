"""Tests for domain model validation.

Ensures Pydantic models enforce required fields and constraints.
"""

import pytest
from pydantic import ValidationError

from services.shared.models.base import AuditEvent, ErrorCategory, ErrorResponse
from services.shared.models.event import Event, EventStatus
from services.shared.models.registration import PaymentStatus, Registration, RegistrationStatus
from services.shared.models.ticket import Ticket


class TestRegistration:
    def test_valid_registration(self) -> None:
        reg = Registration(
            organization_id="ORG-001",
            event_id="EVT-001",
            registration_id="REG-2026-001",
            attendee_name="Priya Sharma",
            attendee_email="priya@example.com",
        )
        assert reg.status == RegistrationStatus.CONFIRMED
        assert reg.payment_status == PaymentStatus.NOT_REQUIRED
        assert reg.is_checked_in is False

    def test_registration_requires_organization_id(self) -> None:
        with pytest.raises(ValidationError):
            Registration(
                organization_id="",  # min_length=1
                event_id="EVT-001",
                registration_id="REG-001",
                attendee_name="Test",
                attendee_email="test@example.com",
            )

    def test_registration_requires_event_id(self) -> None:
        with pytest.raises(ValidationError):
            Registration(
                organization_id="ORG-001",
                event_id="",
                registration_id="REG-001",
                attendee_name="Test",
                attendee_email="test@example.com",
            )


class TestTicket:
    def test_ticket_id_equals_registration_id(self) -> None:
        """Business rule: ticket ID and registration ID must be the same value."""
        ticket = Ticket(
            organization_id="ORG-001",
            event_id="EVT-001",
            ticket_id="REG-2026-004821",
            registration_id="REG-2026-004821",
            attendee_name="Priya Sharma",
            attendee_email="priya@example.com",
        )
        assert ticket.ticket_id == ticket.registration_id


class TestEvent:
    def test_valid_event(self) -> None:
        evt = Event(
            organization_id="ORG-001",
            event_id="EVT-001",
            name="DevCon 2026",
        )
        assert evt.status == EventStatus.DRAFT
        assert evt.expected_attendees == 0

    def test_event_requires_name(self) -> None:
        with pytest.raises(ValidationError):
            Event(
                organization_id="ORG-001",
                event_id="EVT-001",
                name="",
            )


class TestErrorResponse:
    def test_error_response_structure(self) -> None:
        err = ErrorResponse(
            error=ErrorCategory.NOT_FOUND,
            message="Registration not found",
        )
        assert err.error == ErrorCategory.NOT_FOUND
        data = err.model_dump()
        assert "error" in data
        assert "message" in data


class TestAuditEvent:
    def test_audit_event_structure(self) -> None:
        audit = AuditEvent(
            audit_id="AUD-test",
            organization_id="ORG-001",
            action="CHECKIN_COMPLETED",
            actor_type="user",
            actor_id="user-123",
            resource_type="CheckIn",
            resource_id="REG-001",
        )
        assert audit.outcome == "success"
        assert audit.event_id is None
