"""Input validation and sanitization for API boundaries.

All input from API Gateway events is untrusted. These utilities
provide consistent validation at the handler level so that
downstream services can trust their inputs.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
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
EXPENSE_ID_PATTERN = re.compile(r"^EXP-[a-zA-Z0-9]{3,20}$")
COMMENT_ID_PATTERN = re.compile(r"^CMT-[a-zA-Z0-9]{3,20}$")
DOCUMENT_ID_PATTERN = re.compile(r"^DOC-[a-zA-Z0-9]{3,20}$")
NOTIFICATION_ID_PATTERN = re.compile(r"^NTF-[a-zA-Z0-9]{3,20}$")
ACTIVITY_ID_PATTERN = re.compile(r"^ACT-[a-zA-Z0-9]{3,20}$")
SESSION_ID_PATTERN = re.compile(r"^[a-zA-Z0-9-]{8,64}$")
# Cognito subject identifiers are UUIDs, but demo and system actors use readable ids,
# so the pattern is permissive about form while still rejecting anything that could
# break out of a sort key.
USER_ID_PATTERN = re.compile(r"^[a-zA-Z0-9._@:-]{1,128}$")

EMAIL_PATTERN = re.compile(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")
PHONE_PATTERN = re.compile(r"^\+?[0-9\s-]{7,20}$")

# Max lengths to prevent oversized payloads
MAX_NAME_LENGTH = 200
MAX_DESCRIPTION_LENGTH = 5000
MAX_SEARCH_VALUE_LENGTH = 200
MAX_NOTES_LENGTH = 2000
MAX_COMMENT_LENGTH = 5000
MAX_CHAT_MESSAGE_LENGTH = 4000

# A single event's budget ceiling. Large enough for any real community event, small
# enough that a fat-fingered or hostile amount is rejected rather than stored.
MAX_BUDGET_AMOUNT_INR = 100_000_000


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
    pii_keys = {
        "email",
        "phone",
        "attendee_email",
        "attendee_phone",
        "payer_email",
        "name",
        "attendee_name",
    }
    for k, v in extra.items():
        if k not in pii_keys:
            ctx[k] = v
    return ctx


# ---------------------------------------------------------------------------
# Identifier validators for the operations domain
# ---------------------------------------------------------------------------


def _match(pattern: re.Pattern[str], value: str) -> str | None:
    """Shared body for the identifier validators: clean, match, or reject."""
    cleaned = (value or "").strip()
    return cleaned if pattern.match(cleaned) else None


def validate_speaker_id(value: str) -> str | None:
    return _match(SPEAKER_ID_PATTERN, value)


def validate_task_id(value: str) -> str | None:
    return _match(TASK_ID_PATTERN, value)


def validate_team_id(value: str) -> str | None:
    return _match(TEAM_ID_PATTERN, value)


def validate_approval_id(value: str) -> str | None:
    return _match(APPROVAL_ID_PATTERN, value)


def validate_incident_id(value: str) -> str | None:
    return _match(INCIDENT_ID_PATTERN, value)


def validate_expense_id(value: str) -> str | None:
    return _match(EXPENSE_ID_PATTERN, value)


def validate_comment_id(value: str) -> str | None:
    return _match(COMMENT_ID_PATTERN, value)


def validate_document_id(value: str) -> str | None:
    return _match(DOCUMENT_ID_PATTERN, value)


def validate_notification_id(value: str) -> str | None:
    return _match(NOTIFICATION_ID_PATTERN, value)


def validate_session_id(value: str) -> str | None:
    return _match(SESSION_ID_PATTERN, value)


def validate_user_id(value: str) -> str | None:
    """Validate a user identifier that will be embedded in a sort key.

    User ids become part of ``USER#{userId}#...`` sort keys, so a value containing ``#``
    could place a record in a different logical partition than intended. The pattern
    excludes ``#`` for that reason.
    """
    return _match(USER_ID_PATTERN, value)


def validate_enum_value(value: str, allowed: set[str]) -> str | None:
    """Accept a value only if it is a member of a known enum.

    Handlers use explicit field whitelists for updates, but a whitelisted field can
    still carry a nonsense value. Status and category fields drive index sort keys and
    the health engine, so an unrecognised value would produce records that queries never
    return and scores that silently ignore them.
    """
    cleaned = (value or "").strip().upper()
    return cleaned if cleaned in allowed else None


# ---------------------------------------------------------------------------
# Money
# ---------------------------------------------------------------------------


def validate_amount_inr(value: Any) -> int | None:
    """Coerce an untrusted monetary amount to whole rupees, or reject it.

    Money is integer rupees throughout CommunityOps. This accepts ints, numeric strings
    and ``Decimal`` values that are whole numbers, and rejects negatives, fractions,
    non-numeric input and anything above the per-event ceiling.

    Fractional input is rejected rather than rounded: silently turning ``12500.60`` into
    ``12501`` would make the recorded figure differ from the one the requester typed,
    and budget arithmetic that disagrees with its own paperwork is worse than an error.
    """
    if isinstance(value, bool):
        return None
    try:
        as_decimal = Decimal(str(value).strip())
    except (InvalidOperation, ValueError, AttributeError):
        return None
    if as_decimal != as_decimal.to_integral_value():
        return None
    amount = int(as_decimal)
    if amount < 0 or amount > MAX_BUDGET_AMOUNT_INR:
        return None
    return amount


def coerce_int(value: Any, default: int = 0) -> int:
    """Read a DynamoDB number back as a plain ``int``.

    boto3 deserializes every DynamoDB Number as ``Decimal``. Arithmetic mixing
    ``Decimal`` and ``int`` works, but the values leak into JSON responses and audit
    details where ``Decimal`` is not serializable, so they are coerced at the read
    boundary instead of being handled at every use site.
    """
    if value is None:
        return default
    try:
        return int(Decimal(str(value)))
    except (InvalidOperation, ValueError, TypeError):
        return default


def format_inr(amount: int) -> str:
    """Format whole rupees in the Indian digit grouping, e.g. 250000 -> '2,50,000'.

    Used for human-readable strings such as an approval's budget impact. The grouping
    is last three digits, then pairs, which ``format(n, ',')`` does not produce.
    """
    negative = amount < 0
    digits = str(abs(amount))
    if len(digits) <= 3:
        grouped = digits
    else:
        head, tail = digits[:-3], digits[-3:]
        pairs = []
        while len(head) > 2:
            pairs.insert(0, head[-2:])
            head = head[:-2]
        if head:
            pairs.insert(0, head)
        grouped = ",".join([*pairs, tail])
    return f"-{grouped}" if negative else grouped
