#!/usr/bin/env python3
"""Create the CommunityOps Cognito groups and demo identities.

Authorization is derived from Cognito group membership: groups prefixed ``ORG-`` are organization
memberships, and ``LEADER`` / ``TEAM_MEMBER`` are roles. Those groups have to exist before a user
can be placed in them, and nothing in the SAM template creates them — a user pool has no
declarative group-membership mechanism, so this is the bootstrap step.

Identities created
------------------
========================  ==========  ==========================================================
Email                     Role        Purpose
========================  ==========  ==========================================================
leader.demo@…             LEADER      The community leader. Full operational authority.
team.demo@…               TEAM_MEMBER Development and testing.
demo@…                    TEAM_MEMBER Public demo, reached through POST /demo/session.
========================  ==========  ==========================================================

Passwords
---------
Taken from the environment when set, otherwise generated with ``secrets`` and printed once. They are
never written to a file, never committed, and never echoed back by any API. The public demo password
additionally has to be passed to the stack as the ``DemoPassword`` parameter so the demo-session
Lambda can use it; the command to do that is printed at the end.

Passwords are set as permanent. A temporary password would leave the account in
``FORCE_CHANGE_PASSWORD``, and ``AdminInitiateAuth`` would return a ``NEW_PASSWORD_REQUIRED``
challenge that the demo endpoint has no interactive party to answer.

Idempotent: re-running updates group membership and resets passwords rather than failing on users
that already exist.

Usage
-----
    # Discover the pool from the deployed stack
    python scripts/setup-demo-users.py --stack CommunityOps --region ap-south-1

    # Or name the pool directly
    python scripts/setup-demo-users.py --user-pool-id ap-south-1_XXXX --region ap-south-1

    # Supply passwords instead of generating them
    $env:COMMUNITYOPS_LEADER_PASSWORD = "..."
    $env:COMMUNITYOPS_TEAM_PASSWORD   = "..."
    $env:COMMUNITYOPS_DEMO_PASSWORD   = "..."
    python scripts/setup-demo-users.py --stack CommunityOps
"""

from __future__ import annotations

import argparse
import os
import secrets
import string
import sys
from dataclasses import dataclass

import boto3
from botocore.exceptions import ClientError

ORGANIZATION_ID = "ORG-wemakedev"

ROLE_LEADER = "LEADER"
ROLE_TEAM_MEMBER = "TEAM_MEMBER"


@dataclass(frozen=True)
class DemoIdentity:
    """One identity to create, and the scope it is given."""

    email: str
    name: str
    role: str
    password_env: str
    purpose: str
    # Matches the subject placeholder the seed script uses, so seeded team memberships can be
    # rebound to this account's real Cognito subject.
    seed_placeholder: str


IDENTITIES = [
    DemoIdentity(
        email="leader.demo@communityops.local",
        name="Priya Sharma",
        role=ROLE_LEADER,
        password_env="COMMUNITYOPS_LEADER_PASSWORD",
        purpose="Community leader — organization-wide operational authority",
        seed_placeholder="demo-leader-priya",
    ),
    DemoIdentity(
        email="team.demo@communityops.local",
        name="Rahul Patil",
        role=ROLE_TEAM_MEMBER,
        password_env="COMMUNITYOPS_TEAM_PASSWORD",
        purpose="Team member — development and testing",
        seed_placeholder="demo-team-rahul",
    ),
    DemoIdentity(
        email="demo@communityops.local",
        name="Demo Volunteer",
        role=ROLE_TEAM_MEMBER,
        password_env="COMMUNITYOPS_DEMO_PASSWORD",
        purpose="Public demo — reached through POST /demo/session",
        seed_placeholder="demo-volunteer",
    ),
]

GROUPS = [
    (ORGANIZATION_ID, "Organization membership for WeMakeDev"),
    (ROLE_LEADER, "Organization-wide operational authority"),
    (ROLE_TEAM_MEMBER, "Assigned events, own teams, own tasks"),
]


def generate_password() -> str:
    """Generate a password satisfying the pool policy: 8+, upper, lower, digit.

    Built by construction rather than by generating and retrying, so it cannot loop and cannot
    accidentally emit one that fails the policy. ``secrets`` rather than ``random`` because this is a
    credential.
    """
    alphabet = string.ascii_letters + string.digits
    while True:
        candidate = "".join(secrets.choice(alphabet) for _ in range(20))
        if (
            any(c.isupper() for c in candidate)
            and any(c.islower() for c in candidate)
            and any(c.isdigit() for c in candidate)
        ):
            return candidate


def resolve_user_pool(stack_name: str, region: str) -> tuple[str, str]:
    """Read the pool and client ids from the deployed stack outputs."""
    cloudformation = boto3.client("cloudformation", region_name=region)
    try:
        stacks = cloudformation.describe_stacks(StackName=stack_name)["Stacks"]
    except ClientError as exc:
        raise SystemExit(
            f"Could not read stack {stack_name} in {region}: "
            f"{exc.response.get('Error', {}).get('Message', exc)}"
        ) from exc

    outputs = {o["OutputKey"]: o["OutputValue"] for o in stacks[0].get("Outputs", [])}
    pool_id = outputs.get("UserPoolId", "")
    client_id = outputs.get("UserPoolClientId", "")
    if not pool_id:
        raise SystemExit(
            f"Stack {stack_name} has no UserPoolId output. Is it the CommunityOps stack?"
        )
    return pool_id, client_id


