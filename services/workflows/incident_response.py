"""Incident response workflow Lambda handler.

Called by the Step Functions state machine to analyze incidents,
prepare recommendations, request approval for HIGH/CRITICAL incidents,
execute resolutions, and record outcomes.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any

from services.shared.audit import create_audit_event
from services.shared.dynamodb import DynamoDBRepository
from services.shared.models.base import utc_now

logger = logging.getLogger(__name__)
MAIN_TABLE = os.environ.get("MAIN_TABLE", "OrbitOps-Main-dev")


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Route to the correct workflow step."""
    action = event.get("action", "")
    org_id = event.get("organization_id", "")
    event_id = event.get("event_id", "")
    incident_id = event.get("incident_id", "")

    logger.info("Incident response action=%s incident=%s", action, incident_id)

    actions = {
        "ANALYZE": _analyze,
        "PREPARE_RECOMMENDATION": _prepare_recommendation,
        "REQUEST_APPROVAL": _request_approval,
        "AUTO_RESOLVE": _auto_resolve,
        "EXECUTE_RESOLUTION": _execute_resolution,
        "RECORD_RESOLUTION": _record_resolution,
        "ESCALATE": _escalate,
        "RECORD_REJECTION": _record_rejection,
    }

    handler_fn = actions.get(action)
    if not handler_fn:
        raise ValueError(f"Unknown incident response action: {action}")

    return handler_fn(event, org_id, event_id, incident_id)


def _analyze(event: dict, org_id: str, event_id: str, incident_id: str) -> dict:
    """Analyze incident context: affected resources, dependencies, severity.

    In production, IncidentOps agent would use Bedrock to analyze the
    full incident context. For MVP, we read the incident record and
    assess based on severity and affected resource type.
    """
    repo = DynamoDBRepository(MAIN_TABLE)
    incident = repo.get_item(org_id, f"EVENT#{event_id}#INCIDENT#{incident_id}")

    if not incident:
        raise ValueError(f"Incident {incident_id} not found")

    repo.update_item(
        org_id,
        f"EVENT#{event_id}#INCIDENT#{incident_id}",
        {"status": "ANALYZING", "updated_at": utc_now().isoformat()},
    )

    # Identify affected resources
    affected_type = incident.get("affected_resource_type", "")
    affected_id = incident.get("affected_resource_id", "")
    dependencies: list[str] = []
    backup_options: list[str] = []

    # If a speaker cancelled, find backup speakers
    if affected_type == "Speaker" and affected_id:
        speakers = repo.query_by_pk(org_id, f"EVENT#{event_id}#SPEAKER#", limit=50)
        backup_options = [
            s.get("speaker_id", "")
            for s in speakers
            if s.get("is_backup") and s.get("status") in ("CONFIRMED", "IDENTIFIED")
        ]

    return {
        "incident_id": incident_id,
        "severity": incident.get("severity", "MEDIUM"),
        "affected_resource_type": affected_type,
        "affected_resource_id": affected_id,
        "dependencies": dependencies,
        "backup_options": backup_options,
        "analysis_complete": True,
    }


def _prepare_recommendation(event: dict, org_id: str, event_id: str, incident_id: str) -> dict:
    """Prepare a recommendation for human review."""
    repo = DynamoDBRepository(MAIN_TABLE)
    analysis = event.get("analysis", {})
    now = utc_now().isoformat()

    recommendation = ""
    backup_options = analysis.get("backup_options", [])

    if analysis.get("affected_resource_type") == "Speaker" and backup_options:
        recommendation = f"Replace cancelled speaker with backup speaker {backup_options[0]}. {len(backup_options)} backup(s) available."
    elif analysis.get("affected_resource_type") == "Speaker":
        recommendation = "No backup speakers available. Consider rescheduling the session or finding an emergency replacement."
    else:
        recommendation = "Review the incident details and determine the appropriate course of action."

    repo.update_item(
        org_id,
        f"EVENT#{event_id}#INCIDENT#{incident_id}",
        {
            "status": "RECOMMENDATION_READY",
            "recommendation": recommendation,
            "backup_options": backup_options,
            "impact_analysis": json.dumps(analysis),
            "updated_at": now,
        },
    )

    return {
        "recommendation": recommendation,
        "backup_options": backup_options,
        "severity": analysis.get("severity", "MEDIUM"),
    }


