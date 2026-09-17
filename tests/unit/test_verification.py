"""Tests for check-in verification logic.

These tests cover every path through the deterministic verification
pipeline. No mocking of external services needed — verification
operates on a registration dict and produces structured results.
"""

import pytest

from services.checkin.verification import (
    VerificationResult,
    VerificationStatus,
    verify_registration,
)

EVENT_ID = "EVT-test-001"


def _make_registration(**overrides: object) -> dict:
    """Create a valid registration dict with optional overrides."""
    base = {
        "registration_id": "REG-2026-004821",
        "event_id": EVENT_ID,
        "attendee_name": "Priya Sharma",
        "attendee_email": "priya@example.com",
        "status": "CONFIRMED",
        "payment_status": "CAPTURED",
        "is_checked_in": False,
    }
    base.update(overrides)
    return base


class TestVerifyRegistration:
    """Verification pipeline — each test targets a specific path."""

    def test_valid_registration_passes_all_checks(self) -> None:
        reg = _make_registration()
        result = verify_registration(reg, EVENT_ID)
        assert result.all_passed
        assert len(result.failed_checks) == 0

    def test_empty_registration_fails(self) -> None:
        result = verify_registration({}, EVENT_ID)
        assert not result.all_passed

    def test_none_registration_fails(self) -> None:
        """Passing None should fail at the existence check."""
        result = verify_registration(None, EVENT_ID)  # type: ignore[arg-type]
        assert not result.all_passed
        assert any(c.name == "registration_exists" for c in result.failed_checks)

    def test_wrong_event_fails(self) -> None:
        reg = _make_registration(event_id="EVT-other")
        result = verify_registration(reg, EVENT_ID)
        assert not result.all_passed
        assert any(c.name == "event_match" for c in result.failed_checks)

    def test_cancelled_registration_fails(self) -> None:
        reg = _make_registration(status="CANCELLED")
        result = verify_registration(reg, EVENT_ID)
        assert not result.all_passed
        failed_names = [c.name for c in result.failed_checks]
        assert "registration_status" in failed_names
        assert "not_cancelled" in failed_names

    def test_waitlisted_registration_fails(self) -> None:
        reg = _make_registration(status="WAITLISTED")
        result = verify_registration(reg, EVENT_ID)
        assert not result.all_passed
        assert any(c.name == "registration_status" for c in result.failed_checks)

    def test_pending_registration_fails(self) -> None:
        reg = _make_registration(status="PENDING")
        result = verify_registration(reg, EVENT_ID)
        assert not result.all_passed

    def test_refunded_payment_fails(self) -> None:
        reg = _make_registration(payment_status="REFUNDED")
        result = verify_registration(reg, EVENT_ID)
        assert not result.all_passed
        failed_names = [c.name for c in result.failed_checks]
        assert "payment_status" in failed_names
        assert "not_refunded" in failed_names

    def test_pending_payment_fails(self) -> None:
        reg = _make_registration(payment_status="PENDING")
        result = verify_registration(reg, EVENT_ID)
        assert not result.all_passed

    def test_failed_payment_fails(self) -> None:
        reg = _make_registration(payment_status="FAILED")
        result = verify_registration(reg, EVENT_ID)
        assert not result.all_passed

    def test_free_event_passes(self) -> None:
        """NOT_REQUIRED payment status should pass (free events)."""
        reg = _make_registration(payment_status="NOT_REQUIRED")
        result = verify_registration(reg, EVENT_ID)
        assert result.all_passed

    def test_already_checked_in_is_warning_not_failure(self) -> None:
        """Already checked-in attendees get a WARN, not FAIL.
        This matches the business rule: return success with existing timestamp."""
        reg = _make_registration(is_checked_in=True)
        result = verify_registration(reg, EVENT_ID)
        # All checks should pass (no FAIL), but there's a WARN
        assert len(result.failed_checks) == 0
        warnings = [c for c in result.checks if c.status == VerificationStatus.WARN]
        assert len(warnings) == 1
        assert warnings[0].name == "checkin_eligibility"

    def test_unknown_status_fails(self) -> None:
        reg = _make_registration(status="UNKNOWN_STATUS")
        result = verify_registration(reg, EVENT_ID)
        assert not result.all_passed

    def test_all_checks_run_even_when_early_fails(self) -> None:
        """All checks run independently — we don't short-circuit so the
        volunteer can see the full picture."""
        reg = _make_registration(
            event_id="WRONG",
            status="CANCELLED",
            payment_status="REFUNDED",
        )
        result = verify_registration(reg, EVENT_ID)
        # Should have multiple failures
        assert len(result.failed_checks) >= 3

    def test_to_dict_structure(self) -> None:
        """Verify the serialized output shape."""
        reg = _make_registration()
        result = verify_registration(reg, EVENT_ID)
        d = result.to_dict()
        assert "all_passed" in d
        assert "checks" in d
        assert isinstance(d["checks"], list)
        assert all("name" in c and "status" in c and "message" in c for c in d["checks"])
