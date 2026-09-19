"""Tests for ticket generation and QR signing.

Covers: QR payload creation, HMAC signing, signature verification,
QR image generation, and PDF generation.
"""

import json

from services.checkin.ticket_service import (
    generate_qr_image,
    generate_qr_payload,
    generate_ticket_pdf,
    verify_qr_signature,
)


class TestQRSigning:
    """QR code HMAC signing and verification."""

    def test_generate_payload_returns_valid_json(self) -> None:
        payload, signature = generate_qr_payload("REG-2026-001", "EVT-001", "ORG-001")
        data = json.loads(payload)
        assert data["r"] == "REG-2026-001"
        assert data["e"] == "EVT-001"
        assert data["o"] == "ORG-001"
        assert data["v"] == 1
        assert "t" in data

    def test_signature_is_hex_string(self) -> None:
        _, signature = generate_qr_payload("REG-001", "EVT-001", "ORG-001")
        assert len(signature) == 64  # SHA256 hex digest
        int(signature, 16)  # Should be valid hex

    def test_verify_valid_signature(self) -> None:
        payload, signature = generate_qr_payload("REG-001", "EVT-001", "ORG-001")
        assert verify_qr_signature(payload, signature)

    def test_verify_tampered_payload(self) -> None:
        """Modifying the payload after signing must fail verification."""
        payload, signature = generate_qr_payload("REG-001", "EVT-001", "ORG-001")
        tampered = payload.replace("REG-001", "REG-002")
        assert not verify_qr_signature(tampered, signature)

    def test_verify_wrong_signature(self) -> None:
        payload, _ = generate_qr_payload("REG-001", "EVT-001", "ORG-001")
        assert not verify_qr_signature(payload, "a" * 64)

    def test_verify_empty_signature(self) -> None:
        payload, _ = generate_qr_payload("REG-001", "EVT-001", "ORG-001")
        assert not verify_qr_signature(payload, "")

    def test_different_registrations_produce_different_signatures(self) -> None:
        _, sig1 = generate_qr_payload("REG-001", "EVT-001", "ORG-001")
        _, sig2 = generate_qr_payload("REG-002", "EVT-001", "ORG-001")
        assert sig1 != sig2


class TestQRImageGeneration:
    """QR code image output."""

    def test_generates_png_bytes(self) -> None:
        payload, _ = generate_qr_payload("REG-001", "EVT-001", "ORG-001")
        png_bytes = generate_qr_image(payload)
        assert isinstance(png_bytes, bytes)
        assert len(png_bytes) > 100
        # PNG magic bytes
        assert png_bytes[:4] == b"\x89PNG"


class TestPDFGeneration:
    """PDF ticket output."""

    def test_generates_pdf_bytes(self) -> None:
        payload, _ = generate_qr_payload("REG-001", "EVT-001", "ORG-001")
        qr_png = generate_qr_image(payload)
        pdf_bytes = generate_ticket_pdf(
            registration_id="REG-2026-004821",
            attendee_name="Priya Sharma",
            event_name="DevCon Bengaluru 2026",
            event_date="2026-10-15",
            venue="NIMHANS Convention Centre",
            qr_png_bytes=qr_png,
        )
        assert isinstance(pdf_bytes, bytes)
        assert len(pdf_bytes) > 500
        # PDF magic bytes
        assert pdf_bytes[:5] == b"%PDF-"

    def test_pdf_is_valid_and_non_trivial(self) -> None:
        """PDF should be a valid, non-trivial document (text is compressed in streams)."""
        payload, _ = generate_qr_payload("REG-UNIQUE-123", "EVT-001", "ORG-001")
        qr_png = generate_qr_image(payload)
        pdf_bytes = generate_ticket_pdf(
            registration_id="REG-UNIQUE-123",
            attendee_name="Test User",
            event_name="Test Event",
            event_date="2026-10-15",
            venue="Test Venue",
            qr_png_bytes=qr_png,
        )
        # ReportLab compresses text streams, so we verify structure instead
        assert pdf_bytes.startswith(b"%PDF-")
        assert b"endobj" in pdf_bytes
        assert b"%%EOF" in pdf_bytes
        # PDF should contain image data (the QR code)
        assert b"/Subtype /Image" in pdf_bytes
