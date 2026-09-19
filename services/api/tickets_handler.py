"""Admin ticketing: verify the transaction, then issue the ticket.

Routes:
    GET  /events/{eventId}/tickets                                    issued tickets   (leader)
    GET  /events/{eventId}/tickets/{registrationId}                    one ticket        (leader)
    POST /events/{eventId}/tickets/{registrationId}/verify-transaction  check the payment (leader)
    POST /events/{eventId}/tickets/{registrationId}/issue               issue or reissue  (leader)
    POST /events/{eventId}/tickets/{registrationId}/revoke              revoke            (leader)

The volunteer-facing recovery flow lives in :mod:`services.checkin.handlers`. This is the
admin side: an organiser looking at a registration, confirming the money actually arrived, and
issuing the ticket.

Payment truth is deterministic
------------------------------
``verify-transaction`` reads the payment record and compares it against the registration. No
model is involved and none could be: whether a payment was captured is a fact in a table, and
an agent asserting it from context would be inventing the one thing nobody can afford to have
invented. The agent can prepare and explain; the status comes from here.

Issuing is idempotent
---------------------
``ticket_id == registration_id``, always. Re-issuing refreshes the download link and increments
a counter rather than minting a second ticket, because two tickets for one registration is a
gate-level dispute nobody can settle.
"""

from __future__ import annotations

import logging
from typing import Any

from services.api._common import begin_request, handle_dynamodb_errors, path_param
from services.shared.api_response import error, success
from services.shared.audit import create_audit_event
from services.shared.keys import (
    event_gsi1pk,
    event_sk,
    registration_sk,
    ticket_prefix,
    ticket_sk,
)
from services.shared.models.base import ErrorCategory, utc_now
from services.shared.principal import Role
from services.shared.validation import coerce_int, mask_email, sanitize_text

logger = logging.getLogger(__name__)

# Payment states that permit a ticket. NOT_REQUIRED covers free events, where insisting on a
# captured payment would make free registration impossible to ticket.
ISSUABLE_PAYMENT_STATUSES = frozenset({"CAPTURED", "NOT_REQUIRED"})
ISSUABLE_REGISTRATION_STATUSES = frozenset({"CONFIRMED"})


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    method = event.get("httpMethod", "GET")
    event_id = path_param(event, "eventId")
    registration_id = path_param(event, "registrationId")
    path = str(event.get("resource") or event.get("path") or "")

    if method == "POST":
        if path.endswith("/verify-transaction"):
            return verify_transaction(event, event_id, registration_id)
        if path.endswith("/issue"):
            return issue_ticket(event, event_id, registration_id)
        if path.endswith("/revoke"):
            return revoke_ticket(event, event_id, registration_id)
        return error(ErrorCategory.VALIDATION_ERROR, "Unsupported ticket operation")

    if method == "GET" and registration_id:
        return get_ticket(event, event_id, registration_id)
    if method == "GET":
        return list_tickets(event, event_id)

    return error(ErrorCategory.VALIDATION_ERROR, "Unsupported operation")


