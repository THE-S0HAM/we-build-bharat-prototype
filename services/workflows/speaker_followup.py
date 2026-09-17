"""Speaker follow-up workflow Lambda handler.

Called by the Step Functions state machine at each stage of the
speaker outreach lifecycle. Each action is a discrete step:
invite, check response, policy check, send follow-up, extract data, etc.
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
    """Route to the correct workflow step based on the action field."""
    action = event.get("action", "")
    org_id = event.get("organization_id", "")
    event_id = event.get("event_id", "")
    speaker_id = event.get("speaker_id", "")

    logger.info("Speaker followup action=%s speaker=%s", action, speaker_id)

    actions = {
        "SEND_INVITE": _send_invite,
        "CHECK_RESPONSE": _check_response,
        "CHECK_FOLLOWUP_POLICY": _check_followup_policy,
        "SEND_FOLLOWUP": _send_followup,
        "EXTRACT_RESPONSE": _extract_response,
        "UPDATE_SPEAKER": _update_speaker,
        "REQUEST_APPROVAL": _request_approval,
        "AWAIT_APPROVAL": _await_approval,
        "ESCALATE": _escalate,
        "RECORD_DECLINED": _record_declined,
    }

    handler_fn = actions.get(action)
    if not handler_fn:
        raise ValueError(f"Unknown speaker followup action: {action}")

    return handler_fn(event, org_id, event_id, speaker_id)


def _send_invite(event: dict, org_id: str, event_id: str, speaker_id: str) -> dict:
    """Mark speaker as INVITED and send initial outreach email."""
    repo = DynamoDBRepository(MAIN_TABLE)
    now = utc_now().isoformat()

    repo.update_item(
        org_id,
        f"EVENT#{event_id}#SPEAKER#{speaker_id}",
        {"status": "INVITED", "invited_at": now, "last_contacted_at": now, "updated_at": now},
    )

    # In production, this would call the CommunicationConnector to send email via SES.
    # For MVP, we update state and log the action.
    logger.info("Speaker invite sent: speaker=%s event=%s", speaker_id, event_id)

    create_audit_event(
        organization_id=org_id,
        action="SPEAKER_INVITED",
        actor_type="agent",
        actor_id="SpeakerOps",
        resource_type="Speaker",
        resource_id=speaker_id,
        event_id=event_id,
        tool_used="send_speaker_invite",
    )

    return {"invite_sent": True, "speaker_id": speaker_id}


def _check_response(event: dict, org_id: str, event_id: str, speaker_id: str) -> dict:
    """Check if the speaker has responded since last contact."""
    repo = DynamoDBRepository(MAIN_TABLE)
    speaker = repo.get_item(org_id, f"EVENT#{event_id}#SPEAKER#{speaker_id}")

    if not speaker:
        raise ValueError(f"Speaker {speaker_id} not found")

    response_received = speaker.get("response_received_at") is not None
    followup_count = speaker.get("followup_count", 0)
    max_followups = speaker.get("max_followups", 3)

    return {
        "response_received": response_received,
        "followup_count": followup_count,
        "max_followups_reached": followup_count >= max_followups,
        "current_status": speaker.get("status", ""),
    }


def _check_followup_policy(event: dict, org_id: str, event_id: str, speaker_id: str) -> dict:
    """Determine whether sending a follow-up requires human approval.

    Policy: first 2 follow-ups are auto-allowed. Third and beyond
    require organizer approval to avoid being intrusive.
    """
    followup_count = event.get("followup_count", 0)
    requires_approval = followup_count >= 2

    return {
        "requires_approval": requires_approval,
        "reason": "Follow-up count exceeds auto-send threshold" if requires_approval else "Within auto-send limit",
    }


def _send_followup(event: dict, org_id: str, event_id: str, speaker_id: str) -> dict:
    """Send a follow-up message and update tracking state."""
    repo = DynamoDBRepository(MAIN_TABLE)
    now = utc_now().isoformat()

    speaker = repo.get_item(org_id, f"EVENT#{event_id}#SPEAKER#{speaker_id}")
    if not speaker:
        raise ValueError(f"Speaker {speaker_id} not found")

    new_count = speaker.get("followup_count", 0) + 1

    repo.update_item(
        org_id,
        f"EVENT#{event_id}#SPEAKER#{speaker_id}",
        {
            "status": "FOLLOWUP_SENT",
            "followup_count": new_count,
            "last_contacted_at": now,
            "updated_at": now,
        },
    )

    create_audit_event(
        organization_id=org_id,
        action="SPEAKER_FOLLOWUP_SENT",
        actor_type="agent",
        actor_id="SpeakerOps",
        resource_type="Speaker",
        resource_id=speaker_id,
        event_id=event_id,
        details={"followup_number": new_count},
    )

    return {"followup_sent": True, "followup_count": new_count}


def _extract_response(event: dict, org_id: str, event_id: str, speaker_id: str) -> dict:
    """Extract structured data from a speaker's response.

    In production, this would use an agent with Bedrock to parse
    the speaker's email/message and extract: availability, topic,
    travel requirements, accommodation needs, session preference.

    For MVP, returns the current speaker state as extraction result.
    """
    repo = DynamoDBRepository(MAIN_TABLE)
    speaker = repo.get_item(org_id, f"EVENT#{event_id}#SPEAKER#{speaker_id}")

    if not speaker:
        raise ValueError(f"Speaker {speaker_id} not found")

    return {
        "availability": speaker.get("availability_notes", ""),
        "topic": speaker.get("topic", ""),
        "travel_required": speaker.get("travel_required", False),
        "accommodation_required": speaker.get("accommodation_required", False),
        "special_requirements": speaker.get("special_requirements", ""),
    }


def _update_speaker(event: dict, org_id: str, event_id: str, speaker_id: str) -> dict:
    """Update speaker state with extracted response data."""
    repo = DynamoDBRepository(MAIN_TABLE)
    now = utc_now().isoformat()
    extracted = event.get("extracted_data", {})

    updates: dict[str, Any] = {
        "status": "CONFIRMED",
        "response_received_at": now,
        "updated_at": now,
    }

    # Merge extracted fields if present
    for field in ["topic", "travel_required", "accommodation_required", "special_requirements", "availability_notes"]:
        if field in extracted and extracted[field]:
            updates[field] = extracted[field]

    repo.update_item(org_id, f"EVENT#{event_id}#SPEAKER#{speaker_id}", updates)

    create_audit_event(
        organization_id=org_id,
        action="SPEAKER_CONFIRMED",
        actor_type="agent",
        actor_id="SpeakerOps",
        resource_type="Speaker",
        resource_id=speaker_id,
        event_id=event_id,
    )

    return {"updated": True, "new_status": "CONFIRMED"}


def _request_approval(event: dict, org_id: str, event_id: str, speaker_id: str) -> dict:
    """Create a human approval request for speaker follow-up."""
    repo = DynamoDBRepository(MAIN_TABLE)
    approval_id = f"APR-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()

    repo.put_item(
        org_id,
        f"EVENT#{event_id}#APPROVAL#{approval_id}",
        {
            "entity_type": "APPROVAL",
            "event_id": event_id,
            "approval_id": approval_id,
            "title": f"Approve follow-up #{event.get('followup_count', 0) + 1} for speaker",
            "description": f"SpeakerOps wants to send another follow-up to speaker {speaker_id}.",
            "status": "PENDING",
            "risk_level": "MEDIUM",
            "requested_action": "SEND_SPEAKER_FOLLOWUP",
            "reason": "Follow-up count exceeds auto-send threshold",
            "affected_resource_type": "Speaker",
            "affected_resource_id": speaker_id,
            "agent_name": "SpeakerOps",
            "requested_at": now,
            "created_at": now,
            "GSI1PK": f"{org_id}#{event_id}",
            "GSI1SK": f"APPROVAL#PENDING#{now}",
        },
    )

    create_audit_event(
        organization_id=org_id,
        action="APPROVAL_REQUESTED",
        actor_type="agent",
        actor_id="SpeakerOps",
        resource_type="Approval",
        resource_id=approval_id,
        event_id=event_id,
    )

    return {"approval_id": approval_id, "status": "PENDING"}


def _await_approval(event: dict, org_id: str, event_id: str, speaker_id: str) -> dict:
    """Store the Step Functions task token for callback when approval is decided.

    The approval handler (API) will call SendTaskSuccess/SendTaskFailure
    using this token when the leader decides.
    """
    repo = DynamoDBRepository(MAIN_TABLE)
    task_token = event.get("task_token", "")
    approval_id = event.get("approval_id", "")

    if task_token and approval_id:
        repo.update_item(
            org_id,
            f"EVENT#{event_id}#APPROVAL#{approval_id}",
            {"task_token": task_token, "workflow_execution_id": f"speaker-followup-{speaker_id}"},
        )

    # This function doesn't return normally — Step Functions waits for the callback
    return {"awaiting": True, "approval_id": approval_id}


def _escalate(event: dict, org_id: str, event_id: str, speaker_id: str) -> dict:
    """Escalate when max follow-ups reached or approval timed out."""
    repo = DynamoDBRepository(MAIN_TABLE)
    now = utc_now().isoformat()

    repo.update_item(
        org_id,
        f"EVENT#{event_id}#SPEAKER#{speaker_id}",
        {"status": "AWAITING_RESPONSE", "escalation_level": 1, "updated_at": now},
    )

    create_audit_event(
        organization_id=org_id,
        action="SPEAKER_ESCALATED",
        actor_type="agent",
        actor_id="SpeakerOps",
        resource_type="Speaker",
        resource_id=speaker_id,
        event_id=event_id,
        details={"reason": event.get("reason", "UNKNOWN")},
    )

    return {"escalated": True, "reason": event.get("reason", "")}


def _record_declined(event: dict, org_id: str, event_id: str, speaker_id: str) -> dict:
    """Record that the follow-up was declined by the approver."""
    repo = DynamoDBRepository(MAIN_TABLE)
    now = utc_now().isoformat()

    repo.update_item(
        org_id,
        f"EVENT#{event_id}#SPEAKER#{speaker_id}",
        {"updated_at": now},
    )

    create_audit_event(
        organization_id=org_id,
        action="SPEAKER_FOLLOWUP_DECLINED",
        actor_type="agent",
        actor_id="SpeakerOps",
        resource_type="Speaker",
        resource_id=speaker_id,
        event_id=event_id,
    )

    return {"declined": True}
