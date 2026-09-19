#!/usr/bin/env python3
"""Print the health score the seeded demo dataset produces, and what drives it.

The demo is documented as landing on ORANGE, and the score is a sum of independently weighted
signals, so it is easy to adjust one part of the dataset and push the band over a threshold
without noticing. This prints the breakdown so the effect of a change to the seed data is visible
immediately rather than at the end of a three-minute test run.

Usage:
    python scripts/check-demo-health.py
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

TABLE = "CommunityOps-Main-healthcheck"
ORG_ID = "ORG-wemakedev"
EVENT_ID = "EVT-acd-mh-2026"


def main() -> int:
    os.environ.update(
        {
            "AWS_ACCESS_KEY_ID": "testing",
            "AWS_SECRET_ACCESS_KEY": "testing",
            "AWS_DEFAULT_REGION": "ap-south-1",
            "MAIN_TABLE": TABLE,
            "AUDIT_TABLE": "CommunityOps-Audit-healthcheck",
        }
    )

    import boto3
    from moto import mock_aws

    spec = importlib.util.spec_from_file_location(
        "seed_demo", REPO_ROOT / "scripts" / "seed-demo.py"
    )
    assert spec and spec.loader
    seed = importlib.util.module_from_spec(spec)
    sys.modules["seed_demo"] = seed
    spec.loader.exec_module(seed)

    from services.shared.aggregate import load_event_snapshot
    from services.shared.health import attention_items, compute_health

    with mock_aws():
        resource = boto3.resource("dynamodb", region_name="ap-south-1")
        resource.create_table(
            TableName=TABLE,
            BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[
                {"AttributeName": n, "AttributeType": "S"}
                for n in ("PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK")
            ],
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": index,
                    "KeySchema": [
                        {"AttributeName": f"{index}PK", "KeyType": "HASH"},
                        {"AttributeName": f"{index}SK", "KeyType": "RANGE"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                }
                for index in ("GSI1", "GSI2")
            ],
        )
        table = resource.Table(TABLE)
        items = seed.build_items()
        with table.batch_writer() as batch:
            for sk, attributes in items:
                batch.put_item(Item={"PK": ORG_ID, "SK": sk, **attributes})

        snapshot = load_event_snapshot(ORG_ID, EVENT_ID, table_name=TABLE)
        result = compute_health(snapshot)

        print(f"Seeded records      : {len(items)}")  # noqa: T201
        print(f"Health              : {result.band.value} ({result.score}/100)")  # noqa: T201
        print()  # noqa: T201
        print("Signals")  # noqa: T201
        for reason in result.reasons:
            print(f"  {reason.points:>3}  {reason.signal:<24} {reason.detail}")  # noqa: T201
        print(f"  {'':>3}  {'':<24} {'-' * 40}")  # noqa: T201
        print(f"  {result.score:>3}  total")  # noqa: T201
        print()  # noqa: T201
        print("Bands: 0-14 GREEN | 15-34 YELLOW | 35-59 ORANGE | 60+ RED")  # noqa: T201
        print()  # noqa: T201
        print("Operational state")  # noqa: T201
        print(f"  teams              {len(snapshot.teams)}")  # noqa: T201
        print(f"  tasks              {len(snapshot.tasks)}")  # noqa: T201
        print(f"  open tasks         {len(snapshot.open_tasks)}")  # noqa: T201
        print(f"  overdue tasks      {len(snapshot.overdue_tasks)}")  # noqa: T201
        print(f"  blocked tasks      {len(snapshot.blocked_tasks)}")  # noqa: T201
        print(f"  speakers           {len(snapshot.speakers)}")  # noqa: T201
        print(f"  silent speakers    {len(snapshot.silent_speakers)}")  # noqa: T201
        print(f"  open incidents     {len(snapshot.open_incidents)}")  # noqa: T201
        print(f"  pending approvals  {len(snapshot.pending_approvals)}")  # noqa: T201
        print(f"  stale approvals    {len(snapshot.stale_approvals)}")  # noqa: T201
        print(f"  registered         {snapshot.attendees.total_registered}")  # noqa: T201
        print(f"  checked in         {snapshot.attendees.checked_in}")  # noqa: T201
        print(f"  dietary missing    {snapshot.attendees.dietary_missing}")  # noqa: T201
        print(f"  missing info       {snapshot.attendees.missing_information}")  # noqa: T201
        print(  # noqa: T201
            f"  data completeness  {snapshot.attendees.data_completeness_percent}%"
        )
        print(f"  budget remaining   {snapshot.budget.remaining:,}")  # noqa: T201
        print(  # noqa: T201
            f"  budget utilization {snapshot.budget.utilization_percent}%"
        )
        print()  # noqa: T201
        print("Attention list")  # noqa: T201
        for item in attention_items(snapshot)[:8]:
            print(f"  {item['severity']:<9} {item['kind']:<9} {item['title']}")  # noqa: T201

    return 0 if result.band.value == "ORANGE" else 1


if __name__ == "__main__":
    raise SystemExit(main())
