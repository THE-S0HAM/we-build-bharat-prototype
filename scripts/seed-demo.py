#!/usr/bin/env python3
"""Seed the CommunityOps demo event.

Creates one fully populated event whose data tells a story, because a demo dataset of random
rows gives the agent nothing to reason about. Ask "what needs my attention" against random data
and you get a list; ask it against this data and you get a genuine operational situation with
causes, dependencies and a decision to make.

The story
---------
AWS Community Day Maharashtra 2026 is three weeks out and mostly on track, with five specific
problems:

* Registration has two overdue tasks — payment reconciliation slipped, and ticket generation is
  blocked behind it. A real dependency, not two unrelated late items.
* A speaker has been silent for 96 hours, with a follow-up already drafted and unsent.
* Another speaker needs accommodation, and the approval for it is waiting.
* A third speaker's travel estimate exceeds what is left in the travel allocation, so the
  budget and the speaker problem are the same problem.
* The technical team has an open HIGH incident with a live discussion thread.

The budget is deliberately healthy but constrained: exactly 75,000 remaining, so approving the
12,500 accommodation request lands on exactly 62,500 and a judge can verify the arithmetic.

Health computes to ORANGE from this state. Nothing sets the band directly.

Idempotency
-----------
Every item is written by a deterministic key, so re-running produces the same dataset rather
than duplicates. Timestamps are computed relative to now, so the story stays coherent whenever
it is seeded — the silent speaker is always 96 hours silent, never 96 hours from the day the
script was written.

No real personal data is used. Every name, address and transaction is invented.

Usage:
    python scripts/seed-demo.py --table CommunityOps-Main-dev --region ap-south-1

    # Bind demo team memberships to real Cognito subjects, so role scope resolves correctly:
    python scripts/seed-demo.py --leader-sub <sub> --team-sub <sub> --demo-sub <sub>
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import boto3

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from services.shared import keys  # noqa: E402

ORG_ID = "ORG-wemakedev"
EVENT_ID = "EVT-acd-mh-2026"
EVENT_NAME = "AWS Community Day — Maharashtra 2026"

NOW = datetime.now(UTC)
EVENT_START = NOW + timedelta(days=21)


def iso(moment: datetime) -> str:
    return moment.isoformat()


def hours_ago(hours: float) -> str:
    return iso(NOW - timedelta(hours=hours))


def days_ago(days: float) -> str:
    return iso(NOW - timedelta(days=days))


def in_hours(hours: float) -> str:
    return iso(NOW + timedelta(hours=hours))


def in_days(days: float) -> str:
    return iso(NOW + timedelta(days=days))


# ---------------------------------------------------------------------------
# Demo identities
#
# Cognito assigns a UUID subject to each user, and team scope is resolved from TeamMember
# records keyed by that subject. Readable placeholders are used by default so the dataset is
# inspectable; pass the real subjects to bind the demo logins to their memberships.
# ---------------------------------------------------------------------------
LEADER_SUB = "demo-leader-priya"
TEAM_SUB = "demo-team-rahul"
PUBLIC_DEMO_SUB = "demo-volunteer"

LEADER_NAME = "Priya Sharma"
TEAM_NAME = "Rahul Patil"
PUBLIC_DEMO_NAME = "Demo Volunteer"

# Placeholder subject -> real Cognito subject, populated from the command line.
#
# Applied as a rewrite pass over the finished dataset rather than by rebinding the constants
# above. The team, member and task tables are module-level literals evaluated at import time, so
# rebinding a name afterwards would leave every one of them still holding the placeholder — and
# a TeamMember record keyed by a placeholder subject means the real signed-in user belongs to no
# teams and can see nothing.
SUBJECT_OVERRIDES: dict[str, str] = {}


# ---------------------------------------------------------------------------
# Budget
#
# Chosen so the figures reconcile exactly and the headline demo step is verifiable:
#   total 2,50,000 - spent 1,30,000 - committed 45,000 = 75,000 remaining
# Approving the 12,500 accommodation request therefore lands on exactly 62,500.
# Per category, spent + committed never exceeds the allocation, which is the invariant
# budget_service enforces on every write.
# ---------------------------------------------------------------------------
TOTAL_BUDGET = 250_000

# category, allocated, spent, committed, note
BUDGET_CATEGORIES: list[tuple[str, int, int, int, str]] = [
    ("VENUE", 55_000, 50_000, 0, "Hall booking paid; balance held for overtime"),
    ("CATERING", 68_000, 40_000, 20_000, "Deposit paid, final headcount pending"),
    ("SPEAKER_TRAVEL", 38_000, 22_000, 10_000, "Four of five speakers booked"),
    ("ACCOMMODATION", 25_000, 0, 0, "Nothing booked yet"),
    ("EQUIPMENT", 22_000, 8_000, 12_000, "AV hire committed, projector contingency open"),
    ("MARKETING", 12_000, 10_000, 0, "Social campaign complete"),
    ("CERTIFICATES", 6_000, 0, 0, "Printing after the event"),
    ("TRANSPORTATION", 6_000, 0, 3_000, "Volunteer shuttle committed"),
    ("EMERGENCY", 8_000, 0, 0, "Held in reserve"),
]

ALLOCATED = sum(row[1] for row in BUDGET_CATEGORIES)
SPENT = sum(row[2] for row in BUDGET_CATEGORIES)
COMMITTED = sum(row[3] for row in BUDGET_CATEGORIES)


# ---------------------------------------------------------------------------
# Teams — the eight operational teams, with ~20 members across them
# ---------------------------------------------------------------------------
# team_id, name, lead_sub, lead_name, responsibilities
TEAMS: list[tuple[str, str, str, str, list[str]]] = [
    (
        "TEAM-marketing",
        "Marketing",
        "member-anita",
        "Anita Deshmukh",
        ["Announcements", "Social media", "Speaker cards", "Reminders"],
    ),
    (
        "TEAM-registration",
        "Registration",
        "member-vikram",
        "Vikram Joshi",
        ["Registration list", "Payment reconciliation", "Ticketing", "Check-in desk"],
    ),
    (
        "TEAM-speakers",
        "Speaker Management",
        "member-sneha",
        "Sneha Kulkarni",
        ["Outreach", "Confirmations", "Travel", "Presentations"],
    ),
    (
        "TEAM-venue",
        "Venue & Logistics",
        "member-arjun",
        "Arjun Pawar",
        ["Seating", "Signage", "Power", "Access"],
    ),
    (
        "TEAM-sponsorship",
        "Sponsorship",
        "member-farida",
        "Farida Shaikh",
        ["Sponsor deliverables", "Booths", "Logos"],
    ),
    (
        "TEAM-tech",
        "Technical",
        TEAM_SUB,
        TEAM_NAME,
        ["AV", "Livestream", "Microphones", "Backup equipment"],
    ),
    (
        "TEAM-volunteers",
        "Volunteer Coordination",
        "member-rohan",
        "Rohan Gaikwad",
        ["Rostering", "Briefing", "Badges", "Desk cover"],
    ),
    (
        "TEAM-attendee-ops",
        "Attendee Experience",
        "member-neha",
        "Neha Bhosale",
        ["Accommodation", "Dietary needs", "Arrival coordination"],
    ),
]

# user_id, display_name, team_id, team_role, skills
MEMBERS: list[tuple[str, str, str, str, list[str]]] = [
    # Marketing — 3
    ("member-anita", "Anita Deshmukh", "TEAM-marketing", "LEAD", ["Content", "Social"]),
    ("member-pooja", "Pooja Rane", "TEAM-marketing", "MEMBER", ["Design"]),
    ("member-imran", "Imran Qureshi", "TEAM-marketing", "MEMBER", ["Copywriting"]),
    # Registration — 3
    ("member-vikram", "Vikram Joshi", "TEAM-registration", "LEAD", ["Operations", "Finance"]),
    ("member-shruti", "Shruti Patil", "TEAM-registration", "MEMBER", ["Data entry"]),
    ("member-kiran", "Kiran More", "TEAM-registration", "MEMBER", ["Reconciliation"]),
    # Speaker Management — 3
    ("member-sneha", "Sneha Kulkarni", "TEAM-speakers", "LEAD", ["Outreach"]),
    ("member-devika", "Devika Iyer", "TEAM-speakers", "MEMBER", ["Scheduling"]),
    ("member-nikhil", "Nikhil Sawant", "TEAM-speakers", "MEMBER", ["Travel desk"]),
    # Venue & Logistics — 3
    ("member-arjun", "Arjun Pawar", "TEAM-venue", "LEAD", ["Logistics"]),
    ("member-manish", "Manish Kadam", "TEAM-venue", "MEMBER", ["Setup"]),
    ("member-ritu", "Ritu Chavan", "TEAM-venue", "MEMBER", ["Vendor liaison"]),
    # Sponsorship — 2
    ("member-farida", "Farida Shaikh", "TEAM-sponsorship", "LEAD", ["Partnerships"]),
    ("member-aditya", "Aditya Ranade", "TEAM-sponsorship", "MEMBER", ["Accounts"]),
    # Technical — 3 (includes the demo team-member login)
    (TEAM_SUB, TEAM_NAME, "TEAM-tech", "LEAD", ["AV", "Networking"]),
    ("member-sagar", "Sagar Bhoir", "TEAM-tech", "MEMBER", ["Livestream"]),
    (PUBLIC_DEMO_SUB, PUBLIC_DEMO_NAME, "TEAM-tech", "MEMBER", ["General support"]),
    # Volunteer Coordination — 2
    ("member-rohan", "Rohan Gaikwad", "TEAM-volunteers", "LEAD", ["Rostering"]),
    ("member-tanvi", "Tanvi Salunkhe", "TEAM-volunteers", "MEMBER", ["Briefing"]),
    # Attendee Experience — 1
    ("member-neha", "Neha Bhosale", "TEAM-attendee-ops", "LEAD", ["Hospitality"]),
]


# ---------------------------------------------------------------------------
# Speakers — five, each carrying a distinct operational situation
# ---------------------------------------------------------------------------
# id, name, topic, session_type, status, silent_hours_or_None, travel, origin,
# accommodation, nights, travel_cost, accommodation_cost, slot, slides, confirmed
SPEAKERS: list[dict[str, Any]] = [
    {
        "speaker_id": "SPK-001",
        "name": "Dr. Ananya Krishnan",
        "email": "ananya.k@example.com",
        "topic": "Building Responsible AI Systems on AWS",
        "session_type": "KEYNOTE",
        "status": "CONFIRMED",
        "responded_hours_ago": 120,
        "travel_required": True,
        "travel_origin": "Bengaluru",
        "estimated_travel_cost": 9_000,
        "accommodation_required": False,
        "accommodation_nights": 0,
        "estimated_accommodation_cost": 0,
        "session_time": iso(EVENT_START.replace(hour=10, minute=0)),
        "slides_submitted": True,
        "availability_confirmed": True,
        "note": "Confirmed and ready. The uncomplicated one.",
    },
    {
        "speaker_id": "SPK-002",
        "name": "Raj Malhotra",
        "email": "raj.malhotra@example.com",
        "topic": "Cloud-Native Architecture Patterns",
        "session_type": "TALK",
        "status": "AWAITING_RESPONSE",
        "contacted_hours_ago": 96,
        "travel_required": False,
        "travel_origin": "Pune",
        "estimated_travel_cost": 0,
        "accommodation_required": False,
        "accommodation_nights": 0,
        "estimated_accommodation_cost": 0,
        "session_time": "",
        "slides_submitted": False,
        "availability_confirmed": False,
        "followup_count": 1,
        "has_draft": True,
        "note": "Silent 96h with a follow-up already drafted and unsent.",
    },
    {
        "speaker_id": "SPK-003",
        "name": "Kavya Nair",
        "email": "kavya.nair@example.com",
        "topic": "Serverless Data Pipelines at Community Scale",
        "session_type": "TALK",
        "status": "INVITED",
        "contacted_hours_ago": 30,
        "travel_required": True,
        "travel_origin": "Kochi",
        "estimated_travel_cost": 11_000,
        "accommodation_required": True,
        "accommodation_nights": 2,
        "estimated_accommodation_cost": 12_500,
        "session_time": "",
        "slides_submitted": False,
        "availability_confirmed": True,
        "note": "Needs accommodation. This is the 12,500 approval waiting for the leader.",
    },
    {
        "speaker_id": "SPK-004",
        "name": "Suresh Rajan",
        "email": "suresh.rajan@example.com",
        "topic": "Zero Trust Security for Small Teams",
        "session_type": "WORKSHOP",
        "status": "CONFIRMED",
        "responded_hours_ago": 48,
        "travel_required": True,
        "travel_origin": "Delhi",
        "estimated_travel_cost": 18_000,
        "accommodation_required": True,
        "accommodation_nights": 1,
        "estimated_accommodation_cost": 6_500,
        "session_time": iso(EVENT_START.replace(hour=14, minute=0)),
        "slides_submitted": False,
        "availability_confirmed": True,
        "note": (
            "Travel estimate of 18,000 exceeds the 6,000 left in SPEAKER_TRAVEL. "
            "The budget problem and the speaker problem are the same problem."
        ),
    },
    {
        "speaker_id": "SPK-005",
        "name": "Meera Joshi",
        "email": "meera.joshi@example.com",
        "topic": "Practical MLOps for Startups",
        "session_type": "TALK",
        "status": "CONFIRMED",
        "responded_hours_ago": 72,
        "travel_required": False,
        "travel_origin": "Mumbai",
        "estimated_travel_cost": 2_000,
        "accommodation_required": False,
        "accommodation_nights": 0,
        "estimated_accommodation_cost": 0,
        "session_time": iso(EVENT_START.replace(hour=12, minute=0)),
        "slides_submitted": True,
        "availability_confirmed": True,
        "is_backup": True,
        "note": "Confirmed, and doubles as the backup if a slot opens up.",
    },
]


# ---------------------------------------------------------------------------
# Tasks — 31 across the eight teams, with a realistic mix and one real dependency chain
# ---------------------------------------------------------------------------
# task_id, team_id, title, status, priority, due_offset_hours, assignee, effort, depends_on
TASKS: list[tuple[str, str, str, str, str, float, str, int, list[str]]] = [
    # Marketing — mostly on track
    (
        "TSK-mk01",
        "TEAM-marketing",
        "Publish event announcement",
        "COMPLETED",
        "HIGH",
        -240,
        "member-anita",
        3,
        [],
    ),
    (
        "TSK-mk02",
        "TEAM-marketing",
        "Prepare speaker announcement cards",
        "IN_PROGRESS",
        "MEDIUM",
        72,
        "member-pooja",
        4,
        [],
    ),
    (
        "TSK-mk03",
        "TEAM-marketing",
        "Schedule registration reminder sequence",
        "COMPLETED",
        "MEDIUM",
        -48,
        "member-imran",
        2,
        [],
    ),
    (
        "TSK-mk04",
        "TEAM-marketing",
        "Publish final agenda",
        "BACKLOG",
        "HIGH",
        408,
        "",
        2,
        ["TSK-sp02"],
    ),
    # Registration — two overdue, and the second is blocked behind the first
    (
        "TSK-rg01",
        "TEAM-registration",
        "Open registration and verify the form",
        "COMPLETED",
        "CRITICAL",
        -480,
        "member-vikram",
        2,
        [],
    ),
    (
        "TSK-rg02",
        "TEAM-registration",
        "Reconcile payment records against registrations",
        "IN_PROGRESS",
        "HIGH",
        -18,
        "member-kiran",
        4,
        [],
    ),
    (
        "TSK-rg03",
        "TEAM-registration",
        "Generate tickets for pending registrations",
        "BLOCKED",
        "HIGH",
        -4,
        "member-shruti",
        3,
        ["TSK-rg02"],
    ),
    (
        "TSK-rg04",
        "TEAM-registration",
        "Prepare check-in desk kits",
        "BACKLOG",
        "CRITICAL",
        480,
        "",
        3,
        ["TSK-rg03"],
    ),
    (
        "TSK-rg05",
        "TEAM-registration",
        "Verify the waitlist and release spare seats",
        "ASSIGNED",
        "MEDIUM",
        120,
        "member-shruti",
        2,
        [],
    ),
    # Speaker Management — one critical follow-up
    (
        "TSK-sp01",
        "TEAM-speakers",
        "Send speaker invitations",
        "COMPLETED",
        "CRITICAL",
        -600,
        "member-sneha",
        4,
        [],
    ),
    (
        "TSK-sp02",
        "TEAM-speakers",
        "Confirm speaker availability and topics",
        "IN_PROGRESS",
        "CRITICAL",
        48,
        "member-sneha",
        5,
        [],
    ),
    (
        "TSK-sp03",
        "TEAM-speakers",
        "Follow up with Raj Malhotra — silent 96h",
        "ASSIGNED",
        "CRITICAL",
        6,
        "member-devika",
        1,
        [],
    ),
    (
        "TSK-sp04",
        "TEAM-speakers",
        "Collect travel and accommodation requirements",
        "IN_PROGRESS",
        "HIGH",
        96,
        "member-nikhil",
        3,
        [],
    ),
    (
        "TSK-sp05",
        "TEAM-speakers",
        "Collect presentations and AV requirements",
        "BACKLOG",
        "HIGH",
        360,
        "",
        4,
        ["TSK-sp02"],
    ),
    (
        "TSK-sp06",
        "TEAM-speakers",
        "Resolve Suresh Rajan's travel cost against budget",
        "ASSIGNED",
        "HIGH",
        48,
        "member-nikhil",
        2,
        [],
    ),
    # Venue — capacity confirmation pending
    (
        "TSK-vn01",
        "TEAM-venue",
        "Confirm venue booking and capacity",
        "REVIEW",
        "CRITICAL",
        24,
        "member-arjun",
        3,
        [],
    ),
    (
        "TSK-vn02",
        "TEAM-venue",
        "Verify seating layout against expected attendance",
        "ASSIGNED",
        "HIGH",
        168,
        "member-manish",
        2,
        ["TSK-vn01"],
    ),
    (
        "TSK-vn03",
        "TEAM-venue",
        "Confirm power backup and internet",
        "ASSIGNED",
        "CRITICAL",
        432,
        "member-ritu",
        2,
        [],
    ),
    (
        "TSK-vn04",
        "TEAM-venue",
        "Install signage and wayfinding",
        "BACKLOG",
        "MEDIUM",
        480,
        "",
        3,
        [],
    ),
    # Sponsorship — quiet
    (
        "TSK-sn01",
        "TEAM-sponsorship",
        "Confirm sponsor commitments",
        "COMPLETED",
        "HIGH",
        -120,
        "member-farida",
        4,
        [],
    ),
    (
        "TSK-sn02",
        "TEAM-sponsorship",
        "Collect sponsor logos and branding assets",
        "IN_PROGRESS",
        "MEDIUM",
        144,
        "member-aditya",
        2,
        [],
    ),
    (
        "TSK-sn03",
        "TEAM-sponsorship",
        "Confirm booth requirements and placement",
        "BACKLOG",
        "MEDIUM",
        384,
        "",
        3,
        [],
    ),
    # Technical — the incident lives here
    (
        "TSK-tc01",
        "TEAM-tech",
        "Test microphones and sound system",
        "ASSIGNED",
        "CRITICAL",
        456,
        TEAM_SUB,
        3,
        [],
    ),
    (
        "TSK-tc02",
        "TEAM-tech",
        "Test main hall projector",
        "BLOCKED",
        "CRITICAL",
        12,
        TEAM_SUB,
        2,
        [],
    ),
    (
        "TSK-tc03",
        "TEAM-tech",
        "Configure and rehearse livestream",
        "IN_PROGRESS",
        "HIGH",
        336,
        "member-sagar",
        4,
        [],
    ),
    (
        "TSK-tc04",
        "TEAM-tech",
        "Prepare backup laptop and adapters",
        "ASSIGNED",
        "HIGH",
        456,
        PUBLIC_DEMO_SUB,
        2,
        [],
    ),
    # Volunteers
    (
        "TSK-vl01",
        "TEAM-volunteers",
        "Recruit and confirm volunteers",
        "COMPLETED",
        "HIGH",
        -72,
        "member-rohan",
        5,
        [],
    ),
    (
        "TSK-vl02",
        "TEAM-volunteers",
        "Assign registration desk shifts",
        "ASSIGNED",
        "HIGH",
        408,
        "member-tanvi",
        2,
        [],
    ),
    (
        "TSK-vl03",
        "TEAM-volunteers",
        "Prepare volunteer badges and briefing pack",
        "BACKLOG",
        "MEDIUM",
        432,
        "",
        3,
        [],
    ),
    # Attendee Experience — catering deadline is the pressure point
    (
        "TSK-ao01",
        "TEAM-attendee-ops",
        "Collect dietary requirements from attendees",
        "IN_PROGRESS",
        "HIGH",
        8,
        "member-neha",
        3,
        [],
    ),
    (
        "TSK-ao02",
        "TEAM-attendee-ops",
        "Confirm catering headcount with the vendor",
        "ASSIGNED",
        "CRITICAL",
        12,
        "member-neha",
        2,
        ["TSK-ao01"],
    ),
]


def _speaker_item(spec: dict[str, Any]) -> dict[str, Any]:
    """Build a speaker record, deriving outreach timestamps from the story."""
    contacted = spec.get("contacted_hours_ago")
    responded = spec.get("responded_hours_ago")

    # A speaker who replied is measured from their reply; one who has not is measured from the
    # last time we reached out. The health engine reads exactly this distinction.
    invited_at = hours_ago(max(contacted or 0, responded or 0) + 48)
    last_contacted = hours_ago(contacted) if contacted is not None else invited_at
    response_at = hours_ago(responded) if responded is not None else None

    item = {
        "entity_type": "SPEAKER",
        "event_id": EVENT_ID,
        "speaker_id": spec["speaker_id"],
        "name": spec["name"],
        "email": spec["email"],
        "phone": "",
        "status": spec["status"],
        "topic": spec["topic"],
        "bio": "",
        "session_type": spec["session_type"],
        "session_duration_minutes": 45 if spec["session_type"] == "KEYNOTE" else 30,
        "session_time": spec["session_time"],
        "invited_at": invited_at,
        "last_contacted_at": last_contacted,
        "response_received_at": response_at,
        "followup_count": spec.get("followup_count", 0),
        "max_followups": 3,
        "travel_required": spec["travel_required"],
        "travel_origin": spec["travel_origin"],
        "accommodation_required": spec["accommodation_required"],
        "accommodation_nights": spec["accommodation_nights"],
        "estimated_travel_cost": spec["estimated_travel_cost"],
        "estimated_accommodation_cost": spec["estimated_accommodation_cost"],
        "travel_details": f"Travelling from {spec['travel_origin']}"
        if spec["travel_required"]
        else "",
        "accommodation_details": "",
        "special_requirements": "",
        "availability_notes": spec.get("note", ""),
        "availability_confirmed": spec["availability_confirmed"],
        "slides_submitted": spec["slides_submitted"],
        "av_requirements": "",
        "is_backup": spec.get("is_backup", False),
        "backup_for_speaker_id": None,
        "created_at": invited_at,
        "updated_at": last_contacted,
        "created_by": LEADER_SUB,
        "updated_by": LEADER_SUB,
        "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
        "GSI1SK": keys.speaker_gsi1sk(spec["status"], invited_at),
    }

    if spec.get("has_draft"):
        item["followup_draft"] = (
            f"Hi {spec['name'].split()[0]},\n\n"
            f"Following up on {EVENT_NAME}. We had reached out about "
            f'"{spec["topic"]}" and have not heard back yet.\n\n'
            "Could you confirm whether you are still able to join us? If your availability has "
            "changed, that is completely fine — knowing either way lets us finalise the "
            "schedule.\n\nThanks,\nThe organising team"
        )
        item["followup_draft_at"] = hours_ago(2)
    return item


def build_items() -> list[tuple[str, dict[str, Any]]]:
    """Assemble every (sort key, attributes) pair for the demo dataset."""
    items: list[tuple[str, dict[str, Any]]] = []

    def add(sk: str, attributes: dict[str, Any]) -> None:
        items.append((sk, attributes))

    # --- organization ------------------------------------------------------
    add(
        keys.organization_sk(ORG_ID),
        {
            "entity_type": "ORGANIZATION",
            "organization_id": ORG_ID,
            "name": "WeMakeDev",
            "slug": "wemakedev",
            "description": "A community for builders and developers across Maharashtra",
            "contact_email": "hello@wemakedev.example",
            "is_active": True,
            "created_at": days_ago(400),
            "updated_at": days_ago(400),
        },
    )

    # --- event -------------------------------------------------------------
    # health_band is seeded as a placeholder. The engine computes the real value on the first
    # read, and seeding a band directly would defeat the point of having a deterministic score.
    add(
        keys.event_sk(EVENT_ID),
        {
            "entity_type": "EVENT",
            "event_id": EVENT_ID,
            "name": EVENT_NAME,
            "description": (
                "A full-day community conference for AWS builders across Maharashtra: keynotes, "
                "workshops and a hallway track."
            ),
            "status": "ACTIVE",
            "venue": "Pune International Convention Centre",
            "city": "Pune",
            "start_date": iso(EVENT_START.replace(hour=9, minute=0)),
            "end_date": iso(EVENT_START.replace(hour=18, minute=0)),
            "timezone": "Asia/Kolkata",
            "expected_attendees": 320,
            "registration_target": 300,
            "registration_open": True,
            "total_budget": TOTAL_BUDGET,
            "tags": ["aws", "community", "cloud", "ai"],
            "health_band": "ORANGE",
            "health_score": 0,
            "health_reasons": [],
            "simulation_step": 0,
            "created_at": days_ago(60),
            "updated_at": hours_ago(1),
            "created_by": LEADER_SUB,
            "updated_by": LEADER_SUB,
            "GSI1PK": keys.events_gsi1pk(ORG_ID),
            "GSI1SK": keys.event_status_gsi1sk("ACTIVE", days_ago(60)),
        },
    )

    # --- budget ------------------------------------------------------------
    add(
        keys.budget_sk(EVENT_ID),
        {
            "entity_type": "BUDGET",
            "event_id": EVENT_ID,
            "currency": "INR",
            "total_budget": TOTAL_BUDGET,
            "allocated": ALLOCATED,
            "spent": SPENT,
            "committed": COMMITTED,
            "notes": "Healthy but constrained. Accommodation is unallocated spend waiting on a decision.",
            "created_at": days_ago(55),
            "updated_at": hours_ago(6),
            "created_by": LEADER_SUB,
            "updated_by": LEADER_SUB,
            "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
            "GSI1SK": "BUDGET",
        },
    )

    for category, allocated, spent, committed, note in BUDGET_CATEGORIES:
        add(
            keys.budget_allocation_sk(EVENT_ID, category),
            {
                "entity_type": "BUDGET_ALLOCATION",
                "event_id": EVENT_ID,
                "category": category,
                "allocated": allocated,
                "spent": spent,
                "committed": committed,
                "notes": note,
                "created_at": days_ago(55),
                "updated_at": hours_ago(6),
                "created_by": LEADER_SUB,
                "updated_by": LEADER_SUB,
                "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
                "GSI1SK": f"BUDGETCAT#{category}",
            },
        )

    # --- expenses ----------------------------------------------------------
    expenses = [
        ("EXP-001", "VENUE", 50_000, "Hall booking — full day", "Pune ICC", 40),
        ("EXP-002", "CATERING", 40_000, "Catering deposit — 300 covers", "Sahyadri Caterers", 25),
        (
            "EXP-003",
            "SPEAKER_TRAVEL",
            9_000,
            "Flight — Bengaluru to Pune (SPK-001)",
            "AirBooking",
            12,
        ),
        ("EXP-004", "SPEAKER_TRAVEL", 11_000, "Flight — Kochi to Pune (SPK-003)", "AirBooking", 8),
        ("EXP-005", "SPEAKER_TRAVEL", 2_000, "Local travel reimbursement (SPK-005)", "", 6),
        ("EXP-006", "EQUIPMENT", 8_000, "Sound system hire", "Pune AV Rentals", 15),
        ("EXP-007", "MARKETING", 10_000, "Social media campaign", "Reach Digital", 30),
    ]
    for expense_id, category, amount, description, vendor, days in expenses:
        add(
            keys.expense_sk(EVENT_ID, expense_id),
            {
                "entity_type": "EXPENSE",
                "event_id": EVENT_ID,
                "expense_id": expense_id,
                "category": category,
                "amount_inr": amount,
                "description": description,
                "status": "RECORDED",
                "vendor": vendor,
                "approval_id": None,
                "incurred_at": days_ago(days),
                "recorded_by": LEADER_SUB,
                "created_at": days_ago(days),
                "updated_at": days_ago(days),
                "created_by": LEADER_SUB,
                "updated_by": LEADER_SUB,
                "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
                "GSI1SK": keys.expense_gsi1sk(days_ago(days)),
            },
        )

    # --- teams and members -------------------------------------------------
    members_by_team: dict[str, list[tuple[str, str, str, str, list[str]]]] = {}
    for member in MEMBERS:
        members_by_team.setdefault(member[2], []).append(member)

    for team_id, name, lead_sub, lead_name, responsibilities in TEAMS:
        team_members = members_by_team.get(team_id, [])
        add(
            keys.team_sk(EVENT_ID, team_id),
            {
                "entity_type": "TEAM",
                "event_id": EVENT_ID,
                "team_id": team_id,
                "name": name,
                "description": "",
                "responsibilities": responsibilities,
                "lead_user_id": lead_sub,
                "lead_name": lead_name,
                "member_count": len(team_members),
                "is_active": True,
                "created_at": days_ago(58),
                "updated_at": days_ago(10),
                "created_by": LEADER_SUB,
                "updated_by": LEADER_SUB,
                "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
                "GSI1SK": f"TEAM#{team_id}",
            },
        )

    for user_id, display_name, team_id, team_role, skills in MEMBERS:
        open_count = sum(
            1 for task in TASKS if task[6] == user_id and task[3] not in ("COMPLETED", "CANCELLED")
        )
        done_count = sum(1 for task in TASKS if task[6] == user_id and task[3] == "COMPLETED")
        add(
            keys.team_member_sk(EVENT_ID, team_id, user_id),
            {
                "entity_type": "TEAM_MEMBER",
                "event_id": EVENT_ID,
                "team_id": team_id,
                "user_id": user_id,
                "display_name": display_name,
                "email": f"{display_name.split()[0].lower()}@example.com",
                "team_role": team_role,
                "skills": skills,
                "is_active": True,
                "active_task_count": open_count,
                "completed_task_count": done_count,
                "created_at": days_ago(50),
                "updated_at": days_ago(10),
                "created_by": LEADER_SUB,
                "updated_by": LEADER_SUB,
                "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
                "GSI1SK": keys.team_member_gsi1sk(team_id, user_id),
                # Indexed per user as well, because principal resolution asks "which teams does
                # this person belong to", which the event-scoped index cannot answer.
                "GSI2PK": keys.user_gsi2pk(ORG_ID, user_id),
                "GSI2SK": keys.team_member_gsi2sk(EVENT_ID, team_id),
            },
        )

    # --- speakers ----------------------------------------------------------
    for spec in SPEAKERS:
        add(keys.speaker_sk(EVENT_ID, spec["speaker_id"]), _speaker_item(spec))

    # --- tasks -------------------------------------------------------------
    name_by_sub = {m[0]: m[1] for m in MEMBERS}
    for (
        task_id,
        team_id,
        title,
        status,
        priority,
        due_offset,
        assignee,
        effort,
        depends_on,
    ) in TASKS:
        due_date = in_hours(due_offset)
        created = days_ago(30)
        completed_at = hours_ago(abs(due_offset) - 2) if status == "COMPLETED" else None
        add(
            keys.task_sk(EVENT_ID, team_id, task_id),
            {
                "entity_type": "TASK",
                "event_id": EVENT_ID,
                "team_id": team_id,
                "task_id": task_id,
                "title": title,
                "description": "",
                "status": status,
                "priority": priority,
                # Risk is an explicit judgement about the work, separate from priority. Blocked
                # critical work is the combination worth flagging.
                "risk": "HIGH" if status == "BLOCKED" and priority == "CRITICAL" else "NONE",
                "assigned_to": assignee,
                "assigned_to_name": name_by_sub.get(assignee, ""),
                "due_date": due_date,
                "completed_at": completed_at,
                "depends_on": depends_on,
                "blocks": [t[0] for t in TASKS if task_id in t[8]],
                "escalation_level": 2 if status == "BLOCKED" else 0,
                "estimated_effort_hours": effort,
                "blocked_reason": (
                    "Waiting on payment reconciliation to complete"
                    if task_id == "TSK-rg03"
                    else "Main hall projector has failed — see the open incident"
                    if task_id == "TSK-tc02"
                    else ""
                ),
                "notes": "",
                "source_comment_id": None,
                "source_incident_id": "INC-001" if task_id == "TSK-tc02" else None,
                "created_at": created,
                "updated_at": hours_ago(4),
                "created_by": LEADER_SUB,
                "updated_by": LEADER_SUB,
                "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
                "GSI1SK": keys.task_gsi1sk(status, created),
                "GSI2PK": keys.task_gsi2pk(ORG_ID, EVENT_ID),
                "GSI2SK": keys.task_gsi2sk(status, due_date, task_id),
            },
        )

    # --- incidents and their discussions ----------------------------------
    items.extend(_incident_items())

    # --- approvals ---------------------------------------------------------
    items.extend(_approval_items())

    # --- registrations, attendees, check-ins, tickets ----------------------
    items.extend(_attendee_items())

    # --- documents ---------------------------------------------------------
    documents = [
        (
            "DOC-001",
            "speaker-guidelines.pdf",
            "application/pdf",
            "SPEAKER",
            184_320,
            "What we ask of speakers",
        ),
        (
            "DOC-002",
            "event-budget.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "BUDGET",
            47_104,
            "Working budget sheet",
        ),
        (
            "DOC-003",
            "venue-policy.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "VENUE",
            31_744,
            "Venue rules and access times",
        ),
        (
            "DOC-004",
            "volunteer-instructions.txt",
            "text/plain",
            "VOLUNTEER",
            6_144,
            "Desk and briefing instructions",
        ),
        (
            "DOC-005",
            "sponsor-deck.pdf",
            "application/pdf",
            "SPONSOR",
            2_097_152,
            "Sponsorship tiers and deliverables",
        ),
    ]
    from services.shared.models.document import ALLOWED_CONTENT_TYPES

    for document_id, filename, content_type, category, size, description in documents:
        uploaded = days_ago(20)
        add(
            keys.document_sk(EVENT_ID, document_id),
            {
                "entity_type": "DOCUMENT",
                "event_id": EVENT_ID,
                "document_id": document_id,
                "filename": filename,
                "content_type": content_type,
                "file_type": ALLOWED_CONTENT_TYPES.get(content_type, ""),
                "size_bytes": size,
                "category": category,
                "s3_key": keys.document_s3_key(ORG_ID, EVENT_ID, document_id, filename),
                "description": description,
                "uploaded_by": LEADER_SUB,
                "uploaded_at": uploaded,
                # Marked confirmed so the documents list renders. The S3 objects themselves are
                # not seeded — downloading one will fail, which is honest: the metadata is demo
                # data and there is no file behind it.
                "upload_confirmed": True,
                "is_demo_placeholder": True,
                "created_at": uploaded,
                "updated_at": uploaded,
                "created_by": LEADER_SUB,
                "updated_by": LEADER_SUB,
                "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
                "GSI1SK": keys.document_gsi1sk(category, uploaded),
            },
        )

    # --- notifications -----------------------------------------------------
    items.extend(_notification_items())

    return items


def _incident_items() -> list[tuple[str, dict[str, Any]]]:
    """One open HIGH incident with a live thread, one resolved, one low priority."""
    items: list[tuple[str, dict[str, Any]]] = []

    def incident(
        incident_id: str,
        title: str,
        description: str,
        severity: str,
        status: str,
        category: str,
        team_id: str,
        detected_hours: float,
        extra: dict[str, Any],
        comment_count: int,
    ) -> None:
        detected = hours_ago(detected_hours)
        items.append(
            (
                keys.incident_sk(EVENT_ID, incident_id),
                {
                    "entity_type": "INCIDENT",
                    "event_id": EVENT_ID,
                    "incident_id": incident_id,
                    "title": title,
                    "description": description,
                    "severity": severity,
                    "status": status,
                    "category": category,
                    "team_id": team_id,
                    "detected_at": detected,
                    "detected_by": "user",
                    "dependencies": [],
                    "backup_options": [],
                    "actions_taken": [],
                    "comment_count": comment_count,
                    "reopened_count": 0,
                    "created_at": detected,
                    "updated_at": hours_ago(1),
                    "created_by": LEADER_SUB,
                    "updated_by": LEADER_SUB,
                    "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
                    "GSI1SK": keys.incident_gsi1sk(status, detected),
                    **extra,
                },
            )
        )

    incident(
        "INC-001",
        "Main hall projector failed during AV testing",
        (
            "The primary projector in the main hall stopped displaying partway through AV "
            "testing. Two cables were tried with no result. A backup unit exists in storage but "
            "has never been tested with the presentation laptop."
        ),
        "HIGH",
        "RECOMMENDATION_READY",
        "TECHNICAL",
        "TEAM-tech",
        6,
        {
            "affected_resource_type": "Venue",
            "affected_resource_id": "main-hall",
            "reported_by": TEAM_SUB,
            "reported_by_name": TEAM_NAME,
            "reported_by_role": "TEAM_MEMBER",
            "assigned_to": TEAM_SUB,
            "assigned_to_name": TEAM_NAME,
            "acknowledged_at": hours_ago(5),
            "acknowledged_by": LEADER_SUB,
            "impact_analysis": (
                "The main hall is the only projection-capable room, so every session depends on it."
            ),
            "dependencies": [
                "Session schedule",
                "Speaker slide handover",
                "Volunteer briefing",
            ],
            "backup_options": [
                "Untested backup projector in storage",
                "Hire a replacement unit (~7,000)",
            ],
            "recommendation": (
                "Test the backup projector against the presentation laptop before committing to "
                "a hire. If it fails, hire a replacement — that needs leader approval."
            ),
            "evidence": "Two cables tested, no image. Backup unit has no record of being tested.",
        },
        3,
    )

    incident(
        "INC-002",
        "Registration form rejected UPI payment references",
        (
            "Attendees paying by UPI saw a validation error on the reference field, so twelve "
            "registrations completed without a payment reference attached."
        ),
        "MEDIUM",
        "RESOLVED",
        "REGISTRATION",
        "TEAM-registration",
        72,
        {
            "affected_resource_type": "Registration",
            "affected_resource_id": "form",
            "reported_by": "member-kiran",
            "reported_by_name": "Kiran More",
            "reported_by_role": "TEAM_MEMBER",
            "assigned_to": "member-vikram",
            "assigned_to_name": "Vikram Joshi",
            "acknowledged_at": hours_ago(70),
            "acknowledged_by": LEADER_SUB,
            "resolved_at": hours_ago(40),
            "resolved_by": LEADER_SUB,
            "resolution_summary": (
                "Validation pattern corrected to accept UPI reference formats. The twelve "
                "affected registrations are being reconciled manually."
            ),
            "root_cause": (
                "The reference field validated against card transaction ids only; UPI references "
                "use a different format."
            ),
            "actions_taken": [
                "Corrected the validation pattern",
                "Contacted the twelve affected attendees",
                "Opened a reconciliation task for the Registration team",
            ],
        },
        2,
    )

    incident(
        "INC-003",
        "Directional signage order is a day late",
        "The printer has pushed delivery by one day. Still ahead of the event date.",
        "LOW",
        "ACKNOWLEDGED",
        "LOGISTICS",
        "TEAM-venue",
        20,
        {
            "affected_resource_type": "Venue",
            "affected_resource_id": "signage",
            "reported_by": "member-ritu",
            "reported_by_name": "Ritu Chavan",
            "reported_by_role": "TEAM_MEMBER",
            "assigned_to": "member-arjun",
            "assigned_to_name": "Arjun Pawar",
            "acknowledged_at": hours_ago(18),
            "acknowledged_by": LEADER_SUB,
        },
        1,
    )

    # The discussion on INC-001, which is what makes the incident reasoning demonstrable: a
    # human report, a leader question, a team answer, and the agent's analysis with the
    # dependency it found.
    thread: list[tuple[str, str, str, str, str, float, str | None]] = [
        (
            "CMT-001",
            TEAM_SUB,
            TEAM_NAME,
            "user",
            "Projector stopped working about ten minutes into testing. No image at all, tried two "
            "cables and both laptop ports.",
            6,
            None,
        ),
        (
            "CMT-002",
            LEADER_SUB,
            LEADER_NAME,
            "user",
            "Can the backup projector be used? I thought we had one in storage.",
            5.5,
            "CMT-001",
        ),
        (
            "CMT-003",
            "member-arjun",
            "Arjun Pawar",
            "user",
            "Backup is in storage and physically present, but nobody has tested it with this "
            "year's laptop setup.",
            5,
            "CMT-002",
        ),
        (
            "CMT-004",
            "CommunityOps",
            "CommunityOps Agent",
            "agent",
            "Impact: HIGH — the main hall is the only projection-capable room, so all five "
            "sessions depend on it.\n\n"
            "Dependencies I found: the session schedule, the speaker slide handover, and the "
            "volunteer briefing all assume main-hall projection.\n\n"
            "Recommended actions:\n"
            "1. Test the backup projector against the presentation laptop before 5pm today. I "
            "have created TSK-tc02 for the Technical team and marked it BLOCKED on this "
            "incident.\n"
            "2. If the backup also fails, hiring a replacement is roughly 7,000. EQUIPMENT has "
            "2,000 uncommitted, so that would need either a reallocation or a draw on "
            "EMERGENCY — either way it is a financial commitment and needs your approval.\n"
            "3. Hold the schedule unchanged until the backup test result is known.\n\n"
            "Action 2 requires your approval. Actions 1 and 3 I have handled.",
            4.5,
            None,
        ),
    ]
    for comment_id, author_id, author_name, author_type, body, hours, parent in thread:
        created = hours_ago(hours)
        items.append(
            (
                keys.incident_comment_sk(EVENT_ID, "INC-001", comment_id),
                {
                    "entity_type": "INCIDENT_COMMENT",
                    "event_id": EVENT_ID,
                    "incident_id": "INC-001",
                    "comment_id": comment_id,
                    "body": body,
                    "author_id": author_id,
                    "author_name": author_name,
                    "author_type": author_type,
                    "author_role": "LEADER" if author_id == LEADER_SUB else "TEAM_MEMBER",
                    "team_id": "TEAM-tech",
                    "parent_comment_id": parent,
                    "attachment_document_id": None,
                    "created_task_id": "TSK-tc02" if comment_id == "CMT-004" else None,
                    "created_approval_id": None,
                    "created_at": created,
                    "updated_at": created,
                    "created_by": author_id,
                    "updated_by": author_id,
                    "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
                    "GSI1SK": keys.incident_comment_gsi1sk("INC-001", created),
                },
            )
        )

    for comment_id, body, hours in (
        (
            "CMT-010",
            "Twelve registrations have no payment reference. Listing them for manual "
            "reconciliation.",
            70,
        ),
        (
            "CMT-011",
            "Validation pattern fixed and deployed. Confirmed a UPI reference now saves correctly.",
            41,
        ),
    ):
        created = hours_ago(hours)
        items.append(
            (
                keys.incident_comment_sk(EVENT_ID, "INC-002", comment_id),
                {
                    "entity_type": "INCIDENT_COMMENT",
                    "event_id": EVENT_ID,
                    "incident_id": "INC-002",
                    "comment_id": comment_id,
                    "body": body,
                    "author_id": "member-kiran",
                    "author_name": "Kiran More",
                    "author_type": "user",
                    "author_role": "TEAM_MEMBER",
                    "team_id": "TEAM-registration",
                    "parent_comment_id": None,
                    "attachment_document_id": None,
                    "created_task_id": None,
                    "created_approval_id": None,
                    "created_at": created,
                    "updated_at": created,
                    "created_by": "member-kiran",
                    "updated_by": "member-kiran",
                    "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
                    "GSI1SK": keys.incident_comment_gsi1sk("INC-002", created),
                },
            )
        )

    created = hours_ago(18)
    items.append(
        (
            keys.incident_comment_sk(EVENT_ID, "INC-003", "CMT-020"),
            {
                "entity_type": "INCIDENT_COMMENT",
                "event_id": EVENT_ID,
                "incident_id": "INC-003",
                "comment_id": "CMT-020",
                "body": "Printer confirmed delivery for the day after. Still two days of slack.",
                "author_id": "member-ritu",
                "author_name": "Ritu Chavan",
                "author_type": "user",
                "author_role": "TEAM_MEMBER",
                "team_id": "TEAM-venue",
                "parent_comment_id": None,
                "attachment_document_id": None,
                "created_task_id": None,
                "created_approval_id": None,
                "created_at": created,
                "updated_at": created,
                "created_by": "member-ritu",
                "updated_by": "member-ritu",
                "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
                "GSI1SK": keys.incident_comment_gsi1sk("INC-003", created),
            },
        )
    )
    return items


def _approval_items() -> list[tuple[str, dict[str, Any]]]:
    """Eight approvals: five pending, one approved, one rejected, one edited.

    The pending set deliberately mixes financial and non-financial requests, because the
    approval centre has to be readable when the decisions are not all about money.

    APR-001 is the headline: 12,500 against 75,000 remaining, so approving it lands on exactly
    62,500 and the arithmetic is checkable by hand.
    """
    rows: list[dict[str, Any]] = [
        {
            "approval_id": "APR-001",
            "title": "Accommodation for Kavya Nair — 2 nights",
            "description": (
                "Kavya Nair is travelling from Kochi and needs two nights of accommodation. "
                "ACCOMMODATION has 25,000 allocated and nothing committed."
            ),
            "status": "PENDING",
            "requested_action": "AccommodationCommitment",
            "amount_inr": 12_500,
            "budget_category": "ACCOMMODATION",
            "reason": "Booking accommodation is a financial commitment on the organization's behalf.",
            "resource_type": "Speaker",
            "resource_id": "SPK-003",
            "agent_recommendation": (
                "Affordable: 75,000 uncommitted now, 62,500 after. Kavya has confirmed "
                "availability, so this is the remaining blocker on her session."
            ),
            "hours_ago": 30,
            "evidence": {
                "speaker_id": "SPK-003",
                "accommodation_nights": 2,
                "affordable": True,
                "remaining_before_inr": 75_000,
                "remaining_after_inr": 62_500,
            },
        },
        {
            "approval_id": "APR-002",
            "title": "Travel reimbursement for Suresh Rajan — Delhi",
            "description": (
                "Suresh Rajan's travel from Delhi is estimated at 18,000. SPEAKER_TRAVEL has "
                "6,000 uncommitted, so this needs a reallocation or a draw on EMERGENCY."
            ),
            "status": "PENDING",
            "requested_action": "FinancialCommitment",
            "amount_inr": 8_500,
            "budget_category": "SPEAKER_TRAVEL",
            "reason": "Travel reimbursement above the remaining category allocation.",
            "resource_type": "Speaker",
            "resource_id": "SPK-004",
            "agent_recommendation": (
                "The full 18,000 does not fit the 6,000 left in SPEAKER_TRAVEL. This request "
                "covers 8,500 as a partial reimbursement at the policy cap; the remainder needs "
                "either a reallocation from EMERGENCY or a conversation with the speaker."
            ),
            "evidence": {
                "speaker_id": "SPK-004",
                "estimated_travel_cost_inr": 18_000,
                "category_remaining_inr": 6_000,
                "policy_cap_applied": True,
            },
            # Raised 20 hours ago, i.e. inside the 24-hour staleness window, so exactly one
            # pending approval counts as an ageing decision rather than two.
            "hours_ago": 20,
        },
        {
            "approval_id": "APR-003",
            "title": "Replacement projector hire for the main hall",
            "description": (
                "Contingency against INC-001. The main hall projector has failed and the backup "
                "is untested."
            ),
            "status": "PENDING",
            "requested_action": "FinancialCommitment",
            "amount_inr": 7_000,
            "budget_category": "EQUIPMENT",
            "reason": "Equipment hire is a financial commitment and cannot be undone once booked.",
            "resource_type": "Incident",
            "resource_id": "INC-001",
            "agent_recommendation": (
                "EQUIPMENT has 2,000 uncommitted, so this needs 5,000 from EMERGENCY. Worth "
                "approving before the backup test so the hire can be arranged immediately if the "
                "test fails."
            ),
            "hours_ago": 4,
            "evidence": {
                "incident_id": "INC-001",
                "backup_tested": False,
                "category_remaining_inr": 2_000,
            },
        },
        {
            "approval_id": "APR-004",
            "title": "Send a third follow-up to Raj Malhotra",
            "description": (
                "Raj Malhotra has not responded for 96 hours. A follow-up is drafted and ready "
                "to send."
            ),
            "status": "PENDING",
            "requested_action": "SendExternalSpeakerMessage",
            "amount_inr": 0,
            "budget_category": "",
            "reason": "Messages leaving the organization are reviewed before they are sent.",
            "resource_type": "Speaker",
            "resource_id": "SPK-002",
            "agent_recommendation": (
                "Silent 96 hours against a 72-hour threshold. The draft asks for a yes or no "
                "rather than pressing, which keeps the option of a graceful decline open."
            ),
            "hours_ago": 2,
            "evidence": {"speaker_id": "SPK-002", "silent_hours": 96, "followup_count": 1},
        },
        {
            "approval_id": "APR-005",
            "title": "Add two volunteers to the registration desk",
            "description": (
                "Registration has two overdue tasks and three members. Two more volunteers on "
                "the desk would clear the backlog before the event."
            ),
            "status": "PENDING",
            "requested_action": "UpdateEventMetadata",
            "amount_inr": 0,
            "budget_category": "",
            "reason": "Changes to team composition are the leader's decision.",
            "resource_type": "Team",
            "resource_id": "TEAM-registration",
            "agent_recommendation": (
                "Registration carries the only two overdue tasks on the event and has the "
                "highest work-per-member ratio of the eight teams."
            ),
            "hours_ago": 8,
            "evidence": {
                "team_id": "TEAM-registration",
                "overdue_tasks": 2,
                "member_count": 3,
            },
        },
        {
            "approval_id": "APR-006",
            "title": "Increase the catering headcount to 320",
            "description": (
                "Registrations are tracking above the original 300 estimate. The vendor needs a "
                "final headcount."
            ),
            "status": "APPROVED",
            "requested_action": "FinancialCommitment",
            "amount_inr": 20_000,
            "budget_category": "CATERING",
            "reason": "Catering is charged per head and the deadline is fixed.",
            "resource_type": "Budget",
            "resource_id": EVENT_ID,
            "agent_recommendation": "Registrations support the increase. Within allocation.",
            "hours_ago": 50,
            "decided_hours_ago": 48,
            "decision": "APPROVED",
            "decision_notes": "Approved — registrations justify the increase.",
            "evidence": {"registered": 286, "previous_headcount": 300, "new_headcount": 320},
        },
        {
            "approval_id": "APR-007",
            "title": "Emergency transport standby vehicle",
            "description": "A standby vehicle on site for the full day, in case of an emergency.",
            "status": "DECLINED",
            "requested_action": "FinancialCommitment",
            "amount_inr": 4_500,
            "budget_category": "TRANSPORTATION",
            "reason": "Contingency transport request.",
            "resource_type": "Budget",
            "resource_id": EVENT_ID,
            "agent_recommendation": "Affordable, but the venue is eight minutes from a hospital.",
            "hours_ago": 60,
            "decided_hours_ago": 58,
            "decision": "DECLINED",
            "decision_notes": (
                "Declined — the venue is close to a hospital and has its own ambulance "
                "arrangement. Keeping the EMERGENCY allocation intact instead."
            ),
            "evidence": {"venue_distance_to_hospital_km": 3},
        },
        {
            "approval_id": "APR-008",
            "title": "Move the closing panel forward by 30 minutes",
            "description": (
                "Two speakers have onward travel. Moving the closing panel earlier gives them "
                "margin."
            ),
            "status": "EDITED",
            "requested_action": "ModifyPublishedEvent",
            "amount_inr": 0,
            "budget_category": "",
            "reason": "The agenda is published, so a change has to be announced.",
            "resource_type": "Event",
            "resource_id": EVENT_ID,
            "agent_recommendation": "Two speakers have flights within three hours of the close.",
            "hours_ago": 36,
            "decided_hours_ago": 34,
            "decision": "EDITED",
            "decision_notes": (
                "Moved by 20 minutes rather than 30, so the hallway track is not cut short."
            ),
            "edited_action": "Move the closing panel forward by 20 minutes.",
            "evidence": {"affected_speakers": ["SPK-001", "SPK-004"]},
        },
    ]

    items: list[tuple[str, dict[str, Any]]] = []
    for row in rows:
        requested_at = hours_ago(row["hours_ago"])
        status = row["status"]
        record = {
            "entity_type": "APPROVAL",
            "event_id": EVENT_ID,
            "approval_id": row["approval_id"],
            "title": row["title"],
            "description": row["description"],
            "status": status,
            "risk_level": "HIGH" if row["amount_inr"] else "MEDIUM",
            "requested_action": row["requested_action"],
            "reason": row["reason"],
            "evidence": row["evidence"],
            "affected_resource_type": row["resource_type"],
            "affected_resource_id": row["resource_id"],
            "amount_inr": row["amount_inr"],
            "currency": "INR",
            "budget_category": row["budget_category"],
            "budget_impact": (
                f"Remaining 75,000 -> {75_000 - row['amount_inr']:,}"
                if row["amount_inr"] and status == "PENDING"
                else ""
            ),
            "requested_by": "CommunityOps",
            "requested_by_name": "CommunityOps Agent",
            "requested_by_role": "LEADER",
            "agent_name": "CommunityOps",
            "agent_recommendation": row["agent_recommendation"],
            "tool_name": "",
            "requested_at": requested_at,
            "created_at": requested_at,
            "updated_at": requested_at,
            "created_by": "CommunityOps",
            "updated_by": "CommunityOps",
            "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
            # The index sort key carries the decided status, exactly as the decision path
            # rewrites it. Seeding a PENDING key on a decided approval would reproduce the bug
            # the rewrite exists to fix.
            "GSI1SK": keys.approval_gsi1sk(status, requested_at),
        }
        if "decided_hours_ago" in row:
            record["decided_by"] = LEADER_SUB
            record["decided_at"] = hours_ago(row["decided_hours_ago"])
            record["decision_notes"] = row["decision_notes"]
            if row.get("edited_action"):
                record["edited_action"] = row["edited_action"]
        items.append((keys.approval_sk(EVENT_ID, row["approval_id"]), record))
    return items


# The named registrations the demo walks through by hand. Each carries a specific situation the
# ticket admin screen and the verification flow need: a clean one, a cancelled refund, a pending
# payment, a free ticket, a waitlist entry.
#
# name, status, payment, has_dietary, accommodation, arrival_confirmed, checked_in
NAMED_ATTENDEES: list[tuple[str, str, str, bool, bool, bool, bool]] = [
    ("Priya Kulkarni", "CONFIRMED", "CAPTURED", True, False, True, True),
    ("Arjun Deshpande", "CONFIRMED", "CAPTURED", True, False, True, True),
    ("Deepika Rao", "CONFIRMED", "CAPTURED", True, True, True, False),
    ("Vikram Singh", "CONFIRMED", "NOT_REQUIRED", True, False, True, False),
    ("Neha Gupta", "CANCELLED", "REFUNDED", False, False, False, False),
    ("Sanjay Mehta", "CONFIRMED", "CAPTURED", True, False, True, False),
    ("Ritika Bansal", "CONFIRMED", "CAPTURED", True, True, True, False),
    ("Karan Malhotra", "WAITLISTED", "PENDING", False, False, False, False),
    ("Ananya Reddy", "CONFIRMED", "CAPTURED", True, False, True, False),
    ("Faisal Khan", "CONFIRMED", "CAPTURED", False, False, False, False),
    ("Meghana Shetty", "CONFIRMED", "CAPTURED", True, True, True, False),
    ("Tushar Jain", "CONFIRMED", "PENDING", False, False, False, False),
    ("Lakshmi Iyer", "CONFIRMED", "CAPTURED", True, False, True, False),
    ("Nikhil Verma", "CONFIRMED", "CAPTURED", True, False, False, False),
    ("Shreya Pillai", "CONFIRMED", "CAPTURED", True, False, True, False),
    ("Rahul Bose", "CONFIRMED", "CAPTURED", True, True, True, False),
    ("Divya Menon", "CONFIRMED", "CAPTURED", True, False, True, False),
    ("Aakash Tiwari", "CONFIRMED", "CAPTURED", True, False, True, False),
]

# Total registrations. A community day of this size genuinely registers a few hundred people, and
# the count matters to the numbers the agent reports: 8 of 18 missing dietary details is a 44%
# data gap and a health emergency, while 22 of 286 is an 8% gap and an ordinary Tuesday. Seeding
# only the named handful would have overstated the problem purely as an artifact of sample size.
#
# Overridable so tests can seed a smaller population. Each registration writes up to three items
# (registration, payment, attendee detail), so the full set is ~860 of the ~960 records and
# dominates the runtime of every test that needs a seeded table. The proportions above are ratios
# rather than counts, so a smaller population produces the same percentages and therefore the same
# health signals.
TOTAL_REGISTRATIONS = int(os.environ.get("SEED_TOTAL_REGISTRATIONS", "286"))

# Surnames and given names combined to generate the bulk population. Entirely invented.
_GIVEN_NAMES = [
    "Aarav",
    "Isha",
    "Rohit",
    "Sanya",
    "Kabir",
    "Tara",
    "Dev",
    "Mira",
    "Yash",
    "Aditi",
    "Omkar",
    "Nisha",
    "Varun",
    "Rhea",
    "Siddharth",
    "Juhi",
    "Harsh",
    "Pallavi",
    "Girish",
    "Sonal",
    "Mahesh",
    "Ira",
    "Prateek",
    "Swara",
    "Nilesh",
    "Gauri",
    "Ajinkya",
    "Radha",
]
_SURNAMES = [
    "Deshmukh",
    "Kulkarni",
    "Joshi",
    "Patil",
    "Shinde",
    "Pawar",
    "Jadhav",
    "Kale",
    "Bhosale",
    "Sawant",
    "Chavan",
    "More",
    "Gaikwad",
    "Shirke",
    "Naik",
    "Ranade",
]


def _generated_attendees() -> list[tuple[str, str, str, bool, bool, bool, bool]]:
    """Generate the bulk registration population deterministically.

    Modular arithmetic rather than randomness, so re-seeding produces byte-identical data and the
    demo numbers do not move between runs. The proportions are chosen to be realistic:
    roughly 8% missing dietary details, 15% needing accommodation, a handful cancelled and
    waitlisted, and about 4% already checked in.
    """
    rows: list[tuple[str, str, str, bool, bool, bool, bool]] = []
    remaining = TOTAL_REGISTRATIONS - len(NAMED_ATTENDEES)
    for i in range(remaining):
        given = _GIVEN_NAMES[i % len(_GIVEN_NAMES)]
        surname = _SURNAMES[(i // len(_GIVEN_NAMES)) % len(_SURNAMES)]
        name = f"{given} {surname}"

        if i % 47 == 0:
            status, payment = "CANCELLED", "REFUNDED"
        elif i % 31 == 0:
            status, payment = "WAITLISTED", "PENDING"
        elif i % 23 == 0:
            status, payment = "CONFIRMED", "NOT_REQUIRED"
        else:
            status, payment = "CONFIRMED", "CAPTURED"

        rows.append(
            (
                name,
                status,
                payment,
                # Roughly 4% missing dietary details and 5% with arrival unconfirmed, which
                # together leave data completeness around 92%. Deliberately below the 10%
                # threshold the health engine treats as a risk: the attendee operations screen
                # still shows the real gaps to chase, but they are an ordinary backlog rather
                # than an emergency. Seeding worse data would make the demo event RED and leave
                # no headroom before a passing deadline tipped it over.
                i % 25 != 0,
                i % 7 == 0,  # ~14% need accommodation
                i % 20 != 0,
                i % 25 == 0,  # ~4% already checked in
            )
        )
    return rows


def _attendee_items() -> list[tuple[str, dict[str, Any]]]:
    """Registrations with attendee detail, some check-ins, and issued tickets.

    A population with real but proportionate gaps. The named entries at the front are the ones
    the demo walks through by hand; the rest give the aggregate numbers something honest to
    report.
    """
    items: list[tuple[str, dict[str, Any]]] = []
    people = NAMED_ATTENDEES + _generated_attendees()

    for index, (
        name,
        status,
        payment_status,
        has_dietary,
        accommodation,
        arrival_confirmed,
        checked_in,
    ) in enumerate(people, start=1):
        registration_id = f"REG-2026-{4800 + index:06d}"
        email = name.lower().replace(" ", ".") + "@example.com"
        transaction_id = f"TXN-ACD-{7000 + index}"
        # Registrations arrive across the open period rather than all at once. Clamped so a large
        # population cannot walk the earliest dates past the present and produce future signups.
        created = days_ago(max(1.0, 35 - index * 0.12))

        items.append(
            (
                keys.registration_sk(EVENT_ID, registration_id),
                {
                    "entity_type": "REGISTRATION",
                    "event_id": EVENT_ID,
                    "registration_id": registration_id,
                    "attendee_name": name,
                    # Lowercase shadow attribute, which is what the name-search connector
                    # filters on.
                    "attendee_name_lower": name.lower(),
                    "attendee_email": email,
                    "attendee_phone": f"+9198765{43000 + index}",
                    "status": status,
                    "payment_status": payment_status,
                    "payment_reference": (
                        transaction_id if payment_status in ("CAPTURED", "REFUNDED") else ""
                    ),
                    "ticket_type": "GENERAL" if index % 5 else "STUDENT",
                    "is_checked_in": checked_in,
                    "created_at": created,
                    "updated_at": created,
                    "created_by": "registration-form",
                    "updated_by": "registration-form",
                    "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
                    "GSI1SK": f"EMAIL#{email}",
                },
            )
        )

        if payment_status in ("CAPTURED", "REFUNDED"):
            items.append(
                (
                    keys.payment_sk(EVENT_ID, transaction_id),
                    {
                        "entity_type": "PAYMENT",
                        "event_id": EVENT_ID,
                        "transaction_id": transaction_id,
                        "registration_id": registration_id,
                        "amount": "500" if index % 5 else "250",
                        "currency": "INR",
                        "status": payment_status,
                        "payment_method": "UPI" if index % 2 else "CARD",
                        "payer_email": email,
                        "payer_name": name,
                        "created_at": created,
                        "updated_at": created,
                        "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
                        "GSI1SK": f"TXN#{transaction_id}",
                    },
                )
            )

        # Attendee detail exists only for some registrations. The rest are genuine data gaps,
        # which is what the completeness signal measures.
        if status != "CANCELLED" and (has_dietary or accommodation or arrival_confirmed):
            missing = []
            if not has_dietary:
                missing.append("dietary_requirements")
            if not arrival_confirmed:
                missing.append("arrival_confirmation")
            items.append(
                (
                    keys.attendee_sk(EVENT_ID, registration_id),
                    {
                        "entity_type": "ATTENDEE",
                        "event_id": EVENT_ID,
                        "registration_id": registration_id,
                        "attendee_name": name,
                        "attendee_email": email,
                        "dietary_requirements": (
                            "Vegetarian"
                            if has_dietary and index % 3
                            else "Jain"
                            if has_dietary and index % 5 == 0
                            else "No restrictions"
                            if has_dietary
                            else ""
                        ),
                        "dietary_confirmed": has_dietary,
                        "accommodation_required": accommodation,
                        "accommodation_details": "2 nights" if accommodation else "",
                        "accessibility_requirements": "",
                        "arrival_date": in_days(20.5) if arrival_confirmed else "",
                        "arrival_confirmed": arrival_confirmed,
                        "special_assistance": "",
                        "info_request_sent": True,
                        "info_request_responded": has_dietary,
                        "missing_fields": missing,
                        "tags": [],
                        "created_at": created,
                        "updated_at": created,
                        "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
                        "GSI1SK": f"ATTENDEE#{registration_id}",
                    },
                )
            )

        if checked_in:
            items.append(
                (
                    keys.checkin_sk(EVENT_ID, registration_id),
                    {
                        "entity_type": "CHECKIN",
                        "event_id": EVENT_ID,
                        "registration_id": registration_id,
                        "attendee_name": name,
                        "status": "CHECKED_IN",
                        "checked_in_at": hours_ago(2),
                        "checked_in_by": PUBLIC_DEMO_SUB,
                        "method": "QR_SCAN",
                        "created_at": hours_ago(2),
                        "updated_at": hours_ago(2),
                        "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
                        "GSI1SK": f"CHECKIN#{hours_ago(2)}",
                    },
                )
            )

        # Tickets for the first six confirmed, paid registrations, so the ticket admin screen
        # has both issued and not-yet-issued rows to work with.
        if index <= 6 and status == "CONFIRMED" and payment_status in ("CAPTURED", "NOT_REQUIRED"):
            items.append(
                (
                    keys.ticket_sk(EVENT_ID, registration_id),
                    {
                        "entity_type": "TICKET",
                        "event_id": EVENT_ID,
                        # The business rule, visible in the data: ticket identity is
                        # registration identity.
                        "ticket_id": registration_id,
                        "registration_id": registration_id,
                        "attendee_name": name,
                        "attendee_email": email,
                        "status": "ACTIVE",
                        "s3_key": f"{ORG_ID}/{EVENT_ID}/tickets/{registration_id}.pdf",
                        # A placeholder rather than a real HMAC: the signing secret is per
                        # deployment, so a seeded signature would verify nowhere. Regenerate a
                        # ticket through the API to get a genuinely signed one.
                        "qr_signature": "demo-placeholder-not-a-valid-signature",
                        "qr_payload": "",
                        "generated_count": 2 if index == 1 else 1,
                        "issued_by": LEADER_SUB,
                        "is_demo_placeholder": True,
                        "created_at": days_ago(5),
                        "updated_at": days_ago(5),
                        "GSI1PK": keys.event_gsi1pk(ORG_ID, EVENT_ID),
                        "GSI1SK": f"TICKET#{registration_id}",
                    },
                )
            )

    return items


def _notification_items() -> list[tuple[str, dict[str, Any]]]:
    """Notifications for the three demo logins, so each inbox has something in it."""
    rows: list[tuple[str, str, str, str, str, str, str, float, bool]] = [
        (
            "NTF-001",
            LEADER_SUB,
            "APPROVAL_REQUESTED",
            "ATTENTION",
            "Accommodation for Kavya Nair — 12,500",
            "Waiting on your decision. 75,000 remaining before this.",
            "Approval|APR-001",
            30,
            False,
        ),
        (
            "NTF-002",
            LEADER_SUB,
            "INCIDENT_REPORTED",
            "CRITICAL",
            "HIGH: Main hall projector failed during AV testing",
            f"Reported by {TEAM_NAME}",
            "Incident|INC-001",
            6,
            False,
        ),
        (
            "NTF-003",
            LEADER_SUB,
            "TASK_OVERDUE",
            "WARNING",
            "2 overdue tasks in Registration",
            "Payment reconciliation and ticket generation have both passed their deadlines.",
            "Task|TSK-rg02",
            4,
            False,
        ),
        (
            "NTF-004",
            LEADER_SUB,
            "AGENT_RECOMMENDATION",
            "ATTENTION",
            "Follow-up drafted for Raj Malhotra",
            "Silent 96 hours. A draft is ready for your review.",
            "Speaker|SPK-002",
            2,
            False,
        ),
        (
            "NTF-005",
            LEADER_SUB,
            "BUDGET_WARNING",
            "WARNING",
            "Budget 70% utilized",
            "75,000 of 2,50,000 remains for this event.",
            "Budget|" + EVENT_ID,
            6,
            True,
        ),
        (
            "NTF-006",
            TEAM_SUB,
            "TASK_ASSIGNED",
            "INFO",
            "Assigned to you: Test main hall projector",
            "Blocked on the open projector incident.",
            "Task|TSK-tc02",
            6,
            False,
        ),
        (
            "NTF-007",
            TEAM_SUB,
            "INCIDENT_UPDATED",
            "INFO",
            "New comment on Main hall projector failed during AV testing",
            "CommunityOps Agent posted an impact analysis.",
            "Incident|INC-001",
            4.5,
            False,
        ),
        (
            "NTF-008",
            PUBLIC_DEMO_SUB,
            "TASK_ASSIGNED",
            "INFO",
            "Assigned to you: Prepare backup laptop and adapters",
            "Due before the event.",
            "Task|TSK-tc04",
            20,
            False,
        ),
        (
            "NTF-009",
            PUBLIC_DEMO_SUB,
            "INCIDENT_REPORTED",
            "WARNING",
            "HIGH: Main hall projector failed during AV testing",
            "Your team is handling this.",
            "Incident|INC-001",
            6,
            True,
        ),
    ]

    items: list[tuple[str, dict[str, Any]]] = []
    for (
        notification_id,
        user_id,
        notification_type,
        severity,
        title,
        body,
        target,
        hours,
        is_read,
    ) in rows:
        resource_type, _, resource_id = target.partition("|")
        created = hours_ago(hours)
        items.append(
            (
                keys.notification_sk(user_id, notification_id),
                {
                    "entity_type": "NOTIFICATION",
                    "notification_id": notification_id,
                    "user_id": user_id,
                    "event_id": EVENT_ID,
                    "type": notification_type,
                    "severity": severity,
                    "title": title,
                    "body": body,
                    "resource_type": resource_type,
                    "resource_id": resource_id,
                    "is_read": is_read,
                    "read_at": hours_ago(hours - 1) if is_read else None,
                    "created_at": created,
                    "updated_at": created,
                    "created_by": "system",
                    "updated_by": "system",
                    "GSI2PK": keys.user_gsi2pk(ORG_ID, user_id),
                    "GSI2SK": f"NOTIF#{created}",
                },
            )
        )
    return items


def build_audit_items() -> list[tuple[str, dict[str, Any]]]:
    """Audit history, so the activity feed and audit log are populated from the start.

    Written to the audit table. Includes a refused agent tool call, because a trail that only
    contains successes hides exactly the events worth reviewing.
    """
    rows: list[tuple[str, str, str, str, str, str, float, str, str]] = [
        (
            "AUD-d001",
            "EVENT_CREATED",
            "user",
            LEADER_SUB,
            "Event",
            EVENT_ID,
            60 * 24,
            "success",
            "",
        ),
        (
            "AUD-d002",
            "EVENT_PLAN_GENERATED",
            "agent",
            "CommunityOps",
            "Event",
            EVENT_ID,
            58 * 24,
            "success",
            "CreateInternalTask",
        ),
        (
            "AUD-d003",
            "BUDGET_TOTAL_SET",
            "user",
            LEADER_SUB,
            "Budget",
            EVENT_ID,
            55 * 24,
            "success",
            "AllocateBudget",
        ),
        (
            "AUD-d004",
            "BUDGET_ALLOCATED",
            "user",
            LEADER_SUB,
            "BudgetAllocation",
            "VENUE",
            55 * 24,
            "success",
            "AllocateBudget",
        ),
        (
            "AUD-d005",
            "SPEAKER_CREATED",
            "user",
            "member-sneha",
            "Speaker",
            "SPK-001",
            30 * 24,
            "success",
            "",
        ),
        (
            "AUD-d006",
            "AGENT_PREPARE_SPEAKER_FOLLOWUP",
            "agent",
            "CommunityOps",
            "Speaker",
            "SPK-002",
            2,
            "success",
            "GenerateDraft",
        ),
        (
            "AUD-d007",
            "APPROVAL_REQUESTED",
            "agent",
            "CommunityOps",
            "Approval",
            "APR-001",
            30,
            "pending",
            "AccommodationCommitment",
        ),
        (
            "AUD-d008",
            "APPROVAL_APPROVED",
            "user",
            LEADER_SUB,
            "Approval",
            "APR-006",
            48,
            "success",
            "DecideApproval",
        ),
        ("AUD-d009", "BUDGET_COMMITTED", "user", LEADER_SUB, "Budget", EVENT_ID, 48, "success", ""),
        (
            "AUD-d010",
            "APPROVAL_DECLINED",
            "user",
            LEADER_SUB,
            "Approval",
            "APR-007",
            58,
            "success",
            "DecideApproval",
        ),
        (
            "AUD-d011",
            "INCIDENT_REPORTED",
            "user",
            TEAM_SUB,
            "Incident",
            "INC-001",
            6,
            "success",
            "",
        ),
        (
            "AUD-d012",
            "AGENT_ADD_INCIDENT_COMMENT",
            "agent",
            "CommunityOps",
            "IncidentComment",
            "CMT-004",
            4.5,
            "success",
            "AddIncidentComment",
        ),
        (
            "AUD-d013",
            "AGENT_CREATE_TASK",
            "agent",
            "CommunityOps",
            "Task",
            "TSK-tc02",
            4.5,
            "success",
            "CreateInternalTask",
        ),
        (
            "AUD-d014",
            "INCIDENT_RESOLVED",
            "user",
            LEADER_SUB,
            "Incident",
            "INC-002",
            40,
            "success",
            "ResolveIncident",
        ),
        (
            "AUD-d015",
            "TASK_UPDATED",
            "user",
            "member-kiran",
            "Task",
            "TSK-rg02",
            5,
            "success",
            "UpdateTask",
        ),
        (
            "AUD-d016",
            "AGENT_TOOL_REFUSED",
            "agent",
            PUBLIC_DEMO_SUB,
            "AgentTool",
            "record_expense",
            3,
            "failure",
            "RecordExpense",
        ),
        (
            "AUD-d017",
            "TICKET_ISSUED",
            "user",
            LEADER_SUB,
            "Ticket",
            "REG-2026-004801",
            5 * 24,
            "success",
            "GenerateTicket",
        ),
        (
            "AUD-d018",
            "CHECKIN_COMPLETED",
            "user",
            PUBLIC_DEMO_SUB,
            "CheckIn",
            "REG-2026-004801",
            2,
            "success",
            "CompleteCheckIn",
        ),
        (
            "AUD-d019",
            "AGENT_CHAT_TURN",
            "agent",
            LEADER_SUB,
            "ChatSession",
            "demo-session",
            1,
            "success",
            "",
        ),
        (
            "AUD-d020",
            "TRANSACTION_VERIFIED",
            "user",
            LEADER_SUB,
            "Registration",
            "REG-2026-004803",
            6,
            "success",
            "",
        ),
    ]

    items: list[tuple[str, dict[str, Any]]] = []
    for (
        audit_id,
        action,
        actor_type,
        actor_id,
        resource_type,
        resource_id,
        hours,
        outcome,
        policy,
    ) in rows:
        timestamp = hours_ago(hours)
        items.append(
            (
                keys.audit_sk(timestamp, audit_id),
                {
                    "audit_id": audit_id,
                    "organization_id": ORG_ID,
                    "event_id": EVENT_ID,
                    "timestamp": timestamp,
                    "action": action,
                    "actor_type": actor_type,
                    "actor_id": actor_id,
                    "resource_type": resource_type,
                    "resource_id": resource_id,
                    "details": {"seeded": True},
                    "tool_used": resource_id if action.startswith("AGENT_") else None,
                    "policy_evaluated": policy or None,
                    "approval_id": resource_id if resource_type == "Approval" else None,
                    "outcome": outcome,
                    "GSI1PK": keys.audit_gsi1pk(ORG_ID, EVENT_ID),
                    "GSI1SK": f"{action}#{timestamp}",
                },
            )
        )
    return items


def _rewrite_subjects(value: Any) -> Any:
    """Replace placeholder subjects with real Cognito subjects, recursively.

    Applied to sort keys and to every attribute value, because subjects appear in both: a
    ``TeamMember`` sort key embeds the user id, and so does a notification's. Exact-match
    replacement rather than substring, so a display name that happens to contain a placeholder
    is left alone.
    """
    if not SUBJECT_OVERRIDES:
        return value
    if isinstance(value, str):
        for placeholder, real in SUBJECT_OVERRIDES.items():
            if value == placeholder:
                return real
            # Subjects are embedded in composite keys such as
            # EVENT#...#TEAM#...#MEMBER#{sub} and ORG-x#USER#{sub}, so those need substring
            # replacement. Guarded by the separator so a partial id cannot match.
            if placeholder in value and ("#" in value or value.endswith(placeholder)):
                value = value.replace(placeholder, real)
        return value
    if isinstance(value, dict):
        return {k: _rewrite_subjects(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_rewrite_subjects(v) for v in value]
    return value


def seed(table_name: str, audit_table_name: str, region: str) -> None:
    dynamodb = boto3.resource("dynamodb", region_name=region)

    items = [
        (_rewrite_subjects(sk), _rewrite_subjects(attributes)) for sk, attributes in build_items()
    ]
    table = dynamodb.Table(table_name)
    with table.batch_writer() as batch:
        for sk, attributes in items:
            batch.put_item(Item={"PK": ORG_ID, "SK": sk, **attributes})

    audit_items = [
        (_rewrite_subjects(sk), _rewrite_subjects(attributes))
        for sk, attributes in build_audit_items()
    ]
    audit_table = dynamodb.Table(audit_table_name)
    with audit_table.batch_writer() as batch:
        for sk, attributes in audit_items:
            batch.put_item(Item={"PK": ORG_ID, "SK": sk, **attributes})

    counts: dict[str, int] = {}
    for _, attributes in items:
        counts[str(attributes.get("entity_type", "OTHER"))] = (
            counts.get(str(attributes.get("entity_type", "OTHER")), 0) + 1
        )

    print(f"Seeded {len(items)} records to {table_name}")  # noqa: T201
    print(f"Seeded {len(audit_items)} audit records to {audit_table_name}")  # noqa: T201
    print()  # noqa: T201
    print(f"  Organization : {ORG_ID}")  # noqa: T201
    print(f"  Event        : {EVENT_ID} — {EVENT_NAME}")  # noqa: T201
    print(f"  Starts       : {EVENT_START.date()} (in 21 days)")  # noqa: T201
    print()  # noqa: T201
    for entity_type in sorted(counts):
        print(f"  {entity_type:<20} {counts[entity_type]}")  # noqa: T201
    print()  # noqa: T201
    print("  Budget")  # noqa: T201
    print(f"    Total      {TOTAL_BUDGET:,}")  # noqa: T201
    print(f"    Allocated  {ALLOCATED:,}")  # noqa: T201
    print(f"    Spent      {SPENT:,}")  # noqa: T201
    print(f"    Committed  {COMMITTED:,}")  # noqa: T201
    print(f"    Remaining  {TOTAL_BUDGET - SPENT - COMMITTED:,}")  # noqa: T201
    print(  # noqa: T201
        f"    Utilization {round((SPENT + COMMITTED) * 100 / TOTAL_BUDGET)}%"
    )
    print()  # noqa: T201
    print("  Approving APR-001 (12,500) should leave exactly 62,500 remaining.")  # noqa: T201
    print("  Event health is computed on first read; this state produces ORANGE.")  # noqa: T201


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed the CommunityOps demo event")
    parser.add_argument("--table", default="CommunityOps-Main-dev", help="Main table name")
    parser.add_argument("--audit-table", default="", help="Audit table name")
    parser.add_argument("--region", default="ap-south-1", help="AWS region")
    parser.add_argument(
        "--leader-sub",
        default="",
        help="Cognito subject of the demo leader, so their records bind to the real login.",
    )
    parser.add_argument("--team-sub", default="", help="Cognito subject of the demo team member.")
    parser.add_argument(
        "--demo-sub", default="", help="Cognito subject of the public demo volunteer."
    )
    args = parser.parse_args()

    if args.leader_sub:
        SUBJECT_OVERRIDES[LEADER_SUB] = args.leader_sub
    if args.team_sub:
        SUBJECT_OVERRIDES[TEAM_SUB] = args.team_sub
    if args.demo_sub:
        SUBJECT_OVERRIDES[PUBLIC_DEMO_SUB] = args.demo_sub
    if SUBJECT_OVERRIDES:
        print(  # noqa: T201
            f"Binding {len(SUBJECT_OVERRIDES)} demo identities to real Cognito subjects."
        )

    audit_table = args.audit_table or args.table.replace("-Main-", "-Audit-")
    seed(args.table, audit_table, args.region)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
