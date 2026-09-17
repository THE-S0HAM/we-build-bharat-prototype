#!/usr/bin/env python3
"""Seed demo data for OrbitOps.

Creates a realistic event scenario with registrations, speakers, teams,
tasks, payments, incidents, and approvals. Uses entirely synthetic data —
no real personal or payment information.

Usage:
    python scripts/seed-demo.py --table OrbitOps-Main-dev --region ap-south-1
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone, timedelta

import boto3


ORG_ID = "ORG-wemakedev"
EVENT_ID = "EVT-devcon-2026"
NOW = datetime.now(timezone.utc)


def seed(table_name: str, region: str) -> None:
    dynamodb = boto3.resource("dynamodb", region_name=region)
    table = dynamodb.Table(table_name)

    items = []

    # === Organization ===
    items.append({
        "PK": ORG_ID, "SK": f"ORG#{ORG_ID}",
        "entity_type": "ORGANIZATION",
        "name": "WeMakeDev",
        "slug": "wemakedev",
        "description": "India's community for builders and developers",
        "contact_email": "hello@wemakedev.com",
        "is_active": True,
    })

    # === Event ===
    items.append({
        "PK": ORG_ID, "SK": f"EVENT#{EVENT_ID}",
        "entity_type": "EVENT",
        "event_id": EVENT_ID,
        "name": "DevCon Bengaluru 2026",
        "description": "The largest developer conference in South India",
        "status": "ACTIVE",
        "venue": "NIMHANS Convention Centre, Bengaluru",
        "city": "Bengaluru",
        "start_date": "2026-10-15T09:00:00Z",
        "end_date": "2026-10-15T18:00:00Z",
        "timezone": "Asia/Kolkata",
        "expected_attendees": 500,
        "registration_open": True,
        "tags": ["developer", "community", "ai", "cloud"],
        "GSI1PK": f"{ORG_ID}#EVENTS",
        "GSI1SK": f"STATUS#ACTIVE#{NOW.isoformat()}",
    })

    # === Registrations — varied scenarios for demo ===
    registrations = [
        # Normal confirmed registration
        ("REG-2026-004821", "Priya Sharma", "priya.sharma@example.com", "+919876543210", "CONFIRMED", "CAPTURED", "TXN-KH-78901"),
        ("REG-2026-004822", "Arjun Patel", "arjun.patel@example.com", "+919876543211", "CONFIRMED", "CAPTURED", "TXN-KH-78902"),
        ("REG-2026-004823", "Deepika Rao", "deepika.rao@example.com", "+919876543212", "CONFIRMED", "CAPTURED", "TXN-KH-78903"),
        ("REG-2026-004824", "Vikram Singh", "vikram.singh@example.com", "+919876543213", "CONFIRMED", "NOT_REQUIRED", ""),
        # Cancelled registration — should fail verification
        ("REG-2026-004825", "Neha Gupta", "neha.gupta@example.com", "+919876543214", "CANCELLED", "REFUNDED", "TXN-KH-78905"),
        # Waitlisted — should fail verification
        ("REG-2026-004826", "Rahul Mehta", "rahul.mehta@example.com", "+919876543215", "WAITLISTED", "PENDING", ""),
        # Multiple people with similar names — disambiguation scenario
        ("REG-2026-004827", "Amit Kumar", "amit.kumar1@example.com", "+919876543216", "CONFIRMED", "CAPTURED", "TXN-KH-78907"),
        ("REG-2026-004828", "Amit Kumar Verma", "amit.kumar2@example.com", "+919876543217", "CONFIRMED", "CAPTURED", "TXN-KH-78908"),
        # Already checked in
        ("REG-2026-004829", "Sneha Reddy", "sneha.reddy@example.com", "+919876543218", "CONFIRMED", "CAPTURED", "TXN-KH-78909"),
        # Pending payment
        ("REG-2026-004830", "Karthik Nair", "karthik.nair@example.com", "+919876543219", "CONFIRMED", "PENDING", "TXN-KH-78910"),
    ]

    for reg_id, name, email, phone, status, pay_status, txn_ref in registrations:
        items.append({
            "PK": ORG_ID, "SK": f"EVENT#{EVENT_ID}#REG#{reg_id}",
            "entity_type": "REGISTRATION",
            "event_id": EVENT_ID,
            "registration_id": reg_id,
            "attendee_name": name,
            "attendee_email": email,
            "attendee_phone": phone,
            "attendee_name_lower": name.lower(),
            "status": status,
            "payment_status": pay_status,
            "payment_reference": txn_ref,
            "ticket_type": "GENERAL",
            "is_checked_in": reg_id == "REG-2026-004829",
            "GSI1PK": f"{ORG_ID}#{EVENT_ID}",
            "GSI1SK": f"EMAIL#{email}",
        })

    # === Payment References — for reconciliation demos ===
    payments = [
        ("TXN-KH-78901", "REG-2026-004821", "999", "CAPTURED", "priya.sharma@example.com", "Priya Sharma"),
        ("TXN-KH-78902", "REG-2026-004822", "999", "CAPTURED", "arjun.patel@example.com", "Arjun Patel"),
        ("TXN-KH-78903", "REG-2026-004823", "999", "CAPTURED", "deepika.rao@example.com", "Deepika Rao"),
        ("TXN-KH-78905", "REG-2026-004825", "999", "REFUNDED", "neha.gupta@example.com", "Neha Gupta"),
        # Orphan payment — no matching registration (reconciliation edge case)
        ("TXN-KH-78999", "", "999", "CAPTURED", "mystery.attendee@example.com", "Mystery Attendee"),
    ]

    for txn_id, reg_id, amount, status, email, name in payments:
        items.append({
            "PK": ORG_ID, "SK": f"EVENT#{EVENT_ID}#PAYMENT#{txn_id}",
            "entity_type": "PAYMENT_REFERENCE",
            "event_id": EVENT_ID,
            "transaction_id": txn_id,
            "registration_id": reg_id,
            "amount": amount,
            "currency": "INR",
            "status": status,
            "payer_email": email,
            "payer_name": name,
            "GSI1PK": f"{ORG_ID}#{EVENT_ID}",
            "GSI1SK": f"TXN#{txn_id}",
        })

    # === Check-in (pre-existing for already-checked-in attendee) ===
    items.append({
        "PK": ORG_ID, "SK": f"EVENT#{EVENT_ID}#CHECKIN#REG-2026-004829",
        "entity_type": "CHECKIN",
        "event_id": EVENT_ID,
        "registration_id": "REG-2026-004829",
        "status": "CHECKED_IN",
        "checked_in_at": NOW.isoformat(),
        "checked_in_by": "volunteer-001",
        "method": "QR_SCAN",
        "GSI1PK": f"{ORG_ID}#{EVENT_ID}",
        "GSI1SK": f"CHECKIN#{NOW.isoformat()}",
    })

    # === Speakers ===
    speakers = [
        ("SPK-001", "Dr. Ananya Krishnan", "ananya.k@example.com", "CONFIRMED", "Building Responsible AI Systems", "KEYNOTE", False),
        ("SPK-002", "Raj Malhotra", "raj.m@example.com", "AWAITING_RESPONSE", "Cloud-Native Architecture Patterns", "TALK", False),
        ("SPK-003", "Fatima Shaikh", "fatima.s@example.com", "INVITED", "Scaling Community-Led Developer Programs", "TALK", False),
        ("SPK-004", "Suresh Rajan", "suresh.r@example.com", "CONFIRMED", "Zero Trust Security for Startups", "WORKSHOP", False),
        # Backup speaker — for incident response demo
        ("SPK-005", "Meera Joshi", "meera.j@example.com", "CONFIRMED", "AI in Healthcare: Ethics and Practice", "TALK", True),
        # Speaker who will "cancel" — incident trigger
        ("SPK-006", "James Chen", "james.c@example.com", "CANCELLED", "Microservices Anti-Patterns", "TALK", False),
    ]

    for spk_id, name, email, status, topic, session_type, is_backup in speakers:
        items.append({
            "PK": ORG_ID, "SK": f"EVENT#{EVENT_ID}#SPEAKER#{spk_id}",
            "entity_type": "SPEAKER",
            "event_id": EVENT_ID,
            "speaker_id": spk_id,
            "name": name,
            "email": email,
            "status": status,
            "topic": topic,
            "session_type": session_type,
            "is_backup": is_backup,
            "followup_count": 2 if status == "AWAITING_RESPONSE" else 0,
            "max_followups": 3,
            "travel_required": spk_id in ("SPK-001", "SPK-006"),
            "accommodation_required": spk_id in ("SPK-001", "SPK-006"),
            "GSI1PK": f"{ORG_ID}#{EVENT_ID}",
            "GSI1SK": f"SPEAKER#{status}#{NOW.isoformat()}",
        })

    # === Teams ===
    teams = [
        ("TEAM-marketing", "Marketing"),
        ("TEAM-registration", "Registration"),
        ("TEAM-speakers", "Speaker Management"),
        ("TEAM-venue", "Venue & Logistics"),
        ("TEAM-volunteers", "Volunteers"),
        ("TEAM-tech", "Technical Operations"),
    ]

    for team_id, name in teams:
        items.append({
            "PK": ORG_ID, "SK": f"EVENT#{EVENT_ID}#TEAM#{team_id}",
            "entity_type": "TEAM",
            "event_id": EVENT_ID,
            "team_id": team_id,
            "name": name,
            "is_active": True,
        })

    # === Tasks — with various states ===
    tasks = [
        ("TSK-001", "TEAM-marketing", "Send final event reminder email", "PENDING", "HIGH", "2026-10-14T18:00:00Z", []),
        ("TSK-002", "TEAM-marketing", "Update social media with venue map", "COMPLETED", "MEDIUM", "2026-10-13T12:00:00Z", []),
        ("TSK-003", "TEAM-registration", "Verify all VIP registrations", "IN_PROGRESS", "HIGH", "2026-10-14T16:00:00Z", []),
        ("TSK-004", "TEAM-registration", "Prepare check-in kits", "BLOCKED", "CRITICAL", "2026-10-14T20:00:00Z", ["TSK-008"]),
        ("TSK-005", "TEAM-speakers", "Confirm AV requirements with keynote", "OVERDUE", "CRITICAL", "2026-10-13T12:00:00Z", []),
        ("TSK-006", "TEAM-venue", "Test projector in main hall", "PENDING", "HIGH", "2026-10-14T14:00:00Z", []),
        ("TSK-007", "TEAM-volunteers", "Assign check-in desk volunteers", "COMPLETED", "HIGH", "2026-10-13T18:00:00Z", []),
        ("TSK-008", "TEAM-venue", "Receive printed badges from vendor", "PENDING", "CRITICAL", "2026-10-14T15:00:00Z", []),
        ("TSK-009", "TEAM-tech", "Deploy event app update", "OVERDUE", "HIGH", "2026-10-13T20:00:00Z", []),
    ]

    for task_id, team_id, title, status, priority, due, deps in tasks:
        items.append({
            "PK": ORG_ID, "SK": f"EVENT#{EVENT_ID}#TEAM#{team_id}#TASK#{task_id}",
            "entity_type": "TASK",
            "event_id": EVENT_ID,
            "team_id": team_id,
            "task_id": task_id,
            "title": title,
            "status": status,
            "priority": priority,
            "due_date": due,
            "depends_on": deps,
            "blocks": [],
            "escalation_level": 2 if status == "OVERDUE" else (1 if status == "BLOCKED" else 0),
            "GSI1PK": f"{ORG_ID}#{EVENT_ID}",
            "GSI1SK": f"TASK#{status}#{NOW.isoformat()}",
        })

    # === Incidents ===
    items.append({
        "PK": ORG_ID, "SK": f"EVENT#{EVENT_ID}#INCIDENT#INC-001",
        "entity_type": "INCIDENT",
        "event_id": EVENT_ID,
        "incident_id": "INC-001",
        "title": "Speaker James Chen cancelled — 2 hours before session",
        "description": "James Chen has cancelled his talk on Microservices Anti-Patterns due to a family emergency. Session was scheduled for 14:00.",
        "severity": "CRITICAL",
        "status": "RECOMMENDATION_READY",
        "affected_resource_type": "Speaker",
        "affected_resource_id": "SPK-006",
        "detected_at": NOW.isoformat(),
        "detected_by": "SpeakerOps",
        "recommendation": "Replace with backup speaker Meera Joshi (SPK-005), who is confirmed and available. Her topic on AI in Healthcare is relevant to the audience.",
        "backup_options": ["SPK-005"],
        "GSI1PK": f"{ORG_ID}#{EVENT_ID}",
        "GSI1SK": f"INCIDENT#DETECTED#{NOW.isoformat()}",
    })

    # === Pending Approvals ===
    items.append({
        "PK": ORG_ID, "SK": f"EVENT#{EVENT_ID}#APPROVAL#APR-001",
        "entity_type": "APPROVAL",
        "event_id": EVENT_ID,
        "approval_id": "APR-001",
        "title": "Replace cancelled speaker with backup",
        "description": "IncidentOps recommends replacing James Chen (cancelled) with Meera Joshi for the 14:00 session.",
        "status": "PENDING",
        "risk_level": "HIGH",
        "requested_action": "RESOLVE_INCIDENT",
        "reason": "Speaker cancellation — backup available with relevant topic",
        "evidence": {"incident_id": "INC-001", "backup_speaker": "SPK-005"},
        "affected_resource_type": "Incident",
        "affected_resource_id": "INC-001",
        "agent_name": "IncidentOps",
        "requested_at": NOW.isoformat(),
        "GSI1PK": f"{ORG_ID}#{EVENT_ID}",
        "GSI1SK": f"APPROVAL#PENDING#{NOW.isoformat()}",
    })

    items.append({
        "PK": ORG_ID, "SK": f"EVENT#{EVENT_ID}#APPROVAL#APR-002",
        "entity_type": "APPROVAL",
        "event_id": EVENT_ID,
        "approval_id": "APR-002",
        "title": "Send 3rd follow-up to Raj Malhotra",
        "description": "SpeakerOps wants to send a 3rd follow-up to Raj Malhotra who hasn't responded about his Cloud-Native Architecture talk.",
        "status": "PENDING",
        "risk_level": "MEDIUM",
        "requested_action": "SEND_SPEAKER_FOLLOWUP",
        "reason": "Follow-up count exceeds auto-send threshold (2 sent, no response)",
        "evidence": {"speaker_id": "SPK-002", "followup_count": 2},
        "affected_resource_type": "Speaker",
        "affected_resource_id": "SPK-002",
        "agent_name": "SpeakerOps",
        "requested_at": NOW.isoformat(),
        "GSI1PK": f"{ORG_ID}#{EVENT_ID}",
        "GSI1SK": f"APPROVAL#PENDING#{(NOW - timedelta(hours=1)).isoformat()}",
    })

    # === Write all items ===
    with table.batch_writer() as batch:
        for item in items:
            batch.put_item(Item=item)

    print(f"Seeded {len(items)} items to {table_name}")
    print(f"  Organization: {ORG_ID}")
    print(f"  Event: {EVENT_ID} (DevCon Bengaluru 2026)")
    print(f"  Registrations: {len(registrations)}")
    print(f"  Payments: {len(payments)}")
    print(f"  Speakers: {len(speakers)}")
    print(f"  Teams: {len(teams)}")
    print(f"  Tasks: {len(tasks)}")
    print(f"  Incidents: 1")
    print(f"  Pending approvals: 2")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed OrbitOps demo data")
    parser.add_argument("--table", default="OrbitOps-Main-dev", help="DynamoDB table name")
    parser.add_argument("--region", default="ap-south-1", help="AWS region")
    args = parser.parse_args()
    seed(args.table, args.region)
