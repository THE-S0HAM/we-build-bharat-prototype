"""Tests for input validation and sanitization."""

import pytest

from services.shared.validation import (
    mask_email,
    mask_phone,
    sanitize_name,
    sanitize_text,
    validate_email,
    validate_event_id,
    validate_org_id,
    validate_phone,
    validate_registration_id,
    validate_search_input,
    safe_log_context,
)


class TestRegistrationIdValidation:
    def test_valid_id(self) -> None:
        assert validate_registration_id("REG-2026-004821") == "REG-2026-004821"

    def test_valid_id_with_whitespace(self) -> None:
        assert validate_registration_id("  REG-2026-004821  ") == "REG-2026-004821"

    def test_rejects_empty(self) -> None:
        assert validate_registration_id("") is None

    def test_rejects_sql_injection(self) -> None:
        assert validate_registration_id("REG-2026-001; DROP TABLE") is None

    def test_rejects_wrong_format(self) -> None:
        assert validate_registration_id("INVALID-ID") is None

    def test_rejects_too_short(self) -> None:
        assert validate_registration_id("REG-20-1") is None


class TestEmailValidation:
    def test_valid_email(self) -> None:
        assert validate_email("priya@example.com") == "priya@example.com"

    def test_normalizes_to_lowercase(self) -> None:
        assert validate_email("Priya@Example.COM") == "priya@example.com"

    def test_rejects_empty(self) -> None:
        assert validate_email("") is None

    def test_rejects_no_at(self) -> None:
        assert validate_email("not-an-email") is None

    def test_rejects_script_injection(self) -> None:
        assert validate_email("<script>alert(1)</script>@evil.com") is None


class TestPhoneValidation:
    def test_valid_phone(self) -> None:
        assert validate_phone("+919876543210") == "+919876543210"

    def test_rejects_letters(self) -> None:
        assert validate_phone("not-a-phone") is None

    def test_rejects_too_short(self) -> None:
        assert validate_phone("123") is None


class TestSanitization:
    def test_name_truncation(self) -> None:
        long_name = "A" * 500
        assert len(sanitize_name(long_name)) == 200

    def test_text_truncation(self) -> None:
        long_text = "B" * 10000
        assert len(sanitize_text(long_text)) == 5000

    def test_strips_whitespace(self) -> None:
        assert sanitize_name("  Priya Sharma  ") == "Priya Sharma"


class TestMasking:
    def test_mask_email(self) -> None:
        assert mask_email("priya.sharma@example.com") == "p***@example.com"

    def test_mask_short_email(self) -> None:
        assert mask_email("p@example.com") == "p***@example.com"

    def test_mask_empty_email(self) -> None:
        assert mask_email("") == "***"

    def test_mask_phone(self) -> None:
        assert mask_phone("+919876543210") == "+91****3210"

    def test_mask_short_phone(self) -> None:
        assert mask_phone("12") == "***"


class TestSearchInputValidation:
    def test_valid_registration_id(self) -> None:
        result = validate_search_input({"registration_id": "REG-2026-004821"})
        assert result == ("registration_id", "REG-2026-004821")

    def test_valid_email(self) -> None:
        result = validate_search_input({"email": "priya@example.com"})
        assert result == ("email", "priya@example.com")

    def test_invalid_registration_id(self) -> None:
        result = validate_search_input({"registration_id": "INVALID"})
        assert result is None

    def test_empty_input(self) -> None:
        result = validate_search_input({})
        assert result is None

    def test_name_too_short(self) -> None:
        result = validate_search_input({"name": "A"})
        assert result is None

    def test_valid_name(self) -> None:
        result = validate_search_input({"name": "Priya"})
        assert result == ("name", "Priya")


class TestSafeLogContext:
    def test_excludes_pii(self) -> None:
        ctx = safe_log_context(
            organization_id="ORG-001",
            event_id="EVT-001",
            email="priya@example.com",
            attendee_name="Priya Sharma",
        )
        assert "email" not in ctx
        assert "attendee_name" not in ctx
        assert ctx["organization_id"] == "ORG-001"

    def test_includes_safe_fields(self) -> None:
        ctx = safe_log_context(
            organization_id="ORG-001",
            action="CHECKIN_COMPLETED",
            registration_id="REG-001",
        )
        assert ctx["action"] == "CHECKIN_COMPLETED"
        assert ctx["registration_id"] == "REG-001"
