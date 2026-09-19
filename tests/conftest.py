"""Shared test fixtures.

The fixtures here build a real DynamoDB table with moto and seed the demo dataset into it, so
handler and tool tests run against the same data shape production uses — including the index
keys. Testing aggregation or health against hand-built dicts would pass while the real query
paths were broken, because the thing most likely to be wrong is a sort key, and a dict has none.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

import boto3
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

TEST_REGION = "ap-south-1"
MAIN_TABLE = "CommunityOps-Main-test"
AUDIT_TABLE = "CommunityOps-Audit-test"

ORG_ID = "ORG-wemakedev"
OTHER_ORG_ID = "ORG-someone-else"
EVENT_ID = "EVT-acd-mh-2026"

LEADER_SUB = "demo-leader-priya"
TEAM_SUB = "demo-team-rahul"
DEMO_SUB = "demo-volunteer"


@pytest.fixture(autouse=True)
def aws_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point every module at the test tables and supply fake credentials.

    Set before any module is imported that reads these at import time — several read
    ``MAIN_TABLE`` into a module-level constant, so a fixture that set them later would be
    ignored by whichever module happened to be imported first.
    """
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SECURITY_TOKEN", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", TEST_REGION)
    monkeypatch.setenv("MAIN_TABLE", MAIN_TABLE)
    monkeypatch.setenv("AUDIT_TABLE", AUDIT_TABLE)
    monkeypatch.setenv("TICKET_BUCKET", "communityops-tickets-test")
    monkeypatch.setenv("EVENT_BUS_NAME", "CommunityOps-EventBus-test")
    monkeypatch.setenv("QR_SECRET_KEY", "test-secret")
    # The demo dataset seeds 286 registrations, each writing up to three records. That is the
    # right size for a demo — the attendee percentages only look realistic at scale — but it
    # dominates test runtime, and the proportions are ratios so a smaller population produces
    # identical health signals. 60 keeps the same percentages at a fifth of the writes.
    monkeypatch.setenv("SEED_TOTAL_REGISTRATIONS", "60")


@pytest.fixture
def dynamodb(aws_environment: None) -> Any:
    """A mocked DynamoDB with both tables and both indexes.

    The index definitions mirror ``template.yaml`` exactly. If they drifted, queries that work
    in tests would fail in deployment, which is the most expensive kind of test to get wrong.
    """
    from moto import mock_aws

    with mock_aws():
        resource = boto3.resource("dynamodb", region_name=TEST_REGION)
        # The audit writer publishes to EventBridge as well as DynamoDB. Both failures are
        # non-fatal by design, but without a bus every audited operation logs a stack trace and
        # buries whatever the test was actually about.
        boto3.client("events", region_name=TEST_REGION).create_event_bus(
            Name="CommunityOps-EventBus-test"
        )
        for name in (MAIN_TABLE, AUDIT_TABLE):
            resource.create_table(
                TableName=name,
                BillingMode="PAY_PER_REQUEST",
                AttributeDefinitions=[
                    {"AttributeName": "PK", "AttributeType": "S"},
                    {"AttributeName": "SK", "AttributeType": "S"},
                    {"AttributeName": "GSI1PK", "AttributeType": "S"},
                    {"AttributeName": "GSI1SK", "AttributeType": "S"},
                    {"AttributeName": "GSI2PK", "AttributeType": "S"},
                    {"AttributeName": "GSI2SK", "AttributeType": "S"},
                ],
                KeySchema=[
                    {"AttributeName": "PK", "KeyType": "HASH"},
                    {"AttributeName": "SK", "KeyType": "RANGE"},
                ],
                GlobalSecondaryIndexes=[
                    {
                        "IndexName": "GSI1",
                        "KeySchema": [
                            {"AttributeName": "GSI1PK", "KeyType": "HASH"},
                            {"AttributeName": "GSI1SK", "KeyType": "RANGE"},
                        ],
                        "Projection": {"ProjectionType": "ALL"},
                    },
                    {
                        "IndexName": "GSI2",
                        "KeySchema": [
                            {"AttributeName": "GSI2PK", "KeyType": "HASH"},
                            {"AttributeName": "GSI2SK", "KeyType": "RANGE"},
                        ],
                        "Projection": {"ProjectionType": "ALL"},
                    },
                ],
            )
        yield resource


