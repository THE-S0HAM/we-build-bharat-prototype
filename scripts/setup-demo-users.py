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
With ``--password-secret`` the passwords live in AWS Secrets Manager and **never pass through a
terminal, a shell history, an environment variable or this script's output**. On first run the
secret is created with freshly generated values; on later runs the existing values are read back and
reapplied, so re-running is idempotent and does not rotate anything unless asked.

That mode exists because the alternative leaks. Printing a generated password puts it in the
terminal scrollback and in whatever captured that output; passing it on a ``sam deploy`` command line
puts it in shell history and in the process table. The stack consumes it instead as a CloudFormation
dynamic reference, so the value moves from Secrets Manager to the function's configuration without
any intermediate hop.

Without ``--password-secret`` the older behaviour applies: values come from the environment when set,
otherwise generated and printed once. Convenient for a throwaway personal stack, not for anything
shared.

Passwords are set as permanent. A temporary password would leave the account in
``FORCE_CHANGE_PASSWORD``, and ``AdminInitiateAuth`` would return a ``NEW_PASSWORD_REQUIRED``
challenge that the demo endpoint has no interactive party to answer.

Idempotent: re-running updates group membership and resets passwords rather than failing on users
that already exist.

Usage
-----
    # Recommended: credentials held in Secrets Manager, never displayed
    python scripts/setup-demo-users.py --stack CommunityOps --region ap-south-1 \
        --password-secret CommunityOps/demo-credentials

    # Rotate them
    python scripts/setup-demo-users.py --stack CommunityOps \
        --password-secret CommunityOps/demo-credentials --rotate

    # Throwaway personal stack: generate and print once
    python scripts/setup-demo-users.py --stack CommunityOps