@handle_dynamodb_errors
def list_tickets(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    tickets = ctx.repo.query_all(ctx.organization_id, ticket_prefix(event_id), max_items=1000)
    tickets.sort(key=lambda t: str(t.get("created_at", "")), reverse=True)

    shaped = [
        {
            "ticket_id": t.get("ticket_id"),
            "registration_id": t.get("registration_id"),
            "attendee_name": t.get("attendee_name"),
            # Masked in the list view: an organiser scanning issued tickets does not need every
            # attendee's address on screen, and the detail view has it when they do.
            "attendee_email": mask_email(str(t.get("attendee_email", ""))),
            "status": t.get("status"),
            "generated_count": coerce_int(t.get("generated_count"), 1),
            "created_at": t.get("created_at"),
            "revoked_at": t.get("revoked_at"),
        }
        for t in tickets
    ]
    return success(
        {
            "tickets": shaped,
            "count": len(shaped),
            "active_count": sum(1 for t in shaped if t["status"] == "ACTIVE"),
            "revoked_count": sum(1 for t in shaped if t["status"] == "REVOKED"),
            "reissued_count": sum(1 for t in shaped if int(t["generated_count"]) > 1),
        }
    )


@handle_dynamodb_errors
def get_ticket(event: dict[str, Any], event_id: str, registration_id: str) -> dict[str, Any]:
    """One ticket with a fresh download link."""
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    ticket = ctx.repo.get_item(ctx.organization_id, ticket_sk(event_id, registration_id))
    if not ticket:
        return error(ErrorCategory.NOT_FOUND, "No ticket has been issued for that registration")

    download_url = None
    if s3_key := str(ticket.get("s3_key", "")):
        try:
            from services.checkin.ticket_service import get_presigned_url

            download_url = get_presigned_url(s3_key)
        except Exception:  # noqa: BLE001 - the metadata is still useful without a link
            logger.warning("Could not refresh the ticket download link", exc_info=True)

    return success({"ticket": ticket, "download_url": download_url})


@handle_dynamodb_errors
def verify_transaction(
    event: dict[str, Any], event_id: str, registration_id: str
) -> dict[str, Any]:
    """Check the payment behind a registration, deterministically.

    Returns a list of named checks rather than a single verdict, so the organiser can see which
    condition failed. "Not eligible" is not actionable; "the payment is PENDING, not CAPTURED"
    tells them exactly what to chase.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    registration = ctx.repo.get_item(
        ctx.organization_id, registration_sk(event_id, registration_id)
    )
    if not registration:
        return error(ErrorCategory.NOT_FOUND, "Registration not found")

    from services.shared.connectors_dynamodb import DynamoDBPaymentConnector

    payment_reference = str(registration.get("payment_reference", ""))
    payment: dict[str, Any] | None = None
    payment_system_available = True

    if payment_reference:
        result = DynamoDBPaymentConnector(ctx.repo.table_name).lookup_by_transaction_id(
            ctx.organization_id, event_id, payment_reference
        )
        if not result.success:
            # The distinction that matters: an unreachable payment system is not the same as an
            # absent payment, and reporting the first as the second would deny a paid attendee.
            payment_system_available = False
        elif result.data:
            payment = result.data[0]

    registration_status = str(registration.get("status", ""))
    payment_status = str(registration.get("payment_status", ""))

    checks = [
        {
            "name": "registration_exists",
            "status": "PASS",
            "message": "Registration record found",
        },
        {
            "name": "registration_confirmed",
            "status": "PASS" if registration_status in ISSUABLE_REGISTRATION_STATUSES else "FAIL",
            "message": f"Registration status is {registration_status or 'unknown'}",
        },
        {
            "name": "payment_status",
            "status": "PASS" if payment_status in ISSUABLE_PAYMENT_STATUSES else "FAIL",
            "message": (
                "No payment required for this registration"
                if payment_status == "NOT_REQUIRED"
                else f"Payment status is {payment_status or 'unknown'}"
            ),
        },
    ]

    if payment_reference:
        if not payment_system_available:
            checks.append(
                {
                    "name": "transaction_record",
                    "status": "WARN",
                    "message": (
                        "The payment system could not be reached, so the transaction could not "
                        "be verified. This is not the same as the payment being missing."
                    ),
                }
            )
        elif payment is None:
            checks.append(
                {
                    "name": "transaction_record",
                    "status": "FAIL",
                    "message": f"No payment record found for {payment_reference}",
                }
            )
        else:
            linked = str(payment.get("registration_id", "")) == registration_id
            checks.append(
                {
                    "name": "transaction_record",
                    "status": "PASS" if linked else "FAIL",
                    "message": (
                        f"Transaction {payment_reference} found, "
                        f"{payment.get('amount', 'amount unknown')} "
                        f"{payment.get('currency', 'INR')}, status {payment.get('status')}"
                        if linked
                        else f"Transaction {payment_reference} is linked to a different "
                        "registration"
                    ),
                }
            )
    elif payment_status != "NOT_REQUIRED":
        checks.append(
            {
                "name": "transaction_record",
                "status": "WARN",
                "message": "No payment reference is recorded on this registration",
            }
        )

    all_passed = all(c["status"] == "PASS" for c in checks)
    verified = all_passed and payment_system_available

    create_audit_event(
        organization_id=ctx.organization_id,
        action="TRANSACTION_VERIFIED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Registration",
        resource_id=registration_id,
        event_id=event_id,
        details={
            "verified": verified,
            "failed_checks": [c["name"] for c in checks if c["status"] == "FAIL"],
            "payment_system_available": payment_system_available,
        },
        outcome="success" if verified else "failure",
    )

    return success(
        {
            "registration_id": registration_id,
            "verified": verified,
            "can_issue_ticket": verified,
            "checks": checks,
            "registration": {
                "attendee_name": registration.get("attendee_name"),
                "attendee_email": registration.get("attendee_email"),
                "status": registration_status,
                "payment_status": payment_status,
                "payment_reference": payment_reference or None,
                "ticket_type": registration.get("ticket_type"),
                "is_checked_in": bool(registration.get("is_checked_in")),
            },
            "payment": payment,
            "payment_system_available": payment_system_available,
        }
    )


@handle_dynamodb_errors
def issue_ticket(event: dict[str, Any], event_id: str, registration_id: str) -> dict[str, Any]:
    """Issue a ticket, or refresh an existing one.

    Verification is re-run here rather than trusting that the caller already checked: the
    verify call and the issue call are separate requests, and state can change between them.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    registration = ctx.repo.get_item(
        ctx.organization_id, registration_sk(event_id, registration_id)
    )
    if not registration:
        return error(ErrorCategory.NOT_FOUND, "Registration not found")

    registration_status = str(registration.get("status", ""))
    payment_status = str(registration.get("payment_status", ""))
    if registration_status not in ISSUABLE_REGISTRATION_STATUSES:
        return error(
            ErrorCategory.CONFLICT,
            f"This registration is {registration_status}, so a ticket cannot be issued.",
        )
    if payment_status not in ISSUABLE_PAYMENT_STATUSES:
        return error(
            ErrorCategory.CONFLICT,
            f"Payment is {payment_status}. Verify the transaction before issuing a ticket.",
        )

    sk = ticket_sk(event_id, registration_id)
    existing = ctx.repo.get_item(ctx.organization_id, sk)

    if existing and str(existing.get("status")) == "REVOKED":
        return error(
            ErrorCategory.CONFLICT,
            "This ticket was revoked. Reinstating it is a deliberate act — revoke the "
            "revocation first if that is intended.",
        )

    event_record = ctx.repo.get_item(ctx.organization_id, event_sk(event_id)) or {}

    try:
        from services.checkin.ticket_service import generate_ticket, get_presigned_url
    except ImportError:
        logger.error("Ticket generation dependencies are unavailable", exc_info=True)
        return error(
            ErrorCategory.INTERNAL_ERROR, "Ticket generation is not available on this deployment."
        )

    now = utc_now().isoformat()

    if existing:
        # Idempotent reissue: same ticket identity, fresh link, counter advanced. Minting a new
        # ticket would create two valid tickets for one registration.
        try:
            download_url = get_presigned_url(str(existing.get("s3_key", "")))
        except Exception:  # noqa: BLE001
            logger.warning("Could not refresh the download link", exc_info=True)
            download_url = None

        ctx.repo.atomic_update(
            ctx.organization_id,
            sk,
            adds={"generated_count": 1},
            sets={"updated_at": now, "updated_by": ctx.user_id},
        )
        create_audit_event(
            organization_id=ctx.organization_id,
            action="TICKET_REISSUED",
            actor_type=ctx.actor_type,
            actor_id=ctx.user_id,
            resource_type="Ticket",
            resource_id=registration_id,
            event_id=event_id,
            details={"generated_count": coerce_int(existing.get("generated_count"), 1) + 1},
            policy_evaluated="GenerateTicket",
        )
        return success(
            {
                "ticket_id": registration_id,
                "registration_id": registration_id,
                "already_existed": True,
                "download_url": download_url,
                "message": "Ticket already existed; the download link has been refreshed.",
            }
        )

    try:
        ticket = generate_ticket(
            organization_id=ctx.organization_id,
            event_id=event_id,
            registration_id=registration_id,
            attendee_name=str(registration.get("attendee_name", "")),
            attendee_email=str(registration.get("attendee_email", "")),
            event_name=str(event_record.get("name", "Event")),
            event_date=str(event_record.get("start_date", "")),
            venue=str(event_record.get("venue", "")),
        )
    except Exception:  # noqa: BLE001 - PDF, QR and S3 all fail the same way to the caller
        logger.error("Ticket generation failed", exc_info=True)
        return error(
            ErrorCategory.EXTERNAL_SERVICE_ERROR,
            "The ticket could not be generated. Please try again.",
        )

    ctx.repo.put_item(
        ctx.organization_id,
        sk,
        {
            "entity_type": "TICKET",
            "event_id": event_id,
            # The business rule, stated in the data: ticket identity is registration identity.
            "ticket_id": registration_id,
            "registration_id": registration_id,
            "attendee_name": registration.get("attendee_name", ""),
            "attendee_email": registration.get("attendee_email", ""),
            "status": "ACTIVE",
            "s3_key": ticket["s3_key"],
            "qr_signature": ticket["qr_signature"],
            "qr_payload": ticket["qr_payload"],
            "generated_count": 1,
            "issued_by": ctx.user_id,
            "created_at": now,
            "updated_at": now,
            "created_by": ctx.user_id,
            "updated_by": ctx.user_id,
            "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
            "GSI1SK": f"TICKET#{registration_id}",
        },
    )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="TICKET_ISSUED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Ticket",
        resource_id=registration_id,
        event_id=event_id,
        details={"payment_status": payment_status},
        policy_evaluated="GenerateTicket",
    )

    return success(
        {
            "ticket_id": registration_id,
            "registration_id": registration_id,
            "already_existed": False,
            "download_url": ticket["download_url"],
            "message": "Ticket issued with a signed QR code.",
        },
        status_code=201,
    )


