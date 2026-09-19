"""Tenant authorization for API handlers.

The API accepts `organization_id` as a request parameter so that a single
operator can work across the organizations they belong to. That parameter is
caller-supplied and therefore untrusted: it must be checked against the
authenticated principal before any data access, otherwise any authenticated
user can read or mutate another tenant's records (IDOR).

Organization membership is carried in the Cognito ID token as group
membership (`cognito:groups`). Each organization has a Cognito group whose
name is the organization ID, and users are added to the groups for the
organizations they may access. Groups are used rather than a custom user-pool
attribute because groups require no schema change to an existing user pool.

Fail-closed: if the claim is missing, unreadable, or does not contain the
requested organization, access is denied.
"""

from __future__ import annotations

import logging
from typing import Any

from services.shared.api_response import error
from services.shared.models.base import ErrorCategory

logger = logging.getLogger(__name__)


def get_claims(event: dict[str, Any]) -> dict[str, Any]:
    """Extract Cognito authorizer claims from an API Gateway event."""
    return event.get("requestContext", {}).get("authorizer", {}).get("claims", {}) or {}


def get_user_id(event: dict[str, Any]) -> str:
    """Return the authenticated principal's subject identifier."""
    return get_claims(event).get("sub", "anonymous")


def get_caller_organizations(event: dict[str, Any]) -> set[str]:
    """Return the set of organization IDs the caller is a member of.

    API Gateway flattens the `cognito:groups` claim into a string. Depending on
    the integration it arrives as a bare value, a comma-separated list, or a
    bracketed space-separated list, so all three are parsed.
    """
    raw = get_claims(event).get("cognito:groups", "")

    if isinstance(raw, list):
        return {str(g).strip() for g in raw if str(g).strip()}

    if not isinstance(raw, str) or not raw.strip():
        return set()

    cleaned = raw.strip().strip("[]")
    parts = cleaned.replace(",", " ").split()
    return {p.strip() for p in parts if p.strip()}


def authorize_organization(event: dict[str, Any], organization_id: str) -> dict[str, Any] | None:
    """Check that the caller may act on `organization_id`.

    Returns None when access is permitted, or a ready-to-return API error
    response when it is not. Denials are logged with the caller's subject and
    the requested organization so cross-tenant attempts are auditable; no PII
    is included.
    """
    allowed = get_caller_organizations(event)

    if organization_id in allowed:
        return None

    logger.warning(
        "Cross-tenant access denied",
        extra={
            "user_id": get_user_id(event),
            "requested_organization_id": organization_id,
            "member_organization_count": len(allowed),
        },
    )
    return error(
        ErrorCategory.FORBIDDEN,
        "You are not authorized to access this organization's data.",
    )
