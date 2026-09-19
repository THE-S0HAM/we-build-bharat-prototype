"""Tasks CRUD handler.

Routes: GET /events/{eventId}/teams/{teamId}/tasks,
        POST /events/{eventId}/teams/{teamId}/tasks,
        PUT /events/{eventId}/teams/{teamId}/tasks/{taskId}
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
    team_id = path_params.get("teamId", "")
    task_id = path_params.get("taskId")

    if method == "GET":
        return _list_tasks(event, event_id, team_id)
    elif method == "POST":
        return _create_task(event, event_id, team_id)
    elif method == "PUT" and task_id:
        return _update_task(event, event_id, team_id, task_id)

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


def _list_tasks(event: dict[str, Any], event_id: str, team_id: str) -> dict[str, Any]:
    org_id = _get_org_id(event)
    if not org_id or not event_id or not team_id:
        return error(
            ErrorCategory.VALIDATION_ERROR, "organization_id, eventId, and teamId are required"
        )

    denied = authorize_organization(event, org_id)
    if denied:
        return denied

    repo = DynamoDBRepository(MAIN_TABLE)
    items = repo.query_by_pk(org_id, f"EVENT#{event_id}#TEAM#{team_id}#TASK#", limit=200)
    return success({"tasks": items, "count": len(items)})


def _create_task(event: dict[str, Any], event_id: str, team_id: str) -> dict[str, Any]:
    body = json.loads(event.get("body", "{}"))
    org_id = body.get("organization_id", "")
    user_id = _get_user_id(event)

    if not org_id or not event_id or not team_id:
        return error(
            ErrorCategory.VALIDATION_ERROR, "organization_id, eventId, and teamId are required"
        )

    denied = authorize_organization(event, org_id)
    if denied:
        return denied

    title = body.get("title", "").strip()
    if not title:
        return error(ErrorCategory.VALIDATION_ERROR, "Task title is required")

    task_id = f"TSK-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()

    repo = DynamoDBRepository(MAIN_TABLE)
    repo.put_item(
        org_id,
        f"EVENT#{event_id}#TEAM#{team_id}#TASK#{task_id}",
        {
            "entity_type": "TASK",
            "event_id": event_id,
            "team_id": team_id,
            "task_id": task_id,
            "title": title,
            "description": body.get("description", ""),
            "status": "PENDING",
            "priority": body.get("priority", "MEDIUM"),
            "assigned_to": body.get("assigned_to", ""),
            "due_date": body.get("due_date", ""),
            "depends_on": body.get("depends_on", []),
            "blocks": body.get("blocks", []),
            "escalation_level": 0,
            "created_at": now,
            "updated_at": now,
            "created_by": user_id,
            "GSI1PK": f"{org_id}#{event_id}",
            "GSI1SK": f"TASK#PENDING#{now}",
        },
    )

    create_audit_event(
        organization_id=org_id,
        action="TASK_CREATED",
        actor_type="user",
        actor_id=user_id,
        resource_type="Task",
        resource_id=task_id,
        event_id=event_id,
        details={"team_id": team_id, "title": title},
    )

    return success({"task_id": task_id, "message": "Task created"}, status_code=201)


def _update_task(
    event: dict[str, Any], event_id: str, team_id: str, task_id: str
) -> dict[str, Any]:
    body = json.loads(event.get("body", "{}"))
    org_id = body.get("organization_id", "")
    user_id = _get_user_id(event)

    if not org_id:
        return error(ErrorCategory.VALIDATION_ERROR, "organization_id is required")

    denied = authorize_organization(event, org_id)
    if denied:
        return denied

    repo = DynamoDBRepository(MAIN_TABLE)
    existing = repo.get_item(org_id, f"EVENT#{event_id}#TEAM#{team_id}#TASK#{task_id}")
    if not existing:
        return error(ErrorCategory.NOT_FOUND, "Task not found")

    allowed = [
        "title",
        "description",
        "status",
        "priority",
        "assigned_to",
        "due_date",
        "depends_on",
        "blocks",
        "escalation_level",
        "notes",
    ]
    updates = {k: body[k] for k in allowed if k in body}
    updates["updated_at"] = utc_now().isoformat()
    updates["updated_by"] = user_id

    # If marking complete, record completion time
    if updates.get("status") == "COMPLETED" and existing.get("status") != "COMPLETED":
        updates["completed_at"] = utc_now().isoformat()

    repo.update_item(org_id, f"EVENT#{event_id}#TEAM#{team_id}#TASK#{task_id}", updates)

    create_audit_event(
        organization_id=org_id,
        action="TASK_UPDATED",
        actor_type="user",
        actor_id=user_id,
        resource_type="Task",
        resource_id=task_id,
        event_id=event_id,
        details={"team_id": team_id, "updated_fields": list(updates.keys())},
    )

    return success({"task_id": task_id, "message": "Task updated"})
