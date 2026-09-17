"""Events CRUD handler.

Routes: GET /events, POST /events, GET /events/{eventId}, PUT /events/{eventId}
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

logger = logging.getLogger(__name__)
MAIN_TABLE = os.environ.get("MAIN_TABLE", "OrbitOps-Main-dev")


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Route to the appropriate CRUD operation based on HTTP method and path."""
    method = event.get("httpMethod", "GET")
    path_params = event.get("pathParameters") or {}
    event_id = path_params.get("eventId")

    if method == "GET" and event_id:
        return _get_event(event, event_id)
    elif method == "GET":
        return _list_events(event)
    elif method == "POST":
        return _create_event(event)
    elif method == "PUT" and event_id:
        return _update_event(event, event_id)

    return error(ErrorCategory.VALIDATION_ERROR, "Unsupported operation")


def _get_org_id(event: dict[str, Any]) -> str:
    """Extract organization_id from query params or body."""
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


def _list_events(event: dict[str, Any]) -> dict[str, Any]:
    org_id = _get_org_id(event)
    if not org_id:
        return error(ErrorCategory.VALIDATION_ERROR, "organization_id is required")

    repo = DynamoDBRepository(MAIN_TABLE)
    items = repo.query_by_pk(org_id, "EVENT#", limit=50)

    # Filter out non-event items (registrations, tickets etc. share the same PK)
    events = [i for i in items if i.get("entity_type") == "EVENT"]
    return success({"events": events, "count": len(events)})


def _get_event(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    org_id = _get_org_id(event)
    if not org_id:
        return error(ErrorCategory.VALIDATION_ERROR, "organization_id is required")

    repo = DynamoDBRepository(MAIN_TABLE)
    item = repo.get_item(org_id, f"EVENT#{event_id}")
    if not item:
        return error(ErrorCategory.NOT_FOUND, "Event not found")

    return success(item)


def _create_event(event: dict[str, Any]) -> dict[str, Any]:
    body = json.loads(event.get("body", "{}"))
    org_id = body.get("organization_id", "")
    user_id = _get_user_id(event)

    if not org_id:
        return error(ErrorCategory.VALIDATION_ERROR, "organization_id is required")

    name = body.get("name", "").strip()
    if not name:
        return error(ErrorCategory.VALIDATION_ERROR, "Event name is required")

    event_id = f"EVT-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()

    repo = DynamoDBRepository(MAIN_TABLE)
    repo.put_item(
        org_id,
        f"EVENT#{event_id}",
        {
            "entity_type": "EVENT",
            "event_id": event_id,
            "name": name,
            "description": body.get("description", ""),
            "status": "DRAFT",
            "venue": body.get("venue", ""),
            "city": body.get("city", ""),
            "start_date": body.get("start_date", ""),
            "end_date": body.get("end_date", ""),
            "timezone": body.get("timezone", "Asia/Kolkata"),
            "expected_attendees": body.get("expected_attendees", 0),
            "registration_open": False,
            "tags": body.get("tags", []),
            "created_at": now,
            "updated_at": now,
            "created_by": user_id,
            "GSI1PK": f"{org_id}#EVENTS",
            "GSI1SK": f"STATUS#DRAFT#{now}",
        },
    )

    create_audit_event(
        organization_id=org_id,
        action="EVENT_CREATED",
        actor_type="user",
        actor_id=user_id,
        resource_type="Event",
        resource_id=event_id,
        event_id=event_id,
    )

    return success({"event_id": event_id, "message": "Event created"}, status_code=201)


def _update_event(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    body = json.loads(event.get("body", "{}"))
    org_id = body.get("organization_id", "")
    user_id = _get_user_id(event)

    if not org_id:
        return error(ErrorCategory.VALIDATION_ERROR, "organization_id is required")

    repo = DynamoDBRepository(MAIN_TABLE)
    existing = repo.get_item(org_id, f"EVENT#{event_id}")
    if not existing:
        return error(ErrorCategory.NOT_FOUND, "Event not found")

    allowed_updates = ["name", "description", "status", "venue", "city", "start_date", "end_date",
                       "timezone", "expected_attendees", "registration_open", "tags"]
    updates = {k: body[k] for k in allowed_updates if k in body}
    updates["updated_at"] = utc_now().isoformat()
    updates["updated_by"] = user_id

    repo.update_item(org_id, f"EVENT#{event_id}", updates)

    create_audit_event(
        organization_id=org_id,
        action="EVENT_UPDATED",
        actor_type="user",
        actor_id=user_id,
        resource_type="Event",
        resource_id=event_id,
        event_id=event_id,
        details={"updated_fields": list(updates.keys())},
    )

    return success({"event_id": event_id, "message": "Event updated"})
