"""CheckInOps Agent — ticket recovery specialist.

Handles: registration lookup, payment reconciliation, ticket generation,
QR verification, check-in completion, duplicate prevention, unresolved cases.

This agent uses deterministic tools for all transactional lookups.
It never invents registration or payment facts.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-sonnet-4-20250514-v1:0")
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")

CHECKIN_SYSTEM_PROMPT = """You are the CheckInOps Agent for CommunityOps — you help volunteers recover tickets and check in attendees.

Your workflow:
1. Search for the registration using the provided identifier (registration ID, email, phone, or name)
2. If multiple matches found, ask for additional identifying information — NEVER auto-select
3. If registration found, run deterministic verification checks
4. If all checks pass, generate/recover the ticket
5. Ticket ID always equals Registration ID — never create a new identity
6. If registration not found, attempt payment reconciliation
7. If nothing found, create an UNRESOLVED recovery case

Tools you can use:
- registration_lookup: Look up registration by ID, email, phone, or name
- payment_lookup: Look up payment by transaction reference
- verify_registration: Run deterministic verification pipeline
- generate_ticket: Create PDF ticket with signed QR code
- complete_checkin: Mark attendee as checked in

Rules:
- NEVER invent or guess registration status. Use the lookup tool.
- NEVER claim "registration does not exist" when the system is unavailable. Say "could not be verified."
- NEVER collect card numbers, CVVs, PINs, or banking passwords.
- If the system is unavailable, create a recovery case for manual follow-up.
- Already checked-in attendees: return success with existing timestamp, no error.
"""


def create_checkin_agent() -> Any:
    """Initialize the CheckInOps Agent."""
    try:
        from strands import Agent
        from strands.models.bedrock import BedrockModel

        from tools.payment.lookup import payment_lookup_tool
        from tools.registration.lookup import registration_lookup_tool

        model = BedrockModel(
            model_id=BEDROCK_MODEL_ID,
            region_name=BEDROCK_REGION,
        )

        agent = Agent(
            model=model,
            system_prompt=CHECKIN_SYSTEM_PROMPT,
            tools=[registration_lookup_tool, payment_lookup_tool],
        )

        return agent

    except ImportError:
        logger.warning("strands-agents not installed. CheckInOps agent unavailable.")
        return None
    except Exception:
        logger.error("Failed to create CheckInOps Agent", exc_info=True)
        return None
