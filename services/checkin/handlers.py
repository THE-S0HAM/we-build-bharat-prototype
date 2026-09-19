"""Check-in Lambda handlers.

Each handler corresponds to one API endpoint in the check-in flow.
All handlers follow the same pattern:
1. Parse and validate input
2. Execute deterministic business logic
3. Return structured response
4. Emit audit event

No LLM calls in this module — check-in verification is entirely deterministic.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any

from services.checkin.ticket_service import generate_ticket, verify_qr_signature
from services.checkin.verification import verify_registration
from services.shared.api_response import error, success
from services.shared.audit import create_audit_event
from services.shared.connectors_dynamodb import (
    DynamoDBPaymentConnector,
    DynamoDBRegistrationConnector,
)
from services.shared.dynamodb import DynamoDBError, DynamoDBRepository
from services.shared.models.base import ErrorCategory, utc_now
from services.shared.tenancy import authorize_organization

logger = logging.getLogger(__name__)

MAIN_TABLE = os.environ.get("MAIN_TABLE", "CommunityOps-Main-dev")


def _parse_body(event: dict[str, Any]) -> dict[str, Any]:
    """Parse JSON body from API Gateway event."""
    body = event.get("body", "{}")
    if isinstance(body, str):
        return json.loads(body)
    return body


def _get_user_id(event: dict[str, Any]) -> str:
    """Extract user ID from Cognito authorizer context."""
    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})
    return claims.get("sub", "anonymous")


def _get_path_param(event: dict[str, Any], param: str) -> str:
    """Extract a path parameter from API Gateway event."""
    return event.get("pathParameters", {}).get(param, "")


# ---------------------------------------------------------------------------
# POST /events/{eventId}/checkin/search
# ---------------------------------------------------------------------------


def search_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Search for an attendee registration.

    Accepts: registration_id, email, phone, or name.
    Uses exact identifiers first; name search returns candidates.
    """
    body = _parse_body(event)
    event_id = _get_path_param(event, "eventId")
    org_id = body.get("organization_id", "")
    _user_id = _get_user_id(event)  # Available for audit logging

    if not org_id or not event_id:
        return error(ErrorCategory.VALIDATION_ERROR, "organization_id and eventId are required")

    denied = authorize_organization(event, org_id)
    if denied:
        return denied

    connector = DynamoDBRegistrationConnector()

    # Priority: registration_id > email > phone > name
    search_value = ""

    if body.get("registration_id"):
        search_value = body["registration_id"]
        result = connector.lookup_by_id(org_id, event_id, search_value)
    elif body.get("email"):
        search_value = body["email"]
        result = connector.lookup_by_email(org_id, event_id, search_value)
    elif body.get("phone"):
        search_value = body["phone"]
        result = connector.lookup_by_phone(org_id, event_id, search_value)
    elif body.get("name"):
        search_value = body["name"]
        result = connector.lookup_by_name(org_id, event_id, search_value)
    else:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            "Provide at least one search field: registration_id, email, phone, or name",
        )

    if not result.success:
        return error(
            ErrorCategory.EXTERNAL_SERVICE_ERROR,
            result.error_message or "Registration system is currently unavailable.",
        )

    if not result.data:
        return success(
            {
                "found": False,
                "count": 0,
                "registrations": [],
                "message": "No matching registration found. You may try a payment reference for reconciliation.",
            }
        )

    # Multiple matches on name search: return candidates, don't auto-select
    if len(result.data) > 1:
        # Strip sensitive fields before returning candidate list
        candidates = [
            {
                "registration_id": r.get("registration_id", ""),
                "attendee_name": r.get("attendee_name", ""),
                "attendee_email": _mask_email(r.get("attendee_email", "")),
                "ticket_type": r.get("ticket_type", ""),
            }
            for r in result.data
        ]
        return success(
            {
                "found": True,
                "count": len(candidates),
                "registrations": candidates,
                "message": "Multiple registrations found. Please provide additional identifying information.",
                "requires_disambiguation": True,
            }
        )

    return success(
        {
            "found": True,
            "count": 1,
            "registrations": result.data,
            "requires_disambiguation": False,
        }
    )


