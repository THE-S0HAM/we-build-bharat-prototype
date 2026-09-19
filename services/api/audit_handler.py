"""Audit log read handler.

Route: GET /events/{eventId}/audit
"""

from __future__ import annotations

import logging
import os
from typing import Any

from services.shared.api_response import error, success
from services.shared.dynamodb import DynamoDBRepository
from services.shared.models.base import ErrorCategory
from services.shared.tenancy import authorize_organization

logger = logging.getLogger(__name__)
AUDIT_TABLE = os.environ.get("AUDIT_TABLE", "CommunityOps-Audit-dev")


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """List audit events for an event, ordered by most recent."""
    path_params = event.get("pathParameters") or {}
    event_id = path_params.get("eventId", "")
    params = event.get("queryStringParameters") or {}
    org_id = params.get("organization_id", "")

    if not org_id or not event_id:
        return error(ErrorCategory.VALIDATION_ERROR, "organization_id and eventId are required")

    denied = authorize_organization(event, org_id)
    if denied:
        return denied

    limit = min(int(params.get("limit", "50")), 200)

    repo = DynamoDBRepository(AUDIT_TABLE)
    items = repo.query_gsi(
        index_name="GSI1",
        pk_value=f"{org_id}#{event_id}",
        sk_begins_with="",
        limit=limit,
    )

    # Sort by timestamp descending for the timeline view
    items.sort(key=lambda x: x.get("timestamp", ""), reverse=True)

    return success({"audit_events": items, "count": len(items)})