def _request_approval(event: dict, org_id: str, event_id: str, incident_id: str) -> dict:
    """Create approval request with task token for Step Functions callback."""
    repo = DynamoDBRepository(MAIN_TABLE)
    approval_id = f"APR-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()
    recommendation = event.get("recommendation", {})
    task_token = event.get("task_token", "")

    repo.put_item(
        org_id,
        f"EVENT#{event_id}#APPROVAL#{approval_id}",
        {
            "entity_type": "APPROVAL",
            "event_id": event_id,
            "approval_id": approval_id,
            "title": f"Incident resolution: {incident_id}",
            "description": recommendation.get("recommendation", ""),
            "status": "PENDING",
            "risk_level": "HIGH",
            "requested_action": "RESOLVE_INCIDENT",
            "reason": recommendation.get("recommendation", ""),
            "evidence": recommendation,
            "affected_resource_type": "Incident",
            "affected_resource_id": incident_id,
            "agent_name": "IncidentOps",
            "task_token": task_token,
            "requested_at": now,
            "created_at": now,
            "GSI1PK": f"{org_id}#{event_id}",
            "GSI1SK": f"APPROVAL#PENDING#{now}",
        },
    )

    repo.update_item(
        org_id,
        f"EVENT#{event_id}#INCIDENT#{incident_id}",
        {"status": "AWAITING_APPROVAL", "approval_id": approval_id, "updated_at": now},
    )

    create_audit_event(
        organization_id=org_id,
        action="INCIDENT_APPROVAL_REQUESTED",
        actor_type="agent",
        actor_id="IncidentOps",
        resource_type="Incident",
        resource_id=incident_id,
        event_id=event_id,
        details={"approval_id": approval_id},
    )

    return {"approval_id": approval_id, "status": "AWAITING_APPROVAL"}


def _auto_resolve(event: dict, org_id: str, event_id: str, incident_id: str) -> dict:
    """Auto-resolve LOW/MEDIUM incidents without human approval."""
    repo = DynamoDBRepository(MAIN_TABLE)
    now = utc_now().isoformat()
    analysis = event.get("analysis", {})

    repo.update_item(
        org_id,
        f"EVENT#{event_id}#INCIDENT#{incident_id}",
        {
            "status": "RESOLVED",
            "resolved_at": now,
            "resolved_by": "IncidentOps",
            "resolution_summary": "Auto-resolved: severity within auto-resolution threshold",
            "updated_at": now,
        },
    )

    create_audit_event(
        organization_id=org_id,
        action="INCIDENT_AUTO_RESOLVED",
        actor_type="agent",
        actor_id="IncidentOps",
        resource_type="Incident",
        resource_id=incident_id,
        event_id=event_id,
    )

    return {"resolved": True, "method": "auto"}


def _execute_resolution(event: dict, org_id: str, event_id: str, incident_id: str) -> dict:
    """Execute the approved resolution plan."""
    repo = DynamoDBRepository(MAIN_TABLE)
    now = utc_now().isoformat()

    repo.update_item(
        org_id,
        f"EVENT#{event_id}#INCIDENT#{incident_id}",
        {"status": "EXECUTING", "updated_at": now},
    )

    # In production, this would execute the actual resolution (e.g., swap speakers,
    # notify attendees, update schedule). For MVP, we mark it as executing.
    return {"executing": True, "incident_id": incident_id}


def _record_resolution(event: dict, org_id: str, event_id: str, incident_id: str) -> dict:
    """Record final resolution state and create audit event."""
    repo = DynamoDBRepository(MAIN_TABLE)
    now = utc_now().isoformat()
    resolution = event.get("resolution", {})

    repo.update_item(
        org_id,
        f"EVENT#{event_id}#INCIDENT#{incident_id}",
        {
            "status": "RESOLVED",
            "resolved_at": now,
            "resolved_by": resolution.get("resolved_by", "IncidentOps"),
            "resolution_summary": resolution.get("summary", "Resolved via workflow"),
            "updated_at": now,
        },
    )

    create_audit_event(
        organization_id=org_id,
        action="INCIDENT_RESOLVED",
        actor_type="agent",
        actor_id="IncidentOps",
        resource_type="Incident",
        resource_id=incident_id,
        event_id=event_id,
    )

    return {"resolved": True}


def _escalate(event: dict, org_id: str, event_id: str, incident_id: str) -> dict:
    """Escalate when approval times out."""
    repo = DynamoDBRepository(MAIN_TABLE)
    now = utc_now().isoformat()

    repo.update_item(
        org_id,
        f"EVENT#{event_id}#INCIDENT#{incident_id}",
        {
            "status": "ESCALATED",
            "updated_at": now,
        },
    )

    create_audit_event(
        organization_id=org_id,
        action="INCIDENT_ESCALATED",
        actor_type="agent",
        actor_id="IncidentOps",
        resource_type="Incident",
        resource_id=incident_id,
        event_id=event_id,
        details={"reason": event.get("reason", "APPROVAL_TIMEOUT")},
    )

    return {"escalated": True}


def _record_rejection(event: dict, org_id: str, event_id: str, incident_id: str) -> dict:
    """Record that the resolution was rejected by the approver."""
    repo = DynamoDBRepository(MAIN_TABLE)
    now = utc_now().isoformat()

    repo.update_item(
        org_id,
        f"EVENT#{event_id}#INCIDENT#{incident_id}",
        {"status": "REJECTED", "updated_at": now},
    )

    create_audit_event(
        organization_id=org_id,
        action="INCIDENT_RESOLUTION_REJECTED",
        actor_type="agent",
        actor_id="IncidentOps",
        resource_type="Incident",
        resource_id=incident_id,
        event_id=event_id,
    )

    return {"rejected": True}
