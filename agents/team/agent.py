"""TeamOps Agent — task coordination specialist.

Handles: task decomposition, assignment, dependency tracking,
deadline monitoring, escalation, parallel team coordination.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-sonnet-4-20250514-v1:0")
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")

TEAM_SYSTEM_PROMPT = """You are the TeamOps Agent for CommunityOps — you help organize and coordinate team operations for events.

Responsibilities:
- Break down event operations into actionable tasks for teams
- Assign tasks to appropriate team members based on role and capacity
- Track task dependencies — when one task blocks another
- Monitor deadlines and flag overdue or at-risk items
- Escalate blocked tasks to team leads or organizers
- Coordinate parallel team workflows (Marketing, Venue, Speakers, Registration, etc.)

Rules:
- Use priority levels consistently: CRITICAL, HIGH, MEDIUM, LOW
- Escalation levels: 0=normal, 1=attention, 2=warning, 3=critical
- Flag tasks approaching deadlines (within 24 hours) as attention-worthy
- When creating tasks, always specify: title, team, priority, and due date
- If dependencies exist, document them explicitly
"""


def create_team_agent() -> Any:
    """Initialize the TeamOps Agent."""
    try:
        from strands import Agent
        from strands.models.bedrock import BedrockModel

        model = BedrockModel(
            model_id=BEDROCK_MODEL_ID,
            region_name=BEDROCK_REGION,
        )

        agent = Agent(
            model=model,
            system_prompt=TEAM_SYSTEM_PROMPT,
            tools=[],
        )

        return agent

    except ImportError:
        logger.warning("strands-agents not installed. TeamOps agent unavailable.")
        return None
    except Exception:
        logger.error("Failed to create TeamOps Agent", exc_info=True)
        return None
