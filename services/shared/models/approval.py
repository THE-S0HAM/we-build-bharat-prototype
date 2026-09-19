"""Approval model for human-in-the-loop decisions."""

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import Field

from services.shared.models.base import DomainEntity, utc_now


class ApprovalStatus(str, Enum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    DECLINED = "DECLINED"
    EXPIRED = "EXPIRED"
    EDITED = "EDITED"


class RiskLevel(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class Approval(DomainEntity):
    """A human approval request for a consequential agent action.

    The agent creates an Approval when policy requires human sign-off.
    The UI shows what the agent wants to do, why, the evidence used,
    and lets the leader approve, edit, or decline.
    """

    event_id: str = Field(..., min_length=1)
    approval_id: str = Field(..., min_length=1)
    title: str = Field(..., min_length=1, max_length=500)
    description: str = ""
    status: ApprovalStatus = ApprovalStatus.PENDING
    risk_level: RiskLevel = RiskLevel.MEDIUM

    # What the agent wants to do
    requested_action: str = Field(
        ..., description="e.g., SEND_SPEAKER_FOLLOWUP, BOOK_ACCOMMODATION"
    )
    reason: str = Field(default="", description="Why the agent recommends this action")
    evidence: dict[str, Any] = Field(
        default_factory=dict, description="Data supporting the decision"
    )
    affected_resource_type: str = ""
    affected_resource_id: str = ""

    # Financial impact. Zero means the request has no budget consequence, which is what
    # the approval handler checks before touching the budget at all.
    amount_inr: int = Field(default=0, ge=0, description="Whole rupees; 0 = non-financial")
    currency: str = Field(default="INR", max_length=3)
    budget_category: str = Field(default="", description="BudgetCategory value when financial")
    budget_impact: str = Field(
        default="", description="Human-readable effect, e.g. 'Remaining 75,000 -> 62,500'"
    )

    # Who asked. A team member may request; only a leader may decide.
    requested_by: str = ""
    requested_by_name: str = ""
    requested_by_role: str = ""

    # Agent context
    agent_name: str = Field(default="", description="Which specialist agent requested this")
    agent_recommendation: str = Field(
        default="", description="What the agent advises the leader to do"
    )
    workflow_execution_id: str = ""
    tool_name: str = ""

    # Decision
    decided_by: str = ""
    decided_at: datetime | None = None
    decision_notes: str = ""
    edited_action: str = Field(default="", description="If leader edited the proposed action")

    # Expiry
    expires_at: datetime | None = None
    requested_at: datetime = Field(default_factory=utc_now)
