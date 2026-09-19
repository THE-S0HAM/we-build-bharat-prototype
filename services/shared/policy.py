"""Authority evaluation for CommunityOps.

This module decides whether an action may proceed, must wait for a human, or must be
refused outright. It is the application-level enforcement point: authority is never left
to prompt wording, because a prompt is input and input can be adversarial.

Cedar's role
------------
``policies/cedar/communityops.cedar`` and its schema are the *declarative specification*
of this model. They are not the runtime engine. Two reasons:

1. ``cedarpy`` is excluded from the deployment artifact on purpose — see the note in
   ``requirements.txt`` about bundle size — so it cannot be relied on inside Lambda.
2. Running both a Cedar evaluator and this table would mean two authorization models
   that can disagree, and a disagreement about authority resolves in whichever one the
   caller happens to consult.

So there is one engine, here, and ``tests/unit/test_policy_consistency.py`` parses the
Cedar files and fails if they and this table stop describing the same thing. Drift
becomes a red test instead of a silent divergence. Earlier the two had already drifted:
four actions existed in one artifact and not the other.

Risk tiers
----------
``LOW``    proceed. Reading state, drafting text, creating internal work.
``MEDIUM`` proceed if the caller holds an operational role; always audited.
``HIGH``   requires a human approval record before it may execute.
``NEVER``  never executes autonomously, even with an approval attached. Only a human
           acting directly may do it.

Unknown actions are ``HIGH``. A tool added without registering its action here is
approval-gated rather than permitted, so forgetting to classify something is safe.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING

logger = logging.getLogger(__name__)

if TYPE_CHECKING:  # pragma: no cover - import cycle guard, types only
    from services.shared.principal import Principal

# Location of the declarative Cedar specification. Read by the consistency test, not by
# the runtime path — see the module docstring.
CEDAR_POLICIES_DIR = os.environ.get(
    "CEDAR_POLICIES_DIR",
    str(Path(__file__).parent.parent.parent / "policies" / "cedar"),
)


class PolicyDecision(str, Enum):
    ALLOW = "ALLOW"
    DENY = "DENY"
    REQUIRES_APPROVAL = "REQUIRES_APPROVAL"


class RiskTier(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    NEVER = "NEVER"


@dataclass
class PolicyResult:
    decision: PolicyDecision
    reason: str
    policy_id: str = ""
    risk_tier: str = ""

    @property
    def allowed(self) -> bool:
        return self.decision is PolicyDecision.ALLOW

    @property
    def needs_approval(self) -> bool:
        return self.decision is PolicyDecision.REQUIRES_APPROVAL


# Roles permitted to perform MEDIUM-risk actions. `LEADER` is the current role model;
# the others predate it and are retained because existing records and tests use them.
OPERATIONAL_ROLES: frozenset[str] = frozenset({"LEADER", "OWNER", "ADMIN", "ORGANIZER"})


# ---------------------------------------------------------------------------
# The action catalogue. Every agent tool and every consequential handler names an
# action from this table. Adding a row is how new capability is classified.
# ---------------------------------------------------------------------------
ACTION_RISK_LEVELS: dict[str, str] = {
    # -- LOW: no lasting external consequence, reversible, internal only -------
    "ReadOperationalState": "LOW",
    "SummarizeData": "LOW",
    "CreateInternalTask": "LOW",
    "AssignTask": "LOW",
    "UpdateTask": "LOW",
    "CompleteTask": "LOW",
    "SendInternalReminder": "LOW",
    "ScheduleReminder": "LOW",
    "DraftMessage": "LOW",
    "GenerateDraft": "LOW",
    "AddIncidentComment": "LOW",
    "CreateIncident": "LOW",
    "CreateTeam": "LOW",
    "UpdateTeam": "LOW",
    "AssignTeamMember": "LOW",
    "ReadNotifications": "LOW",
    "ComputeEventHealth": "LOW",
    "GenerateEventBrief": "LOW",
    "SearchEventDocuments": "LOW",
    # -- MEDIUM: real operational effect, needs an operational role, audited ---
    "SendRoutineCommunication": "MEDIUM",
    "UpdateEventMetadata": "MEDIUM",
    "CreateEvent": "MEDIUM",
    "GenerateTicket": "MEDIUM",
    "CompleteCheckIn": "MEDIUM",
    "SendSpeakerFollowup": "MEDIUM",
    "UpdateIncident": "MEDIUM",
    "AcknowledgeIncident": "MEDIUM",
    "EscalateIncident": "MEDIUM",
    "UploadDocument": "MEDIUM",
    "RequestApproval": "MEDIUM",
    "ReassignTask": "MEDIUM",
    "UpdateSpeaker": "MEDIUM",
    # -- HIGH: money, irreversibility, or someone outside the organization -----
    "ProcessRefund": "HIGH",
    "BookAccommodation": "HIGH",
    "AccommodationCommitment": "HIGH",
    "ConfirmSpeaker": "HIGH",
    "CancelRegistration": "HIGH",
    "ModifyPublishedEvent": "HIGH",
    "ResolveIncident": "HIGH",
    "SendExternalSpeakerMessage": "HIGH",
    "ApproveExpenditure": "HIGH",
    "FinancialCommitment": "HIGH",
    "AllocateBudget": "HIGH",
    "RecordExpense": "HIGH",
    "RevokeTicket": "HIGH",
    "ArchiveEvent": "HIGH",
    "DecideApproval": "HIGH",
    # -- NEVER: outside what an autonomous system may do at all ---------------
    "ContractSigning": "NEVER",
    "ModifyAuthorizationPolicy": "NEVER",
    "DeleteAuditRecord": "NEVER",
}


def risk_tier_for(action: str) -> RiskTier:
    """The tier for an action, defaulting to HIGH for anything unregistered."""
    return RiskTier(ACTION_RISK_LEVELS.get(action, "HIGH"))


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

    Order matters. The tenant check runs first and unconditionally, so a cross-tenant
    request is refused even for a LOW-risk read: crossing a tenant boundary is the
    failure, not the sensitivity of what was read.

    Steps:
    1. Tenant isolation — organization ids must match.
    2. ``NEVER`` — refuse, regardless of approval.
    3. ``HIGH``  — allow only with an approval, otherwise require one.
    4. ``MEDIUM``— allow only for an operational role.
    5. ``LOW``   — allow.

    Args:
        principal_id: recorded by callers for audit; not used in the decision, because
            authority here derives from role and tenancy rather than identity.
        has_approval: whether a decided, approved ``Approval`` record backs this call.
    """
    if principal_org_id != resource_org_id:
        return PolicyResult(
            decision=PolicyDecision.DENY,
            reason="Tenant boundary violation: principal and resource organizations do not match",
            policy_id="tenant-isolation",
            risk_tier=RiskTier.HIGH.value,
        )

    tier = risk_tier_for(action)

    if tier is RiskTier.NEVER:
        # An approval cannot unlock this. If a human wants it done, a human does it
        # directly; the point of the tier is that no automated path exists.
        return PolicyResult(
            decision=PolicyDecision.DENY,
            reason=(
                f"Action {action} may never be performed autonomously, with or without an approval."
            ),
            policy_id="never-autonomous",
            risk_tier=tier.value,
        )

    if tier is RiskTier.HIGH:
        if has_approval:
            return PolicyResult(
                decision=PolicyDecision.ALLOW,
                reason=f"Action {action} permitted with approval",
                policy_id="high-risk-with-approval",
                risk_tier=tier.value,
            )
        return PolicyResult(
            decision=PolicyDecision.REQUIRES_APPROVAL,
            reason=f"Action {action} is HIGH_RISK and requires human approval",
            policy_id="high-risk-requires-approval",
            risk_tier=tier.value,
        )

    if tier is RiskTier.MEDIUM:
        if principal_role in OPERATIONAL_ROLES:
            return PolicyResult(
                decision=PolicyDecision.ALLOW,
                reason=f"Action {action} permitted for role {principal_role}",
                policy_id="medium-risk-role-check",
                risk_tier=tier.value,
            )
        return PolicyResult(
            decision=PolicyDecision.DENY,
            reason=f"Action {action} requires ORGANIZER role or higher, got {principal_role}",
            policy_id="medium-risk-role-check",
            risk_tier=tier.value,
        )

    return PolicyResult(
        decision=PolicyDecision.ALLOW,
        reason=f"Action {action} is LOW_RISK — permitted",
        policy_id="low-risk-allow",
        risk_tier=tier.value,
    )


def evaluate_for_principal(
    action: str,
    principal: Principal,
    resource_org_id: str,
    *,
    has_approval: bool = False,
) -> PolicyResult:
    """Evaluate an action for a resolved :class:`~services.shared.principal.Principal`.

    The convenience form used by agent tools and handlers. It picks the principal's
    organization that matches the resource before delegating, so a user who belongs to
    several organizations is evaluated against the one they are actually acting in
    rather than an arbitrary member of their set.
    """
    principal_org = resource_org_id if resource_org_id in principal.organizations else ""
    return evaluate_policy(
        action,
        principal.user_id,
        principal.role.value,
        resource_org_id,
        principal_org,
        has_approval=has_approval,
    )