def _load_seed_module() -> Any:
    """Import the seed script by path.

    ``scripts/seed-demo.py`` is not importable as a module name because of the hyphen, and
    renaming it would break the documented command. Loading it by path keeps one definition of
    the demo dataset rather than a second copy inside the tests that could drift from it.
    """
    spec = importlib.util.spec_from_file_location(
        "seed_demo", REPO_ROOT / "scripts" / "seed-demo.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["seed_demo"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def seed_module() -> Any:
    return _load_seed_module()


@pytest.fixture
def seeded(dynamodb: Any, seed_module: Any) -> Any:
    """The demo dataset loaded into the mocked tables."""
    main = dynamodb.Table(MAIN_TABLE)
    with main.batch_writer() as batch:
        for sk, attributes in seed_module.build_items():
            batch.put_item(Item={"PK": ORG_ID, "SK": sk, **attributes})

    audit = dynamodb.Table(AUDIT_TABLE)
    with audit.batch_writer() as batch:
        for sk, attributes in seed_module.build_audit_items():
            batch.put_item(Item={"PK": ORG_ID, "SK": sk, **attributes})

    return dynamodb


@pytest.fixture
def leader() -> Any:
    from services.shared.principal import Principal, Role

    return Principal(
        user_id=LEADER_SUB,
        email="leader.demo@communityops.local",
        display_name="Priya Sharma",
        role=Role.LEADER,
        organizations=frozenset({ORG_ID}),
    )


@pytest.fixture
def team_member() -> Any:
    """A team member scoped to the Technical team on the demo event."""
    from services.shared.principal import Principal, Role

    return Principal(
        user_id=TEAM_SUB,
        email="team.demo@communityops.local",
        display_name="Rahul Patil",
        role=Role.TEAM_MEMBER,
        organizations=frozenset({ORG_ID}),
        team_ids=frozenset({"TEAM-tech"}),
        event_ids=frozenset({EVENT_ID}),
    )


def api_event(
    *,
    method: str = "GET",
    path: str = "/",
    organization_id: str = ORG_ID,
    groups: list[str] | None = None,
    user_id: str = LEADER_SUB,
    email: str = "leader.demo@communityops.local",
    name: str = "Priya Sharma",
    path_parameters: dict[str, str] | None = None,
    query: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build an API Gateway event with Cognito authorizer claims.

    ``groups`` defaults to leader membership. Role and organization both come from the claim,
    which is how the real authorizer delivers them, so a test that changes the groups is testing
    the actual authorization path rather than a shortcut around it.
    """
    import json

    claim_groups = groups if groups is not None else [organization_id, "LEADER"]
    query_params = dict(query or {})
    if method == "GET" and organization_id and "organization_id" not in query_params:
        query_params["organization_id"] = organization_id

    payload = dict(body or {})
    if method in ("POST", "PUT", "DELETE") and organization_id:
        payload.setdefault("organization_id", organization_id)

    return {
        "httpMethod": method,
        "resource": path,
        "path": path,
        "pathParameters": path_parameters or {},
        "queryStringParameters": query_params or None,
        "body": json.dumps(payload) if payload else None,
        "requestContext": {
            "authorizer": {
                "claims": {
                    "sub": user_id,
                    "email": email,
                    "name": name,
                    "cognito:groups": ",".join(claim_groups),
                }
            }
        },
    }


def body_of(response: dict[str, Any]) -> Any:
    """Parse a handler response body."""
    import json

    return json.loads(response["body"])
