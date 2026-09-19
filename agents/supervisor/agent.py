"""Strands front end for the CommunityOps agent.

The deployed conversation runs through :mod:`agents.runtime`, a Bedrock Converse loop, for the
bundle-size reason documented there. This module is the Strands Agents SDK path over the *same*
tool registry, for local development and for anyone running the agent outside Lambda.

What changed and why it matters
-------------------------------
This factory previously constructed an ``Agent`` with ``tools=[]`` and a comment saying "tools
registered below", with nothing below. Its system prompt advertised five capabilities of which
two existed. Nothing in the repository called it. It was scaffolding that described a system
rather than being one.

It now builds its tools from :mod:`tools.community_ops` via
:func:`agents.runtime.build_strands_tools`, so every call goes through
``ToolRegistry.invoke`` and gets the identical validation, scope check, policy evaluation,
approval gating and audit as the deployed path. There is one definition of what the agent can
do, and neither front end can bypass it.

A principal is required to build an agent, because the tool set depends on the caller's role.
There is no such thing as a general-purpose CommunityOps agent: authority is part of its
construction, not a filter applied to its output.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from services.shared.principal import Principal

logger = logging.getLogger(__name__)

BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-sonnet-4-20250514-v1:0")
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")


def create_supervisor_agent(
    principal: Principal,
    organization_id: str,
    *,
    event_id: str = "",
    fun_mode: bool = False,
    table_name: str | None = None,
) -> Any:
    """Build a Strands agent scoped to one principal.

    Returns ``None`` when ``strands-agents`` is not installed, which is the normal state inside
    Lambda: the dependency is deliberately excluded from the deployment artifact, and the
    Converse runtime is used there instead. Callers must handle ``None`` rather than assume an
    agent came back.

    The system prompt and the tool catalogue both come from the shared runtime, so a Strands
    session and a deployed chat turn are given the same instructions and the same capabilities.
    """
    try:
        from strands import Agent
        from strands.models.bedrock import BedrockModel

        from agents.runtime import (
            MAX_OUTPUT_TOKENS,
            TEMPERATURE,
            build_strands_tools,
            build_system_prompt,
        )

        tools = build_strands_tools(
            principal,
            organization_id,
            event_id=event_id,
            table_name=table_name,
        )

        model = BedrockModel(
            model_id=BEDROCK_MODEL_ID,
            region_name=BEDROCK_REGION,
            temperature=TEMPERATURE,
            max_tokens=MAX_OUTPUT_TOKENS,
        )

        agent = Agent(
            model=model,
            system_prompt=build_system_prompt(principal, fun_mode=fun_mode),
            tools=tools,
        )

        logger.info(
            "Built Strands agent",
            extra={"role": principal.role.value, "tool_count": len(tools)},
        )
        return agent

    except ImportError:
        # Expected in Lambda. The Converse runtime in agents.runtime is the deployed path.
        logger.info(
            "strands-agents is not installed; use agents.runtime.run_turn instead, which is "
            "what the deployed stack uses."
        )
        return None
    except Exception:
        logger.error("Failed to build the Strands agent", exc_info=True)
        return None
