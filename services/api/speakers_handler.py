"""Speakers CRUD handler.

Routes: GET /events/{eventId}/speakers, POST /events/{eventId}/speakers,
        PUT /events/{eventId}/speakers/{speakerId}
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
    speaker_id = path_params.get("speakerId")

    if method == "GET":
        return _list_speakers(event, event_id)
    elif method == "POST":
        return _create_speaker(event, event_id)
    elif method == "PUT" and speaker_id:
        return _update_speaker(event, event_id, speaker_id)

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


def _list_speakers(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    org_id = _get_org_id(event)
    if not org_id or not event_id:
        return error(ErrorCategory.VALIDATION_ERROR, "organization_id and eventId are required")

    denied = authorize_organization(event, org_id)
    if denied:
        return denied

    repo = DynamoDBRepository(MAIN_TABLE)
    items = repo.query_by_pk(org_id, f"EVENT#{event_id}#SPEAKER#", limit=100)
    return success({"speakers": items, "count": len(items)})


def _create_speaker(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    body = json.loads(event.get("body", "{}"))
    org_id = body.get("organization_id", "")
    user_id = _get_user_id(event)

    if not org_id or not event_id:
        return error(ErrorCategory.VALIDATION_ERROR, "organization_id and eventId are required")

    denied = authorize_organization(event, org_id)
    if denied:
        return denied

    name = body.get("name", "").strip()
    if not name:
        return error(ErrorCategory.VALIDATION_ERROR, "Speaker name is required")

    speaker_id = f"SPK-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()

    repo = DynamoDBRepository(MAIN_TABLE)
    repo.put_item(
        org_id,
        f"EVENT#{event_id}#SPEAKER#{speaker_id}",
        {
            "entity_type": "SPEAKER",
            "event_id": event_id,
            "speaker_id": speaker_id,
            "name": name,
            "email": body.get("email", ""),
            "phone": body.get("phone", ""),
            "status": "IDENTIFIED",
            "topic": body.get("topic", ""),
            "bio": body.get("bio", ""),
            "session_type": body.get("session_type", "TALK"),
            "session_duration_minutes": body.get("session_duration_minutes", 30),
            "travel_required": body.get("travel_required", False),
            "accommodation_required": body.get("accommodation_required", False),
            "is_backup": body.get("is_backup", False),
            "followup_count": 0,
            "max_followups": 3,
            "created_at": now,
            "updated_at": now,
            "created_by": user_id,
            "GSI1PK": f"{org_id}#{event_id}",
            "GSI1SK": f"SPEAKER#IDENTIFIED#{now}",
        },
    )

    create_audit_event(
        organization_id=org_id,
        action="SPEAKER_CREATED",
        actor_type="user",
        actor_id=user_id,
        resource_type="Speaker",
        resource_id=speaker_id,
        event_id=event_id,
    )

    return success({"speaker_id": speaker_id, "message": "Speaker created"}, status_code=201)


def _update_speaker(event: dict[str, Any], event_id: str, speaker_id: str) -> dict[str, Any]:
    body = json.loads(event.get("body", "{}"))
    org_id = body.get("organization_id", "")
    user_id = _get_user_id(event)

    if not org_id:
        return error(ErrorCategory.VALIDATION_ERROR, "organization_id is required")

    denied = authorize_organization(event, org_id)
    if denied:
        return denied

    repo = DynamoDBRepository(MAIN_TABLE)
    existing = repo.get_item(org_id, f"EVENT#{event_id}#SPEAKER#{speaker_id}")
    if not existing:
        return error(ErrorCategory.NOT_FOUND, "Speaker not found")

    allowed = [
        "name",
        "email",
        "phone",
        "status",
        "topic",
        "bio",
        "session_type",
        "session_duration_minutes",
        "travel_required",
        "accommodation_required",
        "travel_details",
        "accommodation_details",
        "special_requirements",
        "availability_notes",
        "slides_submitted",
        "av_requirements",
        "is_backup",
        "backup_for_speaker_id",
    ]
    updates = {k: body[k] for k in allowed if k in body}
    updates["updated_at"] = utc_now().isoformat()
    updates["updated_by"] = user_id

    repo.update_item(org_id, f"EVENT#{event_id}#SPEAKER#{speaker_id}", updates)

    create_audit_event(
        organization_id=org_id,
        action="SPEAKER_UPDATED",
        actor_type="user",
        actor_id=user_id,
        resource_type="Speaker",
        resource_id=speaker_id,
        event_id=event_id,
        details={"updated_fields": list(updates.keys())},
    )

    return success({"speaker_id": speaker_id, "message": "Speaker updated"})
