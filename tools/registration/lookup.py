"""Registration lookup tool for Strands agents.

This tool wraps the RegistrationConnector to provide a typed,
narrow interface for agent registration queries. The agent can
search by registration ID, email, phone, or name.

The tool enforces tenant boundaries and returns structured results.
It never allows the agent to write or modify registration data.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from services.shared.connectors_dynamodb import DynamoDBRegistrationConnector

logger = logging.getLogger(__name__)


def registration_lookup_tool(
    organization_id: str,
    event_id: str,
    search_type: str,
    search_value: str,
) -> dict[str, Any]:
    """Look up a registration by identifier.

    Args:
        organization_id: Tenant boundary — required for every query.
        event_id: Which event to search within.
        search_type: One of 'registration_id', 'email', 'phone', 'name'.
        search_value: The value to search for.

    Returns:
        Structured result with found/not_found status, registration data,
        and any error information if the external system is unavailable.
    """
    if not organization_id or not event_id or not search_value:
        return {"error": "organization_id, event_id, and search_value are required"}

    connector = DynamoDBRegistrationConnector()

    lookup_methods = {
        "registration_id": connector.lookup_by_id,
        "email": connector.lookup_by_email,
        "phone": connector.lookup_by_phone,
        "name": connector.lookup_by_name,
    }

    method = lookup_methods.get(search_type)
    if not method:
        return {"error": f"Invalid search_type: {search_type}. Use: registration_id, email, phone, name"}

    result = method(organization_id, event_id, search_value)

    if not result.success:
        return {
            "found": False,
            "error": result.error_category,
            "message": result.error_message or "External system unavailable",
            "system_available": False,
        }

    if not result.data:
        return {
            "found": False,
            "count": 0,
            "registrations": [],
            "system_available": True,
        }

    if len(result.data) > 1:
        # Multiple matches — return candidates for disambiguation
        return {
            "found": True,
            "count": len(result.data),
            "requires_disambiguation": True,
            "registrations": [
                {
                    "registration_id": r.get("registration_id", ""),
                    "attendee_name": r.get("attendee_name", ""),
                    "ticket_type": r.get("ticket_type", ""),
                }
                for r in result.data
            ],
            "system_available": True,
        }

    reg = result.data[0]
    return {
        "found": True,
        "count": 1,
        "requires_disambiguation": False,
        "registration": {
            "registration_id": reg.get("registration_id", ""),
            "attendee_name": reg.get("attendee_name", ""),
            "attendee_email": reg.get("attendee_email", ""),
            "status": reg.get("status", ""),
            "payment_status": reg.get("payment_status", ""),
            "ticket_type": reg.get("ticket_type", ""),
            "is_checked_in": reg.get("is_checked_in", False),
        },
        "system_available": True,
    }