@handle_dynamodb_errors
def revoke_ticket(event: dict[str, Any], event_id: str, registration_id: str) -> dict[str, Any]:
    """Revoke a ticket.

    A status change, not a delete. The QR code is already in somebody's possession, so the
    record has to survive in order to be *rejected* at the gate — deleting it would make the
    QR unrecognised rather than refused, which reads as a system fault instead of a revocation.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    reason = sanitize_text(str(ctx.body.get("reason", "")), 500)
    if not reason:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            "Revoking a ticket needs a reason; it is recorded on the audit trail.",
        )

    sk = ticket_sk(event_id, registration_id)
    existing = ctx.repo.get_item(ctx.organization_id, sk)
    if not existing:
        return error(ErrorCategory.NOT_FOUND, "No ticket has been issued for that registration")
    if str(existing.get("status")) == "REVOKED":
        return success({"ticket_id": registration_id, "message": "Ticket was already revoked"})

    now = utc_now().isoformat()
    ctx.repo.update_item(
        ctx.organization_id,
        sk,
        {
            "status": "REVOKED",
            "revoked_at": now,
            "revoked_by": ctx.user_id,
            "revocation_reason": reason,
            "updated_at": now,
            "updated_by": ctx.user_id,
        },
    )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="TICKET_REVOKED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Ticket",
        resource_id=registration_id,
        event_id=event_id,
        details={"reason": reason},
        policy_evaluated="RevokeTicket",
    )
    return success(
        {
            "ticket_id": registration_id,
            "status": "REVOKED",
            "message": "Ticket revoked. QR verification will now reject it.",
        }
    )
