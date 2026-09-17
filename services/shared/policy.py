"""Cedar policy evaluation for OrbitOps.

Evaluates Cedar policies to determine whether an action is allowed,
requires approval, or is forbidden. This is the application-level
policy enforcement layer — not relying on prompts alone for authorization.

For MVP, uses cedarpy for local policy evaluation. In production,
this could be backed by Amazon Verified Permissions.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

CEDAR_POLICIES_DIR = os.environ.get(
    "CEDAR_POLICIES_DIR",
    str(Path(__file__).parent.parent.parent / "policies" / "cedar"),
)


class PolicyDecision(str, Enum):
    ALLOW = "ALLOW"
    DENY = "DENY"
    REQUIRES_APPROVAL = "REQUIRES_APPROVAL"


@dataclass
class PolicyResult:
    decision: PolicyDecision
    reason: str
    policy_id: str = ""


# Risk level classification for actions
ACTION_RISK_LEVELS: dict[str, str] = {
    # LOW RISK — agents may perform without approval
    "ReadOperationalState": "LOW",
    "CreateInternalTask": "LOW",
    "DraftMessage": "LOW",
    "ScheduleReminder": "LOW",
    "SummarizeData": "LOW",
    # MEDIUM RISK — allowed for organizers, logged
    "SendRoutineCommunication": "MEDIUM",
    "UpdateEventMetadata": "MEDIUM",
    "GenerateTicket": "MEDIUM",
    "CompleteCheckIn": "MEDIUM",
    "SendSpeakerFollowup": "MEDIUM",
    # HIGH RISK — require human approval
    "ProcessRefund": "HIGH",
    "BookAccommodation": "HIGH",
    "ConfirmSpeaker": "HIGH",
    "CancelRegistration": "HIGH",
    "ModifyPublishedEvent": "HIGH",
    "ResolveIncident": "HIGH",
}


def evaluate_policy(
    action: str,
    principal_id: str,
    principal_role: str,
    resource_org_id: str,
    principal_org_id: str,
    *,
    has_approval: bool = False,
) -> PolicyResult:
    """Evaluate whether an action is permitted.

    This implements the policy logic from our Cedar policies in Python
    for the MVP. A production system would call cedarpy or Amazon
    Verified Permissions.

    Steps:
    1. Check tenant isolation (org IDs must match)
    2. Check action risk level
    3. For HIGH_RISK: require approval
    4. For MEDIUM_RISK: require ORGANIZER or ADMIN role
    5. For LOW_RISK: allow
    """
    # Tenant isolation — always enforced
    if principal_org_id != resource_org_id:
        return PolicyResult(
            decision=PolicyDecision.DENY,
            reason="Tenant boundary violation: principal and resource organizations do not match",
            policy_id="tenant-isolation",
        )

    risk_level = ACTION_RISK_LEVELS.get(action, "HIGH")

    # HIGH RISK — require approval
    if risk_level == "HIGH":
        if has_approval:
            return PolicyResult(
                decision=PolicyDecision.ALLOW,
                reason=f"Action {action} permitted with approval",
                policy_id="high-risk-with-approval",
            )
        return PolicyResult(
            decision=PolicyDecision.REQUIRES_APPROVAL,
            reason=f"Action {action} is HIGH_RISK and requires human approval",
            policy_id="high-risk-requires-approval",
        )

    # MEDIUM RISK — require appropriate role
    if risk_level == "MEDIUM":
        allowed_roles = {"OWNER", "ADMIN", "ORGANIZER"}
        if principal_role in allowed_roles:
            return PolicyResult(
                decision=PolicyDecision.ALLOW,
                reason=f"Action {action} permitted for role {principal_role}",
                policy_id="medium-risk-role-check",
            )
        return PolicyResult(
            decision=PolicyDecision.DENY,
            reason=f"Action {action} requires ORGANIZER role or higher, got {principal_role}",
            policy_id="medium-risk-role-check",
        )

    # LOW RISK — allow
    return PolicyResult(
        decision=PolicyDecision.ALLOW,
        reason=f"Action {action} is LOW_RISK — permitted",
        policy_id="low-risk-allow",
    )
