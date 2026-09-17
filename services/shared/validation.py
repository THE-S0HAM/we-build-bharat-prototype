"""Input validation and sanitization for API boundaries.

All input from API Gateway events is untrusted. These utilities
provide consistent validation at the handler level so that
downstream services can trust their inputs.
"""

from __future__ import annotations

import re
from typing import Any


# Safe patterns for identifiers — reject anything that doesn't match
REGISTRATION_ID_PATTERN = re.compile(r"^REG-\d{4}-\d{4,8}$")
EVENT_ID_PATTERN = re.compile(r"^EVT-[a-zA-Z0-9-]{3,40}$")
ORG_ID_PATTERN = re.compile(r"^ORG-[a-zA-Z0-9-]{2,40}$")
SPEAKER_ID_PATTERN = re.compile(r"^SPK-[a-zA-Z0-9]{3,20}$")
TASK_ID_PATTERN = re.compile(r"^TSK-[a-zA-Z0-9]{3,20}$")
TEAM_ID_PATTERN = re.compile(r"^TEAM-[a-zA-Z0-9-]{2,40}$")
APPROVAL_ID_PATTERN = re.compile(r"^APR-[a-zA-Z0-9]{3,20}$")
INCIDENT_ID_PATTERN = re.compile(r"^INC-[a-zA-Z0-9]{3,20}$")
TRANSACTION_ID_PATTERN = re.compile(r"^TXN-[a-zA-Z0-9-]{3,40}$")
EMAIL_PATTERN = re.compile(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")
PHONE_PATTERN = re.compile(r"^\+?[0-9\s-]{7,20}$")

# Max lengths to prevent oversized payloads
MAX_NAME_LENGTH = 200
MAX_DESCRIPTION_LENGTH = 5000
MAX_SEARCH_VALUE_LENGTH = 200
MAX_NOTES_LENGTH = 2000


def validate_registration_id(value: str) -> str | None:
    """Returns cleaned value if valid, None if invalid."""
    value = value.strip()
    if REGISTRATION_ID_PATTERN.match(value):
        return value
    return None


def validate_event_id(value: str) -> str | None:
    value = value.strip()
    if EVENT_ID_PATTERN.match(value):
        return value
    return None


def validate_org_id(value: str) -> str | None:
    value = value.strip()
    if ORG_ID_PATTERN.match(value):
        return value
    return None


def validate_email(value: str) -> str | None:
    value = value.strip().lower()
    if len(value) <= MAX_SEARCH_VALUE_LENGTH and EMAIL_PATTERN.match(value):
        return value
    return None


def validate_phone(value: str) -> str | None:
    value = value.strip()
    if len(value) <= 20 and PHONE_PATTERN.match(value):
        return value
    return None


def sanitize_name(value: str) -> str:
    """Strip and truncate a name field. Allows unicode for international names."""
    return value.strip()[:MAX_NAME_LENGTH]


def sanitize_text(value: str, max_length: int = MAX_DESCRIPTION_LENGTH) -> str:
    """Strip and truncate a free-text field."""
    return value.strip()[:max_length]


def validate_search_input(body: dict[str, Any]) -> tuple[str, str] | None:
    """Validate check-in search input. Returns (search_type, cleaned_value) or None.

    Rejects malformed identifiers to prevent injection or unexpected
    DynamoDB key construction.
    """
    if body.get("registration_id"):
        cleaned = validate_registration_id(body["registration_id"])
        if cleaned:
            return ("registration_id", cleaned)
        return None

    if body.get("email"):
        cleaned = validate_email(body["email"])
        if cleaned:
            return ("email", cleaned)
        return None

    if body.get("phone"):
        cleaned = validate_phone(body["phone"])
        if cleaned:
            return ("phone", cleaned)
        return None

    if body.get("name"):
        name = sanitize_name(body["name"])
        if len(name) >= 2:  # Minimum 2 chars for name search
            return ("name", name)
        return None

    return None


def mask_email(email: str) -> str:
    """Mask an email for display: j***@example.com."""
    if not email or "@" not in email:
        return "***"
    local, domain = email.split("@", 1)
    if len(local) <= 1:
        return f"{local}***@{domain}"
    return f"{local[0]}***@{domain}"


def mask_phone(phone: str) -> str:
    """Mask a phone for display: +91****3210."""
    if not phone or len(phone) < 4:
        return "***"
    return phone[:3] + "****" + phone[-4:]


def safe_log_context(
    *,
    organization_id: str = "",
    event_id: str = "",
    registration_id: str = "",
    action: str = "",
    **extra: Any,
) -> dict[str, Any]:
    """Build a log-safe context dict. No PII, no secrets.

    Use this as the `extra` parameter for structured logging.
    """
    ctx: dict[str, Any] = {}
    if organization_id:
        ctx["organization_id"] = organization_id
    if event_id:
        ctx["event_id"] = event_id
    if registration_id:
        ctx["registration_id"] = registration_id
    if action:
        ctx["action"] = action
    # Add extra fields but exclude known PII keys
    pii_keys = {"email", "phone", "attendee_email", "attendee_phone", "payer_email", "name", "attendee_name"}
    for k, v in extra.items():
        if k not in pii_keys:
            ctx[k] = v
    return ctx
