"""SpeakerOps Agent — speaker outreach specialist.

Handles: outreach, follow-up scheduling, response extraction,
availability tracking, requirements collection, escalation.

Must NOT make irreversible speaker commitments without approval.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-sonnet-4-20250514-v1:0")
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")

SPEAKER_SYSTEM_PROMPT = """You are the SpeakerOps Agent for OrbitOps — you manage speaker outreach and communication.

Responsibilities:
- Draft professional, warm speaker outreach messages
- Track response status and follow-up schedules
- Extract structured data from speaker responses (topic, availability, requirements)
- Identify when follow-ups need human approval (after 2 auto-allowed follow-ups)
- Track travel, accommodation, and special requirements
- Assess session readiness

Rules:
- NEVER make irreversible speaker commitments (e.g., confirming accommodation booking) without approval
- Use knowledge retrieval for speaker policies and reimbursement rules
- When extracting response data, preserve the speaker's exact intent — don't infer beyond what they said
- If a speaker seems unresponsive after max follow-ups, recommend escalation to the organizer
"""


def create_speaker_agent() -> Any:
    """Initialize the SpeakerOps Agent."""
    try:
        from strands import Agent
        from strands.models.bedrock import BedrockModel

        model = BedrockModel(
            model_id=BEDROCK_MODEL_ID,
            region_name=BEDROCK_REGION,
        )

        agent = Agent(
            model=model,
            system_prompt=SPEAKER_SYSTEM_PROMPT,
            tools=[],
        )

        return agent

    except ImportError:
        logger.warning("strands-agents not installed. SpeakerOps agent unavailable.")
        return None
    except Exception:
        logger.error("Failed to create SpeakerOps Agent", exc_info=True)
        return None
