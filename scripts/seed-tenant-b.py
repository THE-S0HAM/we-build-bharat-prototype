#!/usr/bin/env python3
"""Seed a minimal second-tenant dataset for cross-tenant isolation testing.

Creates Organization B with its own event and one registration. Used to verify
that a caller scoped to Organization A cannot read Organization B's data through
the deployed API.

All data is fictional. No real personal or payment information.

Usage:
    python scripts/seed-tenant-b.py --table CommunityOps-Main-dev --region ap-south-1
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime

import boto3

ORG_B = "ORG-tenant-b"
EVENT_B = "EVT-tenant-b-summit"
REG_B = "REG-2026-900001"
NOW = datetime.now(UTC)


def seed(table_name: str, region: str) -> None:
    table = boto3.resource("dynamodb", region_name=region).Table(table_name)

    items = [
        {
            "PK": ORG_B,
            "SK": f"ORG#{ORG_B}",
            "entity_type": "ORGANIZATION",
            "name": "Tenant B Collective",
            "slug": "tenant-b",
            "is_active": True,
        },
        {
            "PK": ORG_B,
            "SK": f"EVENT#{EVENT_B}",
            "entity_type": "EVENT",
            "event_id": EVENT_B,
            "name": "Tenant B Summit 2026",
            "status": "ACTIVE",
            "venue": "Undisclosed",
            "city": "Pune",
            "start_date": "2026-11-20T09:00:00Z",
            "end_date": "2026-11-20T18:00:00Z",
            "timezone": "Asia/Kolkata",
            "expected_attendees": 100,
            "registration_open": True,
            "GSI1PK": f"{ORG_B}#EVENTS",
            "GSI1SK": f"STATUS#ACTIVE#{NOW.isoformat()}",
        },
        {
            "PK": ORG_B,
            "SK": f"EVENT#{EVENT_B}#REG#{REG_B}",
            "entity_type": "REGISTRATION",
            "event_id": EVENT_B,
            "registration_id": REG_B,
            "attendee_name": "Tenant B Attendee",
            "attendee_email": "tenant.b.attendee@example.com",
            "attendee_phone": "+919000000001",
            "attendee_name_lower": "tenant b attendee",
            "status": "CONFIRMED",
            "payment_status": "CAPTURED",
            "payment_reference": "TXN-TB-00001",
            "ticket_type": "GENERAL",
            "is_checked_in": False,
            "GSI1PK": f"{ORG_B}#{EVENT_B}",
            "GSI1SK": "EMAIL#tenant.b.attendee@example.com",
        },
    ]

    with table.batch_writer() as batch:
        for item in items:
            batch.put_item(Item=item)

    print(f"Seeded {len(items)} items to {table_name}")  # noqa: T201
    print(f"  Organization: {ORG_B}")  # noqa: T201
    print(f"  Event: {EVENT_B}")  # noqa: T201
    print(f"  Registration: {REG_B}")  # noqa: T201


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed second-tenant isolation test data")
    parser.add_argument("--table", default="CommunityOps-Main-dev", help="DynamoDB table name")
    parser.add_argument("--region", default="ap-south-1", help="AWS region")
    args = parser.parse_args()
    seed(args.table, args.region)
