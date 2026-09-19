"""The Cedar specification and the runtime engine must describe the same model.

Before this test existed the two had drifted: ``GenerateTicket``, ``CompleteCheckIn`` and
``SendSpeakerFollowup`` were classified in the code but had no Cedar rule at all, and
``CreateIncident`` appeared only in the schema. Under a real Cedar evaluator the first
three would have been implicitly denied and the fourth would have had no tier — a
divergence in *authority*, which is the one thing that must not quietly disagree.

So these tests parse the checked-in Cedar files independently of the generator and assert
they reconstruct the runtime catalogue exactly. Adding an action to
``ACTION_RISK_LEVELS`` without regenerating the specification fails here.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from services.shared.policy import (
    ACTION_RISK_LEVELS,
    OPERATIONAL_ROLES,
    PolicyDecision,
    RiskTier,
    evaluate_policy,
    risk_tier_for,
)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CEDAR_DIR = REPO_ROOT / "policies" / "cedar"
POLICY_FILE = CEDAR_DIR / "communityops.cedar"
SCHEMA_FILE = CEDAR_DIR / "schema.cedarschema.json"

# One Cedar statement: effect, the quoted action name, and everything up to the
# terminating semicolon so the guard clause (if any) is captured.
_STATEMENT = re.compile(
    r"(?P<effect>permit|forbid)\s*\(\s*principal\s*,\s*"
    r'action\s*==\s*Action::"(?P<action>[A-Za-z]+)"\s*,\s*'
    r"resource\s*\)(?P<guard>[^;]*);",
    re.MULTILINE,
)


def parse_cedar_tiers(source: str) -> dict[str, str]:
    """Reconstruct the action -> tier mapping from Cedar statement shapes.

    The mapping is structural rather than annotation-based so the test reads the policy
    as an evaluator would, not as the generator wrote it. A rule that says the wrong
    thing is caught even if its comment says the right thing.
    """
    tiers: dict[str, str] = {}
    for match in _STATEMENT.finditer(source):
        effect = match.group("effect")
        action = match.group("action")
        guard = match.group("guard").strip()

        if effect == "permit":
            tiers[action] = "LOW" if not guard else "MEDIUM"
        elif not guard:
            tiers[action] = "NEVER"
        elif "has_approval" in guard:
            tiers[action] = "HIGH"
        else:  # pragma: no cover - would be a malformed specification
            pytest.fail(f"Cedar rule for {action} has an unrecognised guard: {guard!r}")
    return tiers


@pytest.fixture(scope="module")
def cedar_source() -> str:
    assert POLICY_FILE.exists(), f"Missing Cedar policy file at {POLICY_FILE}"
    return POLICY_FILE.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def cedar_schema() -> dict:
    assert SCHEMA_FILE.exists(), f"Missing Cedar schema at {SCHEMA_FILE}"
    return json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))


class TestSpecificationMatchesEngine:
    def test_every_action_has_a_cedar_rule(self, cedar_source: str) -> None:
        parsed = parse_cedar_tiers(cedar_source)
        missing = sorted(set(ACTION_RISK_LEVELS) - set(parsed))
        assert not missing, (
            "These actions are classified in ACTION_RISK_LEVELS but have no Cedar rule. "
            "Run: python scripts/generate-cedar-policies.py\n"
            f"{missing}"
        )

    def test_no_cedar_rule_without_a_classification(self, cedar_source: str) -> None:
        parsed = parse_cedar_tiers(cedar_source)
        extra = sorted(set(parsed) - set(ACTION_RISK_LEVELS))
        assert not extra, (
            "These actions have a Cedar rule but no entry in ACTION_RISK_LEVELS, so the "
            "runtime engine would treat them as unknown.\n"
            f"{extra}"
        )

    def test_tiers_agree(self, cedar_source: str) -> None:
        parsed = parse_cedar_tiers(cedar_source)
        disagreements = {
            action: (tier, parsed[action])
            for action, tier in ACTION_RISK_LEVELS.items()
            if action in parsed and parsed[action] != tier
        }
        assert not disagreements, (
            "Risk tier disagreements as {action: (engine, cedar)}. A disagreement about "
            "authority resolves in whichever artifact the caller consults, which is the "
            "failure this test exists to prevent.\n"
            f"{disagreements}"
        )

    def test_schema_actions_match_the_catalogue(self, cedar_schema: dict) -> None:
        schema_actions = set(cedar_schema["CommunityOps"]["actions"])
        assert schema_actions == set(ACTION_RISK_LEVELS)

    def test_schema_annotations_match_the_catalogue(self, cedar_schema: dict) -> None:
        annotated = {
            action: spec["annotations"]["riskTier"]
            for action, spec in cedar_schema["CommunityOps"]["actions"].items()
        }
        assert annotated == ACTION_RISK_LEVELS

    def test_medium_risk_guard_lists_the_operational_roles(self, cedar_source: str) -> None:
        """The MEDIUM guard must name the same roles the engine accepts.

        The previous hand-written policy permitted only ORGANIZER and ADMIN while the
        engine also accepted OWNER, so the specification was stricter than the
        implementation.
        """
        medium_rules = [
            match.group("guard")
            for match in _STATEMENT.finditer(cedar_source)
            if match.group("effect") == "permit" and match.group("guard").strip()
        ]
        assert medium_rules, "Expected at least one MEDIUM-risk permit rule"
        for guard in medium_rules:
            for role in OPERATIONAL_ROLES:
                assert f'principal.role == "{role}"' in guard, (
                    f"MEDIUM guard omits role {role} that the engine accepts: {guard!r}"
                )

    def test_tenant_isolation_rule_is_present(self, cedar_source: str) -> None:
        assert "principal.organization_id == resource.organization_id" in cedar_source

    def test_generator_output_is_checked_in(self) -> None:
        """The checked-in files are what the generator produces right now."""
        result = subprocess.run(
            [sys.executable, "scripts/generate-cedar-policies.py", "--check"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stdout + result.stderr


class TestNeverAutonomousTier:
    """NEVER means an approval does not help. That is the whole point of the tier."""

    def test_contract_signing_is_never_autonomous(self) -> None:
        assert risk_tier_for("ContractSigning") is RiskTier.NEVER

    def test_approval_does_not_unlock_a_never_action(self) -> None:
        result = evaluate_policy(
            "ContractSigning",
            "user-1",
            "LEADER",
            "ORG-a",
            "ORG-a",
            has_approval=True,
        )
        assert result.decision is PolicyDecision.DENY
        assert result.policy_id == "never-autonomous"

    def test_policy_and_audit_mutation_are_never_autonomous(self) -> None:
        for action in ("ModifyAuthorizationPolicy", "DeleteAuditRecord"):
            result = evaluate_policy(action, "u", "LEADER", "ORG-a", "ORG-a", has_approval=True)
            assert result.decision is PolicyDecision.DENY, action


class TestFailClosed:
    def test_unregistered_action_requires_approval(self) -> None:
        assert risk_tier_for("SomethingNobodyClassified") is RiskTier.HIGH

    def test_leader_is_an_operational_role(self) -> None:
        """The new role model must satisfy the MEDIUM tier, or leaders lose capability."""
        result = evaluate_policy("GenerateTicket", "user-1", "LEADER", "ORG-a", "ORG-a")
        assert result.decision is PolicyDecision.ALLOW

    def test_team_member_cannot_perform_medium_risk_actions(self) -> None:
        result = evaluate_policy("GenerateTicket", "user-1", "TEAM_MEMBER", "ORG-a", "ORG-a")
        assert result.decision is PolicyDecision.DENY
