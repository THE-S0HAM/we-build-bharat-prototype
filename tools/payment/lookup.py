"""Payment reference lookup tool for Strands agents.

Wraps PaymentConnector for agent-invocable payment reconciliation.
Agents use this when registration lookup fails and the volunteer
provides a transaction reference.

Never collects card numbers, CVVs, PINs, or banking credentials.
"""

from __future__ import annotations

import logging
from typing import Any

from services.shared.connectors_dynamodb import DynamoDBPaymentConnector

logger = logging.getLogger(__name__)


def payment_lookup_tool(
    organization_id: str,
    event_id: str,
    transaction_id: str,
) -> dict[str, Any]:
    """Look up a payment by transaction reference.

    Args:
        organization_id: Tenant boundary.
        event_id: Which event to search within.
        transaction_id: Payment gateway transaction reference.

    Returns:
        Structured result with payment details and linked registration.
    """
    if not organization_id or not event_id or not transaction_id:
        return {"error": "organization_id, event_id, and transaction_id are required"}

    connector = DynamoDBPaymentConnector()
    result = connector.lookup_by_transaction_id(organization_id, event_id, transaction_id)

    if not result.success:
        return {
            "found": False,
            "error": result.error_category,
            "message": result.error_message or "Payment system unavailable",
            "system_available": False,
        }

    if not result.data:
        return {
            "found": False,
            "count": 0,
            "system_available": True,
        }

    payment = result.data[0]
    return {
        "found": True,
        "payment": {
            "transaction_id": payment.get("transaction_id", ""),
            "registration_id": payment.get("registration_id", ""),
            "amount": payment.get("amount", ""),
            "currency": payment.get("currency", ""),
            "status": payment.get("status", ""),
            "payer_name": payment.get("payer_name", ""),
        },
        "system_available": True,
    }
