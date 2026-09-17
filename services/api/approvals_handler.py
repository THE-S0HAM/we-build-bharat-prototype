"""Approvals handler — human-in-the-loop decision interface.

Routes: GET /events/{eventId}/approvals, PUT /events/{eventId}/approvals/{approvalId}
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from services.shared.api_response import error, success
from services.shared.audit import create_audit_event
from services.shared.dynamodb import DynamoDBRepository
from services.shared.models.base import ErrorCategory, utc_now

logger = logging.getLogger(__name__)
MAIN_TABLE = os.environ.get("MAIN_TABLE", "OrbitOps-Main-dev")


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    method = event.get("httpMethod", "GET")
    path_params = event.get("pathParameters") or {}
    event_id = path_params.get("eventId", "")
    approval_id = path_params.get("approvalId")

    if method == "GET":
        return _list_approvals(event, event_id)
    elif method == "PUT" and approval_id:
        return _decide_approval(event, event_id, approval_id)

    return error(ErrorCategory.VALIDATION_ERROR, "Unsupported operation")


def _get_org_id(event: dict[str, Any]) -> str:
    params = event.get("queryStringParameters") or {}
    if params.get("organization_id"):
        return params["organization_id"]
    body = event.get("body", "{}")
    if isinstance(body, str):
        body = json.loads(body) if body else {}
    return body.get("organization_id", "")


def _get_user_id(event: dict[str, Any]) -> str:
    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})
    return claims.get("sub", "anonymous")


def _list_approvals(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    org_id = _get_org_id(event)
    if not org_id or not event_id:
        return error(ErrorCategory.VALIDATION_ERROR, "organization_id and eventId are required")

    repo = DynamoDBRepository(MAIN_TABLE)
    items = repo.query_gsi(
        index_name="GSI1",
        pk_value=f"{org_id}#{event_id}",
        sk_begins_with="APPROVAL#PENDING",
    )
    return success({"approvals": items, "count": len(items)})


def _decide_approval(event: dict[str, Any], event_id: str, approval_id: str) -> dict[str, Any]:
    """Process an approval decision: APPROVED, DECLINED, or EDITED."""
    body = json.loads(event.get("body", "{}"))
    org_id = body.get("organization_id", "")
    user_id = _get_user_id(event)
    decision = body.get("decision", "").upper()

    if not org_id:
        return error(ErrorCategory.VALIDATION_ERROR, "organization_id is required")

    if decision not in ("APPROVED", "DECLINED", "EDITED"):
        return error(ErrorCategory.VALIDATION_ERROR, "decision must be APPROVED, DECLINED, or EDITED")

    repo = DynamoDBRepository(MAIN_TABLE)
    existing = repo.get_item(org_id, f"EVENT#{event_id}#APPROVAL#{approval_id}")
    if not existing:
        return error(ErrorCategory.NOT_FOUND, "Approval request not found")

    if existing.get("status") != "PENDING":
        return error(ErrorCategory.CONFLICT, f"Approval already {existing.get('status', 'processed')}")

    now = utc_now().isoformat()
    updates: dict[str, Any] = {
        "status": decision,
        "decided_by": user_id,
        "decided_at": now,
        "decision_notes": body.get("notes", ""),
        "updated_at": now,
    }

    if decision == "EDITED":
        updates["edited_action"] = body.get("edited_action", "")

    repo.update_item(org_id, f"EVENT#{event_id}#APPROVAL#{approval_id}", updates)

    create_audit_event(
        organization_id=org_id,
        action=f"APPROVAL_{decision}",
        actor_type="user",
        actor_id=user_id,
        resource_type="Approval",
        resource_id=approval_id,
        event_id=event_id,
        details={
            "decision": decision,
            "requested_action": existing.get("requested_action", ""),
            "risk_level": existing.get("risk_level", ""),
        },
    )

    return success({"approval_id": approval_id, "status": decision, "message": f"Approval {decision.lower()}"})