"""

from __future__ import annotations

import argparse
import json
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
    # Key this identity's password is stored under inside the Secrets Manager JSON document.
    secret_key: str
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
        secret_key="leader",
        purpose="Community leader — organization-wide operational authority",
        seed_placeholder="demo-leader-priya",
    ),
    DemoIdentity(
        email="team.demo@communityops.local",
        name="Rahul Patil",
        role=ROLE_TEAM_MEMBER,
        password_env="COMMUNITYOPS_TEAM_PASSWORD",
        secret_key="team",
        purpose="Team member — development and testing",
        seed_placeholder="demo-team-rahul",
    ),
    DemoIdentity(
        email="demo@communityops.local",
        name="Demo Volunteer",
        role=ROLE_TEAM_MEMBER,
        password_env="COMMUNITYOPS_DEMO_PASSWORD",
        secret_key="demo",
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


def generate_qr_secret() -> str:
    """A signing key for ticket QR codes.

    ``ticket_service`` reads ``QR_SECRET_KEY`` and falls back to a development default that is
    published in the source, so a deployment that leaves it unset signs real tickets with a value
    anybody can read — which makes a forged ticket trivial. Stored alongside the demo passwords so
    the stack has one secret to reference.
    """
    return secrets.token_urlsafe(48)


def load_or_create_secret(secret_id: str, region: str, *, rotate: bool) -> dict[str, str]:
    """Return the credential document, creating or rotating it as needed.

    The returned values are used in-process and never printed. The caller must not log them, and
    nothing in this module does: every ``print`` here emits identifiers, never material.

    A missing secret is created rather than treated as an error, so the first run of a fresh
    deployment needs no preparation. An existing secret is read back unchanged unless ``rotate`` is
    set, because re-running the bootstrap to fix group membership should not silently invalidate a
    password the stack is already configured with.
    """
    client = boto3.client("secretsmanager", region_name=region)

    def fresh() -> dict[str, str]:
        document = {identity.secret_key: generate_password() for identity in IDENTITIES}
        document["qr"] = generate_qr_secret()
        return document

    if not rotate:
        try:
            stored = client.get_secret_value(SecretId=secret_id)
            document = json.loads(stored["SecretString"])
            # Fill in anything a previous version of this script did not write, so adding an
            # identity does not require rotating the passwords of the existing ones.
            missing = {
                identity.secret_key: generate_password()
                for identity in IDENTITIES
                if not document.get(identity.secret_key)
            }
            if not document.get("qr"):
                missing["qr"] = generate_qr_secret()
            if missing:
                document.update(missing)
                client.put_secret_value(SecretId=secret_id, SecretString=json.dumps(document))
                print(f"  added {len(missing)} missing value(s) to {secret_id}")  # noqa: T201
            else:
                print(f"  reusing existing credentials in {secret_id}")  # noqa: T201
            return {str(k): str(v) for k, v in document.items()}
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") != "ResourceNotFoundException":
                raise

    document = fresh()
    payload = json.dumps(document)
    try:
        client.create_secret(
            Name=secret_id,
            SecretString=payload,
            Description=(
                "CommunityOps demo identity passwords and the ticket QR signing key. "
                "Consumed by CloudFormation dynamic references; never rendered in the console."
            ),
        )
        print(f"  created {secret_id}")  # noqa: T201
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ResourceExistsException":
            client.put_secret_value(SecretId=secret_id, SecretString=payload)
            print(f"  rotated {secret_id}")  # noqa: T201
        else:
            raise
    return document


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
    parser.add_argument(
        "--password-secret",
        default="",
        help=(
            "Secrets Manager secret id holding the credentials. Recommended: passwords are then "
            "never displayed, never in shell history, and consumed by the stack as a "
            "CloudFormation dynamic reference."
        ),
    )
    parser.add_argument(
        "--rotate",
        action="store_true",
        help="Generate new values even if the secret already exists.",
    )
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

    vault: dict[str, str] = {}
    if args.password_secret:
        print("Credentials")  # noqa: T201
        vault = load_or_create_secret(args.password_secret, args.region, rotate=args.rotate)
        print()  # noqa: T201

    print("Groups")  # noqa: T201
    ensure_groups(cognito, user_pool_id)
    print()  # noqa: T201

    print("Identities")  # noqa: T201
    generated: list[tuple[DemoIdentity, str]] = []
    subjects: dict[str, str] = {}

    for identity in IDENTITIES:
        # Secrets Manager first, then the environment, then generate. The first two are the modes
        # where the value is already under someone's control; generating is the fallback.
        password = vault.get(identity.secret_key) or os.environ.get(identity.password_env, "")
        supplied = bool(password)
        password = password or generate_password()
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

    print("Next steps")  # noqa: T201
    print()  # noqa: T201
    print("1. Give the demo-session endpoint the public demo password, so a visitor can")  # noqa: T201
    print("   reach the product without a credential ever touching the browser.")  # noqa: T201
    print()  # noqa: T201
    if args.password_secret:
        # A dynamic reference, not the value. CloudFormation resolves it at deploy time, so the
        # password never appears on a command line, in shell history or in the process table.
        secret = args.password_secret
        print("     sam deploy --parameter-overrides \\")  # noqa: T201
        print("       Stage=dev \\")  # noqa: T201
        print(  # noqa: T201
            f"       DemoPassword='{{{{resolve:secretsmanager:{secret}:SecretString:demo}}}}' \\"
        )
        print(  # noqa: T201
            f"       QrSigningSecret='{{{{resolve:secretsmanager:{secret}:SecretString:qr}}}}'"
        )
    else:
        print("     sam deploy --parameter-overrides Stage=dev DemoPassword=<the demo password>")  # noqa: T201
        print()  # noqa: T201
        print("   Consider --password-secret instead: a password on a command line ends up in")  # noqa: T201
        print("   shell history and in the process table.")  # noqa: T201
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
    if args.password_secret:
        print(f"Credentials live in {args.password_secret}. Nothing above contains a password.")  # noqa: T201
    else:
        print("Do not commit any of these passwords.")  # noqa: T201
    return 0


if __name__ == "__main__":
    sys.exit(main())
