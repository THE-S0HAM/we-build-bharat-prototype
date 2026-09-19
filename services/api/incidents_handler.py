"""Incidents CRUD handler.

Routes: GET /events/{eventId}/incidents, POST /events/{eventId}/incidents,
        PUT /events/{eventId}/incidents/{incidentId}
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any

from services.shared.api_response import error, success
from services.shared.audit import create_audit_event
from services.shared.dynamodb import DynamoDBRepository
from services.shared.models.base import ErrorCategory, utc_now
from services.shared.tenancy import authorize_organization

logger = logging.getLogger(__name__)
MAIN_TABLE = os.environ.get("MAIN_TABLE", "CommunityOps-Main-dev")


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    method = event.get("httpMethod", "GET")
    path_params = event.get("pathParameters") or {}
    event_id = path_params.get("eventId", "")
    incident_id = path_params.get("incidentId")

    if method == "GET":
        return _list_incidents(event, event_id)
    elif method == "POST":
        return _create_incident(event, event_id)
    elif method == "PUT" and incident_id:
        return _update_incident(event, event_id, incident_id)

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


def _list_incidents(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    org_id = _get_org_id(event)
    if not org_id or not event_id:
        return error(ErrorCategory.VALIDATION_ERROR, "organization_id and eventId are required")

    denied = authorize_organization(event, org_id)
    if denied:
        return denied

    repo = DynamoDBRepository(MAIN_TABLE)
    items = repo.query_by_pk(org_id, f"EVENT#{event_id}#INCIDENT#", limit=50)
    return success({"incidents": items, "count": len(items)})


def _create_incident(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    body = json.loads(event.get("body", "{}"))
    org_id = body.get("organization_id", "")
    user_id = _get_user_id(event)

    if not org_id or not event_id:
        return error(ErrorCategory.VALIDATION_ERROR, "organization_id and eventId are required")

    denied = authorize_organization(event, org_id)
    if denied:
        return denied

    title = body.get("title", "").strip()
    if not title:
        return error(ErrorCategory.VALIDATION_ERROR, "Incident title is required")

    incident_id = f"INC-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()

    repo = DynamoDBRepository(MAIN_TABLE)
    repo.put_item(
        org_id,
        f"EVENT#{event_id}#INCIDENT#{incident_id}",
        {
            "entity_type": "INCIDENT",
            "event_id": event_id,
            "incident_id": incident_id,
            "title": title,
            "description": body.get("description", ""),
            "severity": body.get("severity", "MEDIUM"),
            "status": "DETECTED",
            "affected_resource_type": body.get("affected_resource_type", ""),
            "affected_resource_id": body.get("affected_resource_id", ""),
            "detected_at": now,
            "detected_by": user_id,
            "created_at": now,
            "updated_at": now,
            "created_by": user_id,
            "GSI1PK": f"{org_id}#{event_id}",
            "GSI1SK": f"INCIDENT#DETECTED#{now}",
        },
    )

    create_audit_event(
        organization_id=org_id,
        action="INCIDENT_DETECTED",
        actor_type="user",
        actor_id=user_id,
        resource_type="Incident",
        resource_id=incident_id,
        event_id=event_id,
        details={"severity": body.get("severity", "MEDIUM"), "title": title},
    )

    return success({"incident_id": incident_id, "message": "Incident created"}, status_code=201)


def _update_incident(event: dict[str, Any], event_id: str, incident_id: str) -> dict[str, Any]:
    body = json.loads(event.get("body", "{}"))
    org_id = body.get("organization_id", "")
    user_id = _get_user_id(event)

    if not org_id:
        return error(ErrorCategory.VALIDATION_ERROR, "organization_id is required")

    denied = authorize_organization(event, org_id)
    if denied:
        return denied

    repo = DynamoDBRepository(MAIN_TABLE)
    existing = repo.get_item(org_id, f"EVENT#{event_id}#INCIDENT#{incident_id}")
    if not existing:
        return error(ErrorCategory.NOT_FOUND, "Incident not found")

    allowed = [
        "title",
        "description",
        "severity",
        "status",
        "impact_analysis",
        "dependencies",
        "backup_options",
        "recommendation",
        "evidence",
        "resolution_summary",
    ]
    updates = {k: body[k] for k in allowed if k in body}
    updates["updated_at"] = utc_now().isoformat()
    updates["updated_by"] = user_id

    if updates.get("status") == "RESOLVED" and existing.get("status") != "RESOLVED":
        updates["resolved_at"] = utc_now().isoformat()
        updates["resolved_by"] = user_id

    repo.update_item(org_id, f"EVENT#{event_id}#INCIDENT#{incident_id}", updates)

    create_audit_event(
        organization_id=org_id,
        action=f"INCIDENT_{updates.get('status', 'UPDATED')}",
        actor_type="user",
        actor_id=user_id,
        resource_type="Incident",
        resource_id=incident_id,
        event_id=event_id,
    )

    return success({"incident_id": incident_id, "message": "Incident updated"})
