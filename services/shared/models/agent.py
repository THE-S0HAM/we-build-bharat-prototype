"""Agent observability records.

``AgentActivity`` is the operator-facing feed of what the agent has been doing. It is
distinct from the audit log: the audit log is the immutable compliance record of every
consequential action, while agent activity is the readable "here is what I handled"
summary the leader sees in the command centre.

``ChatTurn`` persists the operations chat so a conversation survives a page reload and
so the tools an answer relied on remain inspectable afterwards. Turns are stored under a
``USER#`` sort key: a conversation belongs to a principal, not to an event.
"""

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import Field

from services.shared.models.base import DomainEntity


class AgentActivityOutcome(str, Enum):
    COMPLETED = "COMPLETED"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    BLOCKED = "BLOCKED"
    FAILED = "FAILED"


class AgentActivity(DomainEntity):
    """One thing the agent did or prepared, shown in the agent activity feed."""

    event_id: str = Field(..., min_length=1)
    activity_id: str = Field(..., min_length=1)
    agent_name: str = Field(default="CommunityOps", max_length=100)
    summary: str = Field(..., min_length=1, max_length=500)
    detail: str = Field(default="", max_length=2000)
    outcome: AgentActivityOutcome = AgentActivityOutcome.COMPLETED

    tool_used: str = ""
    risk_action: str = Field(default="", description="Policy action name evaluated")
    approval_id: str | None = None
    resource_type: str = ""
    resource_id: str = ""
    occurred_at: datetime | None = None


class ChatRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"


class ChatTurn(DomainEntity):
    """One persisted turn of the operations chat."""

    session_id: str = Field(..., min_length=1)
    sequence: int = Field(..., ge=0, description="Monotonic turn index within the session")
    user_id: str = Field(..., min_length=1)
    event_id: str = ""
    role: ChatRole
    content: str = Field(default="", max_length=20000)

    # What the assistant turn actually relied on, so an answer stays inspectable.
    tools_used: list[str] = Field(default_factory=list)
    approvals_created: list[str] = Field(default_factory=list)
    citations: list[dict[str, Any]] = Field(
        default_factory=list, description="Resource references backing the answer"
    )
    fun_mode: bool = False