def _mask_email(email: str) -> str:
    """Mask email for candidate display: j***@example.com."""
    if not email or "@" not in email:
        return email
    local, domain = email.split("@", 1)
    if len(local) <= 1:
        return f"{local}***@{domain}"
    return f"{local[0]}***@{domain}"


# ---------------------------------------------------------------------------
# POST /events/{eventId}/checkin/verify
# ---------------------------------------------------------------------------


def verify_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Run deterministic verification checks on a registration.

    Returns the full verification pipeline result so the volunteer
    can see which checks passed and which failed.
    """
    body = _parse_body(event)
    event_id = _get_path_param(event, "eventId")
    org_id = body.get("organization_id", "")
    registration_id = body.get("registration_id", "")

    if not all([org_id, event_id, registration_id]):
        return error(
            ErrorCategory.VALIDATION_ERROR,
            "organization_id, eventId, and registration_id are required",
        )

    denied = authorize_organization(event, org_id)
    if denied:
        return denied

    connector = DynamoDBRegistrationConnector()
    result = connector.lookup_by_id(org_id, event_id, registration_id)

    if not result.success:
        return error(
            ErrorCategory.EXTERNAL_SERVICE_ERROR,
            result.error_message or "Registration system is currently unavailable.",
        )

    if not result.data:
        return error(ErrorCategory.NOT_FOUND, "Registration not found for this event")

    registration = result.data[0]
    verification = verify_registration(registration, event_id)

    return success(
        {
            "registration_id": registration_id,
            "verification": verification.to_dict(),
            "registration": {
                "attendee_name": registration.get("attendee_name", ""),
                "ticket_type": registration.get("ticket_type", ""),
                "status": registration.get("status", ""),
                "payment_status": registration.get("payment_status", ""),
            },
        }
    )


# ---------------------------------------------------------------------------
# POST /events/{eventId}/checkin/recover
# ---------------------------------------------------------------------------


def recover_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Generate/recover a ticket for a verified registration.

    Idempotent: if a ticket already exists for this registration,
    returns the existing ticket data with a refreshed pre-signed URL
    instead of creating a duplicate.
    """
    body = _parse_body(event)
    event_id = _get_path_param(event, "eventId")
    org_id = body.get("organization_id", "")
    registration_id = body.get("registration_id", "")
    user_id = _get_user_id(event)

    if not all([org_id, event_id, registration_id]):
        return error(
            ErrorCategory.VALIDATION_ERROR,
            "organization_id, eventId, and registration_id are required",
        )

    denied = authorize_organization(event, org_id)
    if denied:
        return denied

    repo = DynamoDBRepository(MAIN_TABLE)

    # Idempotency check: does a ticket already exist?
    existing_ticket = repo.get_item(org_id, f"EVENT#{event_id}#TICKET#{registration_id}")
    if existing_ticket:
        from services.checkin.ticket_service import get_presigned_url

        s3_key = existing_ticket.get("s3_key", "")
        download_url = get_presigned_url(s3_key) if s3_key else ""

        # Increment generated_count for audit visibility
        repo.update_item(
            org_id,
            f"EVENT#{event_id}#TICKET#{registration_id}",
            {
                "generated_count": existing_ticket.get("generated_count", 1) + 1,
                "updated_at": utc_now().isoformat(),
            },
        )

        create_audit_event(
            organization_id=org_id,
            action="TICKET_REGENERATED",
            actor_type="user",
            actor_id=user_id,
            resource_type="Ticket",
            resource_id=registration_id,
            event_id=event_id,
            details={"generated_count": existing_ticket.get("generated_count", 1) + 1},
        )

        return success(
            {
                "ticket_id": registration_id,
                "registration_id": registration_id,
                "download_url": download_url,
                "already_existed": True,
                "message": "Ticket already exists. A fresh download link has been generated.",
            }
        )

    # Fetch registration for ticket details
    connector = DynamoDBRegistrationConnector()
    reg_result = connector.lookup_by_id(org_id, event_id, registration_id)
    if not reg_result.success or not reg_result.data:
        return error(ErrorCategory.NOT_FOUND, "Registration not found — cannot generate ticket")

    reg = reg_result.data[0]

    # Fetch event details for the PDF
    event_record = repo.get_item(org_id, f"EVENT#{event_id}")
    event_name = event_record.get("name", "Event") if event_record else "Event"
    event_date = event_record.get("start_date", "") if event_record else ""
    venue = event_record.get("venue", "") if event_record else ""

    # Generate ticket (PDF + QR + S3 upload)
    ticket_data = generate_ticket(
        organization_id=org_id,
        event_id=event_id,
        registration_id=registration_id,
        attendee_name=reg.get("attendee_name", ""),
        attendee_email=reg.get("attendee_email", ""),
        event_name=event_name,
        event_date=str(event_date),
        venue=venue,
    )

    # Store ticket metadata in DynamoDB
    repo.put_item(
        org_id,
        f"EVENT#{event_id}#TICKET#{registration_id}",
        {
            "entity_type": "TICKET",
            "event_id": event_id,
            "ticket_id": registration_id,
            "registration_id": registration_id,
            "attendee_name": reg.get("attendee_name", ""),
            "attendee_email": reg.get("attendee_email", ""),
            "status": "ACTIVE",
            "s3_key": ticket_data["s3_key"],
            "qr_signature": ticket_data["qr_signature"],
            # The signed payload is retained so the QR can be re-verified
            # server-side. It carries no PII (registration/event/org IDs and a
            # timestamp) and forgery is prevented by the HMAC secret, not by
            # keeping the payload secret.
            "qr_payload": ticket_data["qr_payload"],
            "generated_count": 1,
            "created_at": utc_now().isoformat(),
            "created_by": user_id,
            "GSI1PK": f"{org_id}#{event_id}",
            "GSI1SK": f"TICKET#{registration_id}",
        },
    )

    create_audit_event(
        organization_id=org_id,
        action="TICKET_RECOVERED",
        actor_type="user",
        actor_id=user_id,
        resource_type="Ticket",
        resource_id=registration_id,
        event_id=event_id,
        details={"s3_key": ticket_data["s3_key"]},
    )

    return success(
        {
            "ticket_id": registration_id,
            "registration_id": registration_id,
            "download_url": ticket_data["download_url"],
            "already_existed": False,
            "message": "Ticket generated successfully.",
        },
        status_code=201,
    )


