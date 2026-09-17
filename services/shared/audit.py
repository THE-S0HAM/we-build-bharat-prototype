"""Audit event service.

Every consequential operation emits an audit event so the system can answer:
what happened, who initiated it, which tool acted, what policy was applied,
and what was the result.

Audit events are written to DynamoDB and optionally published to EventBridge
for downstream consumers (dashboards, alerts).
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any

import boto3
from botocore.exceptions import ClientError

from services.shared.models.base import AuditEvent, utc_now

logger = logging.getLogger(__name__)

AUDIT_TABLE = os.environ.get("AUDIT_TABLE", "OrbitOps-Audit-dev")
EVENT_BUS_NAME = os.environ.get("EVENT_BUS_NAME", "OrbitOps-EventBus-dev")


def create_audit_event(
    organization_id: str,
    action: str,
    actor_type: str,
    actor_id: str,
    resource_type: str,
    resource_id: str,
    *,
    event_id: str | None = None,
    details: dict[str, Any] | None = None,
    tool_used: str | None = None,
    policy_evaluated: str | None = None,
    approval_id: str | None = None,
    outcome: str = "success",
) -> AuditEvent:
    """Create and persist an audit event.

    This is the single entry point for audit logging. Every service
    and agent tool calls this after performing a consequential action.
    """
    audit = AuditEvent(
        audit_id=f"AUD-{uuid.uuid4().hex[:12]}",
        organization_id=organization_id,
        event_id=event_id,
        action=action,
        actor_type=actor_type,
        actor_id=actor_id,
        resource_type=resource_type,
        resource_id=resource_id,
        details=details or {},
        tool_used=tool_used,
        policy_evaluated=policy_evaluated,
        approval_id=approval_id,
        outcome=outcome,
    )

    _write_to_dynamodb(audit)
    _publish_to_eventbridge(audit)

    return audit


def _write_to_dynamodb(audit: AuditEvent) -> None:
    """Persist audit event to DynamoDB."""
    try:
        dynamodb = boto3.resource("dynamodb")
        table = dynamodb.Table(AUDIT_TABLE)
        table.put_item(
            Item={
                "PK": audit.organization_id,
                "SK": f"AUDIT#{audit.timestamp.isoformat()}#{audit.audit_id}",
                "GSI1PK": f"{audit.organization_id}#{audit.event_id or 'GLOBAL'}",
                "GSI1SK": f"{audit.action}#{audit.timestamp.isoformat()}",
                **audit.model_dump(mode="json"),
            }
        )
    except ClientError:
        # Audit write failure must not break the primary operation.
        # Log the error and continue — the operation itself succeeded.
        logger.error(
            "Failed to write audit event %s for action %s",
            audit.audit_id,
            audit.action,
            exc_info=True,
        )


def _publish_to_eventbridge(audit: AuditEvent) -> None:
    """Publish audit event to EventBridge for downstream consumers."""
    try:
        events_client = boto3.client("events")
        events_client.put_events(
            Entries=[
                {
                    "Source": "orbitops.audit",
                    "DetailType": audit.action,
                    "Detail": json.dumps(audit.model_dump(mode="json"), default=str),
                    "EventBusName": EVENT_BUS_NAME,
                }
            ]
        )
    except ClientError:
        # Same principle: audit event publication failure is non-fatal.
        logger.warning(
            "Failed to publish audit event %s to EventBridge",
            audit.audit_id,
            exc_info=True,
        )
