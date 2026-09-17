"""Deterministic registration verification for check-in.

Every check in this module produces a clear pass/fail result.
No LLM inference — these are factual checks against known state.

The verification pipeline runs each check independently and collects
results so the volunteer (and audit log) can see exactly which checks
passed and which failed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class VerificationStatus(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    WARN = "WARN"


@dataclass
class VerificationCheck:
    """Result of a single verification step."""

    name: str
    status: VerificationStatus
    message: str
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class VerificationResult:
    """Aggregate result of all verification checks."""

    checks: list[VerificationCheck] = field(default_factory=list)

    @property
    def all_passed(self) -> bool:
        return all(c.status == VerificationStatus.PASS for c in self.checks)

    @property
    def failed_checks(self) -> list[VerificationCheck]:
        return [c for c in self.checks if c.status == VerificationStatus.FAIL]

    def to_dict(self) -> dict[str, Any]:
        return {
            "all_passed": self.all_passed,
            "checks": [
                {"name": c.name, "status": c.status.value, "message": c.message}
                for c in self.checks
            ],
        }


def verify_registration(registration: dict[str, Any], event_id: str) -> VerificationResult:
    """Run the complete verification pipeline for a registration.

    Checks (in order):
    1. Registration exists (caller should have already confirmed this)
    2. Registration belongs to the correct event
    3. Registration status is valid (CONFIRMED)
    4. Payment status is valid (CAPTURED or NOT_REQUIRED)
    5. Attendee is not cancelled
    6. Attendee is not refunded
    7. Attendee is eligible for check-in (not already checked in — warning only)

    Each check is independent. We run all of them so the volunteer can
    see the full picture even if an early check fails.

    Time complexity: O(1) — fixed number of constant-time checks.
    """
    result = VerificationResult()

    # Check 1: Registration exists
    if not registration:
        result.checks.append(VerificationCheck(
            name="registration_exists",
            status=VerificationStatus.FAIL,
            message="No registration record provided",
        ))
        return result

    result.checks.append(VerificationCheck(
        name="registration_exists",
        status=VerificationStatus.PASS,
        message="Registration record found",
    ))

    # Check 2: Belongs to correct event
    reg_event = registration.get("event_id", "")
    if reg_event != event_id:
        result.checks.append(VerificationCheck(
            name="event_match",
            status=VerificationStatus.FAIL,
            message=f"Registration belongs to event {reg_event}, not {event_id}",
            details={"expected_event": event_id, "actual_event": reg_event},
        ))
    else:
        result.checks.append(VerificationCheck(
            name="event_match",
            status=VerificationStatus.PASS,
            message="Registration belongs to the correct event",
        ))

    # Check 3: Status is valid
    status = registration.get("status", "")
    if status == "CONFIRMED":
        result.checks.append(VerificationCheck(
            name="registration_status",
            status=VerificationStatus.PASS,
            message="Registration is confirmed",
        ))
    elif status == "CANCELLED":
        result.checks.append(VerificationCheck(
            name="registration_status",
            status=VerificationStatus.FAIL,
            message="Registration has been cancelled",
        ))
    elif status == "WAITLISTED":
        result.checks.append(VerificationCheck(
            name="registration_status",
            status=VerificationStatus.FAIL,
            message="Registration is still waitlisted — not confirmed for entry",
        ))
    elif status == "PENDING":
        result.checks.append(VerificationCheck(
            name="registration_status",
            status=VerificationStatus.FAIL,
            message="Registration is pending — not yet confirmed",
        ))
    else:
        result.checks.append(VerificationCheck(
            name="registration_status",
            status=VerificationStatus.FAIL,
            message=f"Unrecognized registration status: {status}",
        ))

    # Check 4: Payment is valid
    payment_status = registration.get("payment_status", "")
    if payment_status in ("CAPTURED", "NOT_REQUIRED"):
        result.checks.append(VerificationCheck(
            name="payment_status",
            status=VerificationStatus.PASS,
            message=f"Payment status: {payment_status}",
        ))
    elif payment_status == "REFUNDED":
        result.checks.append(VerificationCheck(
            name="payment_status",
            status=VerificationStatus.FAIL,
            message="Payment has been refunded — attendee is not eligible",
        ))
    elif payment_status == "PENDING":
        result.checks.append(VerificationCheck(
            name="payment_status",
            status=VerificationStatus.FAIL,
            message="Payment is still pending",
        ))
    elif payment_status == "FAILED":
        result.checks.append(VerificationCheck(
            name="payment_status",
            status=VerificationStatus.FAIL,
            message="Payment failed",
        ))
    else:
        result.checks.append(VerificationCheck(
            name="payment_status",
            status=VerificationStatus.FAIL,
            message=f"Unrecognized payment status: {payment_status}",
        ))

    # Check 5: Not cancelled (redundant with status check but explicit)
    if status == "CANCELLED":
        result.checks.append(VerificationCheck(
            name="not_cancelled",
            status=VerificationStatus.FAIL,
            message="Attendee registration is cancelled",
        ))
    else:
        result.checks.append(VerificationCheck(
            name="not_cancelled",
            status=VerificationStatus.PASS,
            message="Registration is not cancelled",
        ))

    # Check 6: Not refunded
    if payment_status == "REFUNDED":
        result.checks.append(VerificationCheck(
            name="not_refunded",
            status=VerificationStatus.FAIL,
            message="Payment has been refunded",
        ))
    else:
        result.checks.append(VerificationCheck(
            name="not_refunded",
            status=VerificationStatus.PASS,
            message="No refund recorded",
        ))

    # Check 7: Check-in eligibility (already checked in is a warning, not a failure)
    is_checked_in = registration.get("is_checked_in", False)
    if is_checked_in:
        result.checks.append(VerificationCheck(
            name="checkin_eligibility",
            status=VerificationStatus.WARN,
            message="Attendee has already checked in",
        ))
    else:
        result.checks.append(VerificationCheck(
            name="checkin_eligibility",
            status=VerificationStatus.PASS,
            message="Attendee is eligible for check-in",
        ))

    return result