# ---------------------------------------------------------------------------
# POST /events/{eventId}/checkin/reconcile
# ---------------------------------------------------------------------------


def reconcile_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Attempt to reconcile check-in via payment reference.

    Called when registration search fails. The volunteer provides a
    transaction/payment reference (never card/CVV/PIN).
    """
    body = _parse_body(event)
    event_id = _get_path_param(event, "eventId")
    org_id = body.get("organization_id", "")
    transaction_id = body.get("transaction_id", "")
    user_id = _get_user_id(event)

    if not all([org_id, event_id, transaction_id]):
        return error(
            ErrorCategory.VALIDATION_ERROR,
            "organization_id, eventId, and transaction_id are required",
        )

    denied = authorize_organization(event, org_id)
    if denied:
        return denied

    payment_connector = DynamoDBPaymentConnector()
    payment_result = payment_connector.lookup_by_transaction_id(org_id, event_id, transaction_id)

    if not payment_result.success:
        # External system unavailable — do NOT say "payment does not exist"
        _create_recovery_case(
            org_id,
            event_id,
            user_id,
            reason="EXTERNAL_SYSTEM_FAILURE",
            search_criteria={"transaction_id": transaction_id},
        )
        return error(
            ErrorCategory.EXTERNAL_SERVICE_ERROR,
            "Payment system is currently unavailable. A recovery case has been created for manual resolution.",
        )

    if not payment_result.data:
        _create_recovery_case(
            org_id,
            event_id,
            user_id,
            reason="NO_MATCH",
            search_criteria={"transaction_id": transaction_id},
        )
        return success(
            {
                "reconciled": False,
                "message": (
                    "No matching payment record was found for this event. "
                    "The booking could not be verified. "
                    "Please contact the event registration team for manual verification."
                ),
                "recovery_case_created": True,
            }
        )

    payment = payment_result.data[0]
    linked_reg_id = payment.get("registration_id", "")
    payment_status = payment.get("status", "")

    # Verify payment is actually captured/valid
    if payment_status not in ("CAPTURED", "NOT_REQUIRED"):
        _create_recovery_case(
            org_id,
            event_id,
            user_id,
            reason="AMBIGUOUS_PAYMENT",
            search_criteria={"transaction_id": transaction_id},
            payment_reference=transaction_id,
        )
        return success(
            {
                "reconciled": False,
                "message": f"Payment found but status is {payment_status}. A recovery case has been created.",
                "recovery_case_created": True,
            }
        )

    if not linked_reg_id:
        # Payment exists but not linked to a registration
        _create_recovery_case(
            org_id,
            event_id,
            user_id,
            reason="AMBIGUOUS_PAYMENT",
            search_criteria={"transaction_id": transaction_id},
            payment_reference=transaction_id,
        )
        return success(
            {
                "reconciled": False,
                "message": "Payment found but could not be confidently linked to a registration. A recovery case has been created.",
                "recovery_case_created": True,
            }
        )

    # Payment linked to a registration — verify the registration
    reg_connector = DynamoDBRegistrationConnector()
    reg_result = reg_connector.lookup_by_id(org_id, event_id, linked_reg_id)

    if not reg_result.success or not reg_result.data:
        _create_recovery_case(
            org_id,
            event_id,
            user_id,
            reason="AMBIGUOUS_PAYMENT",
            search_criteria={"transaction_id": transaction_id},
            payment_reference=transaction_id,
            matched_candidates=[linked_reg_id],
        )
        return success(
            {
                "reconciled": False,
                "message": "Payment found and linked to a registration, but the registration could not be verified.",
                "recovery_case_created": True,
            }
        )

    # Successfully reconciled
    registration = reg_result.data[0]

    create_audit_event(
        organization_id=org_id,
        action="PAYMENT_RECONCILED",
        actor_type="user",
        actor_id=user_id,
        resource_type="PaymentReference",
        resource_id=transaction_id,
        event_id=event_id,
        details={
            "linked_registration_id": linked_reg_id,
            "payment_status": payment_status,
        },
    )

    return success(
        {
            "reconciled": True,
            "registration_id": linked_reg_id,
            "registration": {
                "attendee_name": registration.get("attendee_name", ""),
                "status": registration.get("status", ""),
                "payment_status": registration.get("payment_status", ""),
            },
            "message": "Payment reconciled with registration. Proceed to verification and ticket recovery.",
        }
    )


def _create_recovery_case(
    org_id: str,
    event_id: str,
    user_id: str,
    *,
    reason: str,
    search_criteria: dict[str, str],
    payment_reference: str = "",
    matched_candidates: list[str] | None = None,
) -> None:
    """Create an unresolved recovery case for manual follow-up."""
    repo = DynamoDBRepository(MAIN_TABLE)
    case_id = f"RC-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()

    repo.put_item(
        org_id,
        f"EVENT#{event_id}#RECOVERY#{case_id}",
        {
            "entity_type": "RECOVERY_CASE",
            "event_id": event_id,
            "case_id": case_id,
            "status": "OPEN",
            "reason": reason,
            "search_criteria": search_criteria,
            "payment_reference": payment_reference,
            "matched_candidates": matched_candidates or [],
            "created_at": now,
            "created_by": user_id,
            "GSI1PK": f"{org_id}#{event_id}",
            "GSI1SK": f"RECOVERY#OPEN#{now}",
        },
    )

    create_audit_event(
        organization_id=org_id,
        action="RECOVERY_CASE_CREATED",
        actor_type="user",
        actor_id=user_id,
        resource_type="RecoveryCase",
        resource_id=case_id,
        event_id=event_id,
        details={"reason": reason, "search_criteria": search_criteria},
    )


# ---------------------------------------------------------------------------
# POST /events/{eventId}/checkin/complete
# ---------------------------------------------------------------------------


def complete_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Mark an attendee as checked in.

    Idempotent: if already checked in, returns success with the
    existing check-in timestamp. No duplicate side effects.
    """
    body = _parse_body(event)
    event_id = _get_path_param(event, "eventId")
    org_id = body.get("organization_id", "")
    registration_id = body.get("registration_id", "")
    user_id = _get_user_id(event)

    if not all([org_id, event_id, registration_id]):
        return error(
            ErrorCategory.VALIDATION_ERROR,
            "organization_id, eventId, and registration_id are required",
        )

    denied = authorize_organization(event, org_id)
    if denied:
        return denied

    repo = DynamoDBRepository(MAIN_TABLE)
    now = utc_now()

    # Idempotent write: only create if check-in doesn't exist
    created = repo.put_item_idempotent(
        org_id,
        f"EVENT#{event_id}#CHECKIN#{registration_id}",
        {
            "entity_type": "CHECKIN",
            "event_id": event_id,
            "registration_id": registration_id,
            "status": "CHECKED_IN",
            "checked_in_at": now.isoformat(),
            "checked_in_by": user_id,
            "method": "RECOVERY",
            "GSI1PK": f"{org_id}#{event_id}",
            "GSI1SK": f"CHECKIN#{now.isoformat()}",
        },
    )

    if created:
        # Update the registration record to reflect check-in
        try:
            repo.update_item(
                org_id,
                f"EVENT#{event_id}#REG#{registration_id}",
                {"is_checked_in": True, "updated_at": now.isoformat()},
            )
        except DynamoDBError:
            logger.warning(
                "Failed to update registration is_checked_in flag for %s",
                registration_id,
            )

        create_audit_event(
            organization_id=org_id,
            action="CHECKIN_COMPLETED",
            actor_type="user",
            actor_id=user_id,
            resource_type="CheckIn",
            resource_id=registration_id,
            event_id=event_id,
            details={"method": "RECOVERY"},
        )

        return success(
            {
                "registration_id": registration_id,
                "status": "CHECKED_IN",
                "checked_in_at": now.isoformat(),
                "message": "Check-in completed successfully.",
                "was_already_checked_in": False,
            },
            status_code=201,
        )
    else:
        # Already checked in — return existing data
        existing = repo.get_item(org_id, f"EVENT#{event_id}#CHECKIN#{registration_id}")
        return success(
            {
                "registration_id": registration_id,
                "status": "CHECKED_IN",
                "checked_in_at": existing.get("checked_in_at", "") if existing else "",
                "message": "Attendee was already checked in.",
                "was_already_checked_in": True,
            }
        )


