"""Ticket generation service.

Generates PDF tickets with HMAC-signed QR codes, stores them in S3,
and returns pre-signed URLs. Idempotent: regenerating a ticket for
the same registration returns the existing artifact (incrementing
generated_count for audit) rather than creating a duplicate.

QR Security:
- Payload is a JSON object with regId, eventId, orgId, timestamp
- Signed with HMAC-SHA256 using an event-scoped secret
- Verification recomputes the HMAC server-side
- No sensitive PII in the QR code itself
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import logging
import os
from datetime import UTC, datetime
from typing import Any

import boto3
import qrcode
from botocore.exceptions import ClientError
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

logger = logging.getLogger(__name__)

TICKET_BUCKET = os.environ.get("TICKET_BUCKET", "communityops-tickets-dev")
QR_SECRET_KEY = os.environ.get("QR_SECRET_KEY", "dev-secret-change-in-production")
PRESIGNED_URL_EXPIRY = int(os.environ.get("PRESIGNED_URL_EXPIRY", "3600"))


def generate_qr_payload(
    registration_id: str,
    event_id: str,
    organization_id: str,
) -> tuple[str, str]:
    """Create a signed QR payload.

    Returns (payload_json, hmac_signature).
    The QR code contains only the payload JSON. Verification requires
    recomputing the HMAC and comparing — the signature itself is stored
    server-side in the Ticket record, not in the QR code.

    This prevents attendees from forging QR codes: even if they know the
    payload structure, they can't produce a valid signature without the secret.
    """
    payload = {
        "r": registration_id,
        "e": event_id,
        "o": organization_id,
        "t": datetime.now(UTC).isoformat(),
        "v": 1,  # payload version for future compatibility
    }
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)

    signature = hmac.new(
        QR_SECRET_KEY.encode("utf-8"),
        payload_json.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    return payload_json, signature


def verify_qr_signature(payload_json: str, expected_signature: str) -> bool:
    """Server-side QR verification.

    Recomputes the HMAC from the payload and compares against the
    stored signature. Uses constant-time comparison to prevent
    timing attacks.
    """
    computed = hmac.new(
        QR_SECRET_KEY.encode("utf-8"),
        payload_json.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(computed, expected_signature)


def generate_qr_image(payload_json: str) -> bytes:
    """Generate QR code image as PNG bytes."""
    qr = qrcode.QRCode(version=1, box_size=10, border=4)
    qr.add_data(payload_json)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")

    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return buffer.getvalue()


def generate_ticket_pdf(
    registration_id: str,
    attendee_name: str,
    event_name: str,
    event_date: str,
    venue: str,
    qr_png_bytes: bytes,
) -> bytes:
    """Generate a clean, printable PDF ticket.

    Layout: event info at top, attendee details in the middle,
    QR code and registration ID at the bottom.
    """
    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=A4)
    width, height = A4

    # Title bar
    c.setFont("Helvetica-Bold", 22)
    c.drawCentredString(width / 2, height - 40 * mm, event_name)

    # Event details
    c.setFont("Helvetica", 12)
    c.drawCentredString(width / 2, height - 52 * mm, f"Date: {event_date}")
    c.drawCentredString(width / 2, height - 60 * mm, f"Venue: {venue}")

    # Divider
    c.setStrokeColorRGB(0.8, 0.8, 0.8)
    c.line(30 * mm, height - 68 * mm, width - 30 * mm, height - 68 * mm)

    # Attendee info
    c.setFont("Helvetica-Bold", 16)
    c.drawCentredString(width / 2, height - 82 * mm, attendee_name)

    c.setFont("Helvetica", 11)
    c.drawCentredString(width / 2, height - 92 * mm, f"Registration: {registration_id}")

    # QR code — write the PNG bytes to a temp image and draw it
    from reportlab.lib.utils import ImageReader

    qr_image = ImageReader(io.BytesIO(qr_png_bytes))
    qr_size = 50 * mm
    c.drawImage(
        qr_image,
        (width - qr_size) / 2,
        height - 155 * mm,
        width=qr_size,
        height=qr_size,
    )

    # Footer
    c.setFont("Helvetica", 9)
    c.setFillColorRGB(0.5, 0.5, 0.5)
    c.drawCentredString(
        width / 2, height - 165 * mm, "Present this QR code at the venue for check-in"
    )
    c.drawCentredString(width / 2, height - 172 * mm, "Powered by CommunityOps")

    c.showPage()
    c.save()
    return buffer.getvalue()


def upload_ticket_to_s3(
    organization_id: str,
    event_id: str,
    registration_id: str,
    pdf_bytes: bytes,
) -> str:
    """Upload ticket PDF to S3. Returns the S3 object key.

    Key format: {orgId}/{eventId}/tickets/{regId}.pdf
    """
    s3_key = f"{organization_id}/{event_id}/tickets/{registration_id}.pdf"
    try:
        s3 = boto3.client("s3")
        s3.put_object(
            Bucket=TICKET_BUCKET,
            Key=s3_key,
            Body=pdf_bytes,
            ContentType="application/pdf",
            Metadata={
                "organization_id": organization_id,
                "event_id": event_id,
                "registration_id": registration_id,
            },
        )
        logger.info(
            "Ticket uploaded to S3",
            extra={"s3_key": s3_key, "registration_id": registration_id},
        )
        return s3_key
    except ClientError:
        logger.error("Failed to upload ticket to S3", exc_info=True)
        raise


def get_presigned_url(s3_key: str, expiry: int | None = None) -> str:
    """Generate a pre-signed URL for ticket download.

    Short TTL by default — the volunteer can regenerate if it expires.
    """
    s3 = boto3.client("s3")
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": TICKET_BUCKET, "Key": s3_key},
        ExpiresIn=expiry or PRESIGNED_URL_EXPIRY,
    )


def generate_ticket(
    organization_id: str,
    event_id: str,
    registration_id: str,
    attendee_name: str,
    attendee_email: str,
    event_name: str,
    event_date: str,
    venue: str,
) -> dict[str, Any]:
    """Full ticket generation pipeline.

    1. Create signed QR payload
    2. Generate QR image
    3. Generate PDF
    4. Upload to S3
    5. Return metadata + pre-signed URL

    Idempotency is handled by the caller (Lambda handler) which checks
    whether a Ticket record already exists before calling this function.
    """
    # Step 1: Signed QR
    qr_payload, qr_signature = generate_qr_payload(registration_id, event_id, organization_id)

    # Step 2: QR image
    qr_png = generate_qr_image(qr_payload)

    # Step 3: PDF
    pdf_bytes = generate_ticket_pdf(
        registration_id=registration_id,
        attendee_name=attendee_name,
        event_name=event_name,
        event_date=event_date,
        venue=venue,
        qr_png_bytes=qr_png,
    )

    # Step 4: Upload
    s3_key = upload_ticket_to_s3(organization_id, event_id, registration_id, pdf_bytes)

    # Step 5: Pre-signed URL
    download_url = get_presigned_url(s3_key)

    return {
        "ticket_id": registration_id,  # Business rule: ticket ID = registration ID
        "registration_id": registration_id,
        "s3_key": s3_key,
        "qr_signature": qr_signature,
        "qr_payload": qr_payload,
        "download_url": download_url,
    }
