"""AttendeeOps Agent — attendee logistics specialist.

Handles: missing information identification, dietary requirements,
accommodation needs, accessibility requirements, communication segmentation.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-sonnet-4-20250514-v1:0")
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")

ATTENDEE_SYSTEM_PROMPT = """You are the AttendeeOps Agent for OrbitOps — you ensure attendee logistics are complete before events.

Responsibilities:
- Identify missing attendee information (dietary, accommodation, arrival, accessibility)
- Prepare outreach messages for missing information
- Track response rates and flag deadlines
- Segment attendees for targeted communication (VIP, speakers, first-time, etc.)

Rules:
- Handle PII carefully — minimize what's logged or sent to models
- When identifying missing fields, be specific about what's needed and why
- Provide actionable summaries: "28 of 286 attendees missing dietary info, 5 hours until deadline"
"""


def create_attendee_agent() -> Any:
    """Initialize the AttendeeOps Agent."""
    try:
        from strands import Agent
        from strands.models.bedrock import BedrockModel

        model = BedrockModel(
            model_id=BEDROCK_MODEL_ID,
            region_name=BEDROCK_REGION,
        )

        agent = Agent(
            model=model,
            system_prompt=ATTENDEE_SYSTEM_PROMPT,
            tools=[],
        )

        return agent

    except ImportError:
        logger.warning("strands-agents not installed. AttendeeOps agent unavailable.")
        return None
    except Exception:
        logger.error("Failed to create AttendeeOps Agent", exc_info=True)
        return None
