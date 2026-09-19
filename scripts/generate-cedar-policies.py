#!/usr/bin/env python3
"""Regenerate the Cedar specification from the runtime action catalogue.

``services/shared/policy.py`` is the enforcement engine and ``policies/cedar/`` is the
declarative specification of the same model. Keeping two hand-maintained artifacts in
step failed before: four actions ended up in one and not the other, and nothing
complained.

So the specification is generated from the catalogue, and
``tests/unit/test_policy_consistency.py`` fails if the checked-in files no longer match
what this script would produce. Adding an action to ``ACTION_RISK_LEVELS`` and forgetting
to run this is a test failure, not a silent divergence.

Encoding of tiers in Cedar, which the consistency test parses back out:

    LOW     permit, unconditional
    MEDIUM  permit, guarded by an operational-role condition
    HIGH    forbid, unless an approval is present in context
    NEVER   forbid, unconditional — no escape clause exists

Usage:
    python scripts/generate-cedar-policies.py            # write the files
    python scripts/generate-cedar-policies.py --check    # exit 1 if out of date
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from services.shared.policy import ACTION_RISK_LEVELS, OPERATIONAL_ROLES  # noqa: E402

CEDAR_DIR = REPO_ROOT / "policies" / "cedar"
POLICY_FILE = CEDAR_DIR / "communityops.cedar"
SCHEMA_FILE = CEDAR_DIR / "schema.cedarschema.json"

HEADER = """// CommunityOps Cedar Policies
//
// GENERATED FILE — do not edit by hand.
// Source of truth: ACTION_RISK_LEVELS in services/shared/policy.py
// Regenerate with: python scripts/generate-cedar-policies.py
//
// This file is the declarative specification of the authority model. The runtime
// enforcement engine is services/shared/policy.py; see its module docstring for why
// there is one engine rather than two. tests/unit/test_policy_consistency.py fails if
// this file and the catalogue stop agreeing.
//
// Tier encoding:
//   LOW     -> permit, unconditional
//   MEDIUM  -> permit, guarded by an operational-role condition
//   HIGH    -> forbid, unless context.has_approval
//   NEVER   -> forbid, unconditional
"""

TIER_COMMENTS = {
    "LOW": (
        "LOW RISK — reversible, internal, no external consequence.\n"
        "// Agents may perform these without asking.",
    ),
    "MEDIUM": (
        "MEDIUM RISK — real operational effect.\n"
        "// Permitted for operational roles, always audited.",
    ),
    "HIGH": (
        "HIGH RISK — money, irreversibility, or someone outside the organization.\n"
        "// Forbidden unless a human approval backs the call.",
    ),
    "NEVER": (
        "NEVER AUTONOMOUS — outside what an automated system may do at all.\n"
        "// No approval unlocks these. Only a human acting directly.",
    ),
}


def _banner(title: str) -> str:
    rule = "// " + "=" * 69
    return f"\n{rule}\n// {title}\n{rule}\n"


def render_policies() -> str:
    role_condition = " || ".join(
        f'principal.role == "{role}"' for role in sorted(OPERATIONAL_ROLES)
    )

    parts = [HEADER]
    for tier in ("LOW", "MEDIUM", "HIGH", "NEVER"):
        actions = sorted(a for a, t in ACTION_RISK_LEVELS.items() if t == tier)
        if not actions:
            continue
        parts.append(_banner(TIER_COMMENTS[tier][0]))
        for action in actions:
            if tier == "LOW":
                parts.append(
                    f"permit(\n"
                    f"    principal,\n"
                    f'    action == Action::"{action}",\n'
                    f"    resource\n"
                    f");\n"
                )
            elif tier == "MEDIUM":
                parts.append(
                    f"permit(\n"
                    f"    principal,\n"
                    f'    action == Action::"{action}",\n'
                    f"    resource\n"
                    f") when {{\n"
                    f"    {role_condition}\n"
                    f"}};\n"
                )
            elif tier == "HIGH":
                parts.append(
                    f"forbid(\n"
                    f"    principal,\n"
                    f'    action == Action::"{action}",\n'
                    f"    resource\n"
                    f") unless {{\n"
                    f"    context.has_approval == true\n"
                    f"}};\n"
                )
            else:
                parts.append(
                    f"forbid(\n"
                    f"    principal,\n"
                    f'    action == Action::"{action}",\n'
                    f"    resource\n"
                    f");\n"
                )

    parts.append(_banner("TENANT ISOLATION — checked before anything else"))
    parts.append(
        "// Every action, regardless of tier, is forbidden across an organization\n"
        "// boundary. The runtime engine evaluates this first for the same reason: the\n"
        "// boundary crossing is the failure, not the sensitivity of the data reached.\n"
        "forbid(\n"
        "    principal,\n"
        "    action,\n"
        "    resource\n"
        ") unless {\n"
        "    principal.organization_id == resource.organization_id\n"
        "};\n"
    )
    return "\n".join(parts)


def render_schema() -> str:
    """Render the Cedar schema.

    Entity types carry only the attributes the policies actually reference, so the schema
    describes the model in use rather than the model we might want.
    """
    schema = {
        "CommunityOps": {
            "entityTypes": {
                "User": {
                    "shape": {
                        "type": "Record",
                        "attributes": {
                            "role": {"type": "String"},
                            "organization_id": {"type": "String"},
                            "email": {"type": "String"},
                        },
                    }
                },
                "Agent": {
                    "shape": {
                        "type": "Record",
                        "attributes": {
                            "agent_name": {"type": "String"},
                            "organization_id": {"type": "String"},
                            "acting_for_user_id": {"type": "String"},
                        },
                    }
                },
                "Event": {
                    "shape": {
                        "type": "Record",
                        "attributes": {
                            "organization_id": {"type": "String"},
                            "event_id": {"type": "String"},
                            "status": {"type": "String"},
                        },
                    }
                },
                "Team": {
                    "shape": {
                        "type": "Record",
                        "attributes": {
                            "organization_id": {"type": "String"},
                            "event_id": {"type": "String"},
                            "team_id": {"type": "String"},
                        },
                    }
                },
                "Task": {
                    "shape": {
                        "type": "Record",
                        "attributes": {
                            "organization_id": {"type": "String"},
                            "event_id": {"type": "String"},
                            "team_id": {"type": "String"},
                            "assigned_to": {"type": "String"},
                        },
                    }
                },
                "Registration": {
                    "shape": {
                        "type": "Record",
                        "attributes": {
                            "organization_id": {"type": "String"},
                            "event_id": {"type": "String"},
                            "registration_id": {"type": "String"},
                        },
                    }
                },
                "Speaker": {
                    "shape": {
                        "type": "Record",
                        "attributes": {
                            "organization_id": {"type": "String"},
                            "event_id": {"type": "String"},
                            "speaker_id": {"type": "String"},
                        },
                    }
                },
                "Incident": {
                    "shape": {
                        "type": "Record",
                        "attributes": {
                            "organization_id": {"type": "String"},
                            "event_id": {"type": "String"},
                            "incident_id": {"type": "String"},
                            "severity": {"type": "String"},
                        },
                    }
                },
                "Approval": {
                    "shape": {
                        "type": "Record",
                        "attributes": {
                            "organization_id": {"type": "String"},
                            "event_id": {"type": "String"},
                            "approval_id": {"type": "String"},
                            "amount_inr": {"type": "Long"},
                        },
                    }
                },
                "Budget": {
                    "shape": {
                        "type": "Record",
                        "attributes": {
                            "organization_id": {"type": "String"},
                            "event_id": {"type": "String"},
                        },
                    }
                },
                "Document": {
                    "shape": {
                        "type": "Record",
                        "attributes": {
                            "organization_id": {"type": "String"},
                            "event_id": {"type": "String"},
                            "document_id": {"type": "String"},
                        },
                    }
                },
            },
            # Risk tier is recorded as an annotation so the schema alone is enough to
            # reconstruct the catalogue, which is what the consistency test relies on.
            "actions": {
                action: {"annotations": {"riskTier": tier}}
                for action, tier in sorted(ACTION_RISK_LEVELS.items())
            },
        }
    }
    return json.dumps(schema, indent=2) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify the checked-in files are current; do not write.",
    )
    args = parser.parse_args()

    policies = render_policies()
    schema = render_schema()

    if args.check:
        stale = []
        if not POLICY_FILE.exists() or POLICY_FILE.read_text(encoding="utf-8") != policies:
            stale.append(str(POLICY_FILE.relative_to(REPO_ROOT)))
        if not SCHEMA_FILE.exists() or SCHEMA_FILE.read_text(encoding="utf-8") != schema:
            stale.append(str(SCHEMA_FILE.relative_to(REPO_ROOT)))
        if stale:
            print("Cedar specification is out of date:")  # noqa: T201
            for path in stale:
                print(f"  {path}")  # noqa: T201
            print("Run: python scripts/generate-cedar-policies.py")  # noqa: T201
            return 1
        print("Cedar specification is current.")  # noqa: T201
        return 0

    CEDAR_DIR.mkdir(parents=True, exist_ok=True)
    POLICY_FILE.write_text(policies, encoding="utf-8")
    SCHEMA_FILE.write_text(schema, encoding="utf-8")
    print(f"Wrote {len(ACTION_RISK_LEVELS)} actions to:")  # noqa: T201
    print(f"  {POLICY_FILE.relative_to(REPO_ROOT)}")  # noqa: T201
    print(f"  {SCHEMA_FILE.relative_to(REPO_ROOT)}")  # noqa: T201
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