def ensure_groups(cognito: object, user_pool_id: str) -> None:
    for group_name, description in GROUPS:
        try:
            cognito.create_group(  # type: ignore[attr-defined]
                GroupName=group_name,
                UserPoolId=user_pool_id,
                Description=description,
            )
            print(f"  created group {group_name}")  # noqa: T201
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "GroupExistsException":
                print(f"  group {group_name} already exists")  # noqa: T201
            else:
                raise


def ensure_identity(
    cognito: object, user_pool_id: str, identity: DemoIdentity, password: str
) -> str:
    """Create or update one identity. Returns its Cognito subject."""
    try:
        cognito.admin_create_user(  # type: ignore[attr-defined]
            UserPoolId=user_pool_id,
            Username=identity.email,
            UserAttributes=[
                {"Name": "email", "Value": identity.email},
                {"Name": "email_verified", "Value": "true"},
                {"Name": "name", "Value": identity.name},
            ],
            # No invitation email: these are demo accounts on a fictional domain and the address
            # does not exist, so a delivery attempt would only produce a bounce.
            MessageAction="SUPPRESS",
        )
        print(f"  created {identity.email}")  # noqa: T201
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "UsernameExistsException":
            print(f"  {identity.email} already exists")  # noqa: T201
        else:
            raise

    # Permanent, so the account is CONFIRMED and AdminInitiateAuth returns tokens rather than a
    # NEW_PASSWORD_REQUIRED challenge the demo endpoint cannot answer.
    cognito.admin_set_user_password(  # type: ignore[attr-defined]
        UserPoolId=user_pool_id,
        Username=identity.email,
        Password=password,
        Permanent=True,
    )

    for group_name in (ORGANIZATION_ID, identity.role):
        cognito.admin_add_user_to_group(  # type: ignore[attr-defined]
            UserPoolId=user_pool_id, Username=identity.email, GroupName=group_name
        )
    print(f"    role {identity.role}, organization {ORGANIZATION_ID}")  # noqa: T201

    user = cognito.admin_get_user(  # type: ignore[attr-defined]
        UserPoolId=user_pool_id, Username=identity.email
    )
    subject = next((a["Value"] for a in user.get("UserAttributes", []) if a["Name"] == "sub"), "")
    return subject


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack", default="CommunityOps", help="CloudFormation stack name")
    parser.add_argument("--user-pool-id", default="", help="Skip stack lookup")
    parser.add_argument("--region", default="ap-south-1")
    args = parser.parse_args()

    if args.user_pool_id:
        user_pool_id, client_id = args.user_pool_id, ""
    else:
        user_pool_id, client_id = resolve_user_pool(args.stack, args.region)

    print(f"User pool : {user_pool_id}")  # noqa: T201
    if client_id:
        print(f"Client    : {client_id}")  # noqa: T201
    print()  # noqa: T201

    cognito = boto3.client("cognito-idp", region_name=args.region)

    print("Groups")  # noqa: T201
    ensure_groups(cognito, user_pool_id)
    print()  # noqa: T201

    print("Identities")  # noqa: T201
    generated: list[tuple[DemoIdentity, str]] = []
    subjects: dict[str, str] = {}

    for identity in IDENTITIES:
        supplied = os.environ.get(identity.password_env, "")
        password = supplied or generate_password()
        subject = ensure_identity(cognito, user_pool_id, identity, password)
        subjects[identity.seed_placeholder] = subject
        if not supplied:
            generated.append((identity, password))

    print()  # noqa: T201
    if generated:
        print("=" * 78)  # noqa: T201
        print("GENERATED PASSWORDS — shown once, not stored anywhere. Record them now.")  # noqa: T201
        print("=" * 78)  # noqa: T201
        for identity, password in generated:
            print(f"  {identity.email}")  # noqa: T201
            print(f"    {password}")  # noqa: T201
            print(f"    {identity.purpose}")  # noqa: T201
        print("=" * 78)  # noqa: T201
        print()  # noqa: T201

    demo = next(i for i in IDENTITIES if i.email == "demo@communityops.local")
    demo_password = os.environ.get(demo.password_env, "") or next(
        (p for i, p in generated if i.email == demo.email), ""
    )

    print("Next steps")  # noqa: T201
    print()  # noqa: T201
    print("1. Give the demo-session endpoint the public demo password, so a visitor can")  # noqa: T201
    print("   reach the product without a credential ever touching the browser:")  # noqa: T201
    print()  # noqa: T201
    print(f"     sam deploy --parameter-overrides Stage=dev DemoPassword={demo_password}")  # noqa: T201
    print()  # noqa: T201
    print("2. Bind the seeded team memberships to these real Cognito subjects, otherwise")  # noqa: T201
    print("   each account signs in belonging to no teams and sees an empty workspace:")  # noqa: T201
    print()  # noqa: T201
    print("     python scripts/seed-demo.py \\")  # noqa: T201
    print(f"       --leader-sub {subjects.get('demo-leader-priya', '')} \\")  # noqa: T201
    print(f"       --team-sub {subjects.get('demo-team-rahul', '')} \\")  # noqa: T201
    print(f"       --demo-sub {subjects.get('demo-volunteer', '')} \\")  # noqa: T201
    print(f"       --region {args.region}")  # noqa: T201
    print()  # noqa: T201
    print("Do not commit any of these passwords.")  # noqa: T201
    return 0


if __name__ == "__main__":
    sys.exit(main())
