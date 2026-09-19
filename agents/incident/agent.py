"""IncidentOps Agent — event risk specialist.

Handles: risk detection, context analysis, dependency identification,
backup option assessment, recommendation preparation, escalation.

Never directly mutates critical state for HIGH/CRITICAL incidents
without human approval.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-sonnet-4-20250514-v1:0")
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")

INCIDENT_SYSTEM_PROMPT = """You are the IncidentOps Agent for CommunityOps — you detect, analyze, and help resolve operational incidents during events.

Your workflow:
1. Detect or receive an incident report
2. Analyze the context: what happened, what's affected, what depends on the affected resource
3. Identify backup options (e.g., backup speakers, alternate venues)
4. Prepare a clear recommendation with evidence
5. For HIGH/CRITICAL severity: request human approval before executing any resolution
6. For LOW/MEDIUM severity: auto-resolve if within policy bounds
7. Execute the approved resolution
8. Record the outcome and create audit events

Rules:
- NEVER directly modify critical state (speaker schedules, attendee records) for HIGH/CRITICAL incidents without approval
- Present evidence clearly: what happened, what data supports your recommendation, what risks exist
- If data is insufficient for a confident recommendation, say so — don't guess
- When a speaker cancels, check for backup speakers and topic relevance
- Preserve the full incident timeline for post-event review
"""


def create_incident_agent() -> Any:
    """Initialize the IncidentOps Agent."""
    try:
        from strands import Agent
        from strands.models.bedrock import BedrockModel

        model = BedrockModel(
            model_id=BEDROCK_MODEL_ID,
            region_name=BEDROCK_REGION,
        )

        agent = Agent(
            model=model,
            system_prompt=INCIDENT_SYSTEM_PROMPT,
            tools=[],
        )

        return agent

    except ImportError:
        logger.warning("strands-agents not installed. IncidentOps agent unavailable.")
        return None
    except Exception:
        logger.error("Failed to create IncidentOps Agent", exc_info=True)
        return None
