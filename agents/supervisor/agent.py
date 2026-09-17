"""Supervisor Agent — the orchestrator.

Understands operational intent, selects the appropriate specialist,
coordinates multi-step work, aggregates results, and decides whether
to request human approval.

Uses Strands Agents SDK with Amazon Bedrock.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-sonnet-4-20250514-v1:0")
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")

SUPERVISOR_SYSTEM_PROMPT = """You are the OrbitOps Supervisor Agent — an AI operations coordinator for community-led events.

Your role:
1. Understand the operational intent from the user's message
2. Select the appropriate specialist agent or tool
3. Coordinate multi-step work
4. Request human approval when required by policy
5. Explain reasoning in concise operational language

Specialists available:
- CheckInOps: Ticket recovery, registration lookup, payment reconciliation, check-in
- SpeakerOps: Speaker outreach, follow-ups, availability, requirements
- TeamOps: Task management, deadlines, dependencies, escalation
- AttendeeOps: Missing attendee info, dietary, accommodation, communication
- IncidentOps: Risk detection, impact analysis, backup options, incident resolution

Fundamental rules:
- NEVER invent or infer transactional facts. Use tools to look them up.
- NEVER bypass policy checks.
- ALWAYS request human approval for HIGH_RISK actions.
- If evidence is insufficient, state uncertainty clearly.
- Use tools for structured data. Use knowledge retrieval for policies/procedures.

Agent loop: Observe → Retrieve → Reason → Policy check → Approval if needed → Execute → Verify → Audit → Re-evaluate
"""


def create_supervisor_agent() -> Any:
    """Initialize the Supervisor Agent with Strands SDK.

    Returns the configured agent instance. The caller invokes
    agent(prompt) to run a conversation turn.
    """
    try:
        from strands import Agent
        from strands.models.bedrock import BedrockModel

        model = BedrockModel(
            model_id=BEDROCK_MODEL_ID,
            region_name=BEDROCK_REGION,
        )

        agent = Agent(
            model=model,
            system_prompt=SUPERVISOR_SYSTEM_PROMPT,
            tools=[],  # Tools registered below
        )

        return agent

    except ImportError:
        logger.warning("strands-agents not installed. Agent features unavailable.")
        return None
    except Exception:
        logger.error("Failed to create Supervisor Agent", exc_info=True)
        return None