# ---------------------------------------------------------------------------
# POST /events/{eventId}/checkin/verify-qr
# ---------------------------------------------------------------------------


def verify_qr_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Verify a QR code scanned at the venue.

    Server-side HMAC verification — the QR payload is recomputed and
    compared against the stored signature in the Ticket record.
    """
    body = _parse_body(event)
    event_id = _get_path_param(event, "eventId")
    org_id = body.get("organization_id", "")
    qr_payload = body.get("qr_payload", "")

    if not all([org_id, event_id, qr_payload]):
        return error(
            ErrorCategory.VALIDATION_ERROR, "organization_id, eventId, and qr_payload are required"
        )

    denied = authorize_organization(event, org_id)
    if denied:
        return denied

    try:
        payload_data = json.loads(qr_payload)
    except json.JSONDecodeError:
        return error(ErrorCategory.VALIDATION_ERROR, "Invalid QR payload format")

    registration_id = payload_data.get("r", "")
    payload_event_id = payload_data.get("e", "")
    payload_org_id = payload_data.get("o", "")

    if payload_event_id != event_id or payload_org_id != org_id:
        return error(ErrorCategory.VALIDATION_ERROR, "QR code does not belong to this event")

    if not registration_id:
        return error(ErrorCategory.VALIDATION_ERROR, "QR payload missing registration reference")

    # Fetch the ticket to get the stored signature
    repo = DynamoDBRepository(MAIN_TABLE)
    ticket = repo.get_item(org_id, f"EVENT#{event_id}#TICKET#{registration_id}")

    if not ticket:
        return error(ErrorCategory.NOT_FOUND, "No ticket found for this registration")

    stored_signature = ticket.get("qr_signature", "")
    if not verify_qr_signature(qr_payload, stored_signature):
        return error(ErrorCategory.FORBIDDEN, "QR verification failed — signature mismatch")

    return success(
        {
            "valid": True,
            "registration_id": registration_id,
            "attendee_name": ticket.get("attendee_name", ""),
            "ticket_status": ticket.get("status", ""),
            "message": "QR code verified successfully.",
        }
    )
