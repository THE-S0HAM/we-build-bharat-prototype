"""Command Center handler — operational overview for leaders.

Route: GET /command-center?organization_id=...

Returns only what needs attention:
- Active events
- Pending approvals
- Critical incidents
- Overdue tasks
- Recent agent actions
- Event health summary
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from services.shared.api_response import error, success
from services.shared.dynamodb import DynamoDBRepository
from services.shared.models.base import ErrorCategory

logger = logging.getLogger(__name__)
MAIN_TABLE = os.environ.get("MAIN_TABLE", "OrbitOps-Main-dev")
AUDIT_TABLE = os.environ.get("AUDIT_TABLE", "OrbitOps-Audit-dev")


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Aggregate operational state for the command center dashboard."""
    params = event.get("queryStringParameters") or {}
    org_id = params.get("organization_id", "")

    if not org_id:
        return error(ErrorCategory.VALIDATION_ERROR, "organization_id is required")

    main_repo = DynamoDBRepository(MAIN_TABLE)
    audit_repo = DynamoDBRepository(AUDIT_TABLE)

    # Fetch active events
    all_events = main_repo.query_by_pk(org_id, "EVENT#", limit=50)
    events = [e for e in all_events if e.get("entity_type") == "EVENT"]
    active_events = [e for e in events if e.get("status") in ("ACTIVE", "PUBLISHED")]

    # For each active event, gather operational summary
    event_summaries = []
    total_pending_approvals = 0
    total_critical_incidents = 0
    total_overdue_tasks = 0

    for evt in active_events:
        eid = evt.get("event_id", "")

        # Pending approvals for this event
        approvals = main_repo.query_gsi(
            index_name="GSI1",
            pk_value=f"{org_id}#{eid}",
            sk_begins_with="APPROVAL#PENDING",
            limit=50,
        )
        pending_count = len(approvals)
        total_pending_approvals += pending_count

        # Incidents
        incidents = main_repo.query_by_pk(org_id, f"EVENT#{eid}#INCIDENT#", limit=50)
        critical_incidents = [
            i for i in incidents
            if i.get("severity") in ("CRITICAL", "HIGH") and i.get("status") not in ("RESOLVED",)
        ]
        total_critical_incidents += len(critical_incidents)

        # Tasks — check overdue via status field
        # In a real system we'd compare due_date to now, but for MVP
        # we use the OVERDUE status that TeamOps sets
        tasks = main_repo.query_gsi(
            index_name="GSI1",
            pk_value=f"{org_id}#{eid}",
            sk_begins_with="TASK#",
            limit=200,
        )
        overdue = [t for t in tasks if t.get("status") == "OVERDUE"]
        blocked = [t for t in tasks if t.get("status") == "BLOCKED"]
        total_overdue_tasks += len(overdue)

        event_summaries.append({
            "event_id": eid,
            "name": evt.get("name", ""),
            "status": evt.get("status", ""),
            "pending_approvals": pending_count,
            "critical_incidents": len(critical_incidents),
            "overdue_tasks": len(overdue),
            "blocked_tasks": len(blocked),
            "total_tasks": len(tasks),
        })

    # Recent audit events across all events
    recent_audits = audit_repo.query_by_pk(org_id, "AUDIT#", limit=20)
    recent_audits.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
    recent_actions = recent_audits[:10]

    return success({
        "organization_id": org_id,
        "summary": {
            "active_events": len(active_events),
            "total_events": len(events),
            "pending_approvals": total_pending_approvals,
            "critical_incidents": total_critical_incidents,
            "overdue_tasks": total_overdue_tasks,
        },
        "events": event_summaries,
        "recent_actions": recent_actions,
    })
