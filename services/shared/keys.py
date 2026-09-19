"""Single-table key construction.

Every sort key in CommunityOps was previously built inline at each call site, which
meant the same string format was repeated in handlers, workflows, connectors and the
seed script. A typo in one of them produces an item nothing can ever read back, and the
mistake is invisible until a query silently returns nothing.

This module is the one place those strings are defined. The existing formats are
reproduced exactly so already-stored items remain readable.

Layout
------
``PK``  is always the ``organization_id`` — the tenant boundary and the partition key.

``SK``  is a hierarchical path. Event-scoped records start ``EVENT#{eventId}#``.
        Per-user records start ``USER#{userId}#`` so a user's own data (notifications,
        chat) is a single partition query and never appears in the ``EVENT#`` prefix
        scans used to list events.

``GSI1`` answers "everything for this event, of this kind, newest last":
        ``GSI1PK = {org}#{eventId}``, ``GSI1SK = {KIND}#{...}``.

``GSI2`` answers status- and deadline-ordered queries, and "everything for this user
        across events": ``GSI2PK`` is either ``{org}#{eventId}#{KIND}`` or
        ``{org}#USER#{userId}``.

Status in a sort key
--------------------
``GSI1SK`` embeds a status for several entity kinds. That is only correct if the key is
rewritten whenever the status changes, so the helpers that build those keys take the
status explicitly and the update paths call them again on transition. Volatile state
such as overdue-ness is deliberately never encoded here; it is derived at read time.
"""

from __future__ import annotations

GSI1_INDEX = "GSI1"
GSI2_INDEX = "GSI2"


# ---------------------------------------------------------------------------
# Organization and event
# ---------------------------------------------------------------------------


def organization_sk(organization_id: str) -> str:
    return f"ORG#{organization_id}"


def event_sk(event_id: str) -> str:
    return f"EVENT#{event_id}"


def event_prefix(event_id: str) -> str:
    """Prefix matching every record belonging to one event."""
    return f"EVENT#{event_id}#"


def all_events_prefix() -> str:
    """Prefix for listing events.

    This also matches every event-scoped child record, so callers must filter on
    ``entity_type == "EVENT"``. That is why ``entity_type`` is mandatory on every item.
    """
    return "EVENT#"


def events_gsi1pk(organization_id: str) -> str:
    return f"{organization_id}#EVENTS"


def event_gsi1pk(organization_id: str, event_id: str) -> str:
    """Partition holding every child record of one event, for GSI1 queries."""
    return f"{organization_id}#{event_id}"


def event_status_gsi1sk(status: str, timestamp: str) -> str:
    return f"STATUS#{status}#{timestamp}"


# ---------------------------------------------------------------------------
# Registration, payment, ticket, check-in
# ---------------------------------------------------------------------------


def registration_sk(event_id: str, registration_id: str) -> str:
    return f"EVENT#{event_id}#REG#{registration_id}"


def registration_prefix(event_id: str) -> str:
    return f"EVENT#{event_id}#REG#"


def payment_sk(event_id: str, transaction_id: str) -> str:
    return f"EVENT#{event_id}#PAYMENT#{transaction_id}"


def ticket_sk(event_id: str, registration_id: str) -> str:
    """Ticket key. ``ticket_id == registration_id`` is a business rule, not a shortcut."""
    return f"EVENT#{event_id}#TICKET#{registration_id}"


def ticket_prefix(event_id: str) -> str:
    return f"EVENT#{event_id}#TICKET#"


def checkin_sk(event_id: str, registration_id: str) -> str:
    return f"EVENT#{event_id}#CHECKIN#{registration_id}"


def checkin_prefix(event_id: str) -> str:
    return f"EVENT#{event_id}#CHECKIN#"


def attendee_sk(event_id: str, registration_id: str) -> str:
    return f"EVENT#{event_id}#ATTENDEE#{registration_id}"


def attendee_prefix(event_id: str) -> str:
    return f"EVENT#{event_id}#ATTENDEE#"


def recovery_case_sk(event_id: str, case_id: str) -> str:
    return f"EVENT#{event_id}#RECOVERY#{case_id}"


# ---------------------------------------------------------------------------
# Speaker
# ---------------------------------------------------------------------------


def speaker_sk(event_id: str, speaker_id: str) -> str:
    return f"EVENT#{event_id}#SPEAKER#{speaker_id}"


def speaker_prefix(event_id: str) -> str:
    return f"EVENT#{event_id}#SPEAKER#"


def speaker_gsi1sk(status: str, timestamp: str) -> str:
    return f"SPEAKER#{status}#{timestamp}"


# ---------------------------------------------------------------------------
# Team, membership, task
# ---------------------------------------------------------------------------


def team_sk(event_id: str, team_id: str) -> str:
    return f"EVENT#{event_id}#TEAM#{team_id}"


def team_prefix(event_id: str) -> str:
    """Matches teams and, because tasks nest under teams, their tasks too.

    Filter on ``entity_type == "TEAM"`` when only teams are wanted.
    """
    return f"EVENT#{event_id}#TEAM#"


def team_member_sk(event_id: str, team_id: str, user_id: str) -> str:
    return f"EVENT#{event_id}#TEAM#{team_id}#MEMBER#{user_id}"


def team_member_prefix(event_id: str, team_id: str) -> str:
    return f"EVENT#{event_id}#TEAM#{team_id}#MEMBER#"


def team_member_gsi1sk(team_id: str, user_id: str) -> str:
    return f"MEMBER#{team_id}#{user_id}"


def user_gsi2pk(organization_id: str, user_id: str) -> str:
    """Partition holding one user's cross-event records."""
    return f"{organization_id}#USER#{user_id}"


def team_member_gsi2sk(event_id: str, team_id: str) -> str:
    return f"MEMBER#{event_id}#{team_id}"


def task_sk(event_id: str, team_id: str, task_id: str) -> str:
    return f"EVENT#{event_id}#TEAM#{team_id}#TASK#{task_id}"


def task_prefix(event_id: str, team_id: str) -> str:
    return f"EVENT#{event_id}#TEAM#{team_id}#TASK#"


def task_gsi1sk(status: str, timestamp: str) -> str:
    return f"TASK#{status}#{timestamp}"


def task_gsi2pk(organization_id: str, event_id: str) -> str:
    return f"{organization_id}#{event_id}#TASK"


def task_gsi2sk(status: str, due_date: str, task_id: str) -> str:
    """Status then deadline, so "open work, soonest first" is one query.

    ``due_date`` may be empty for undated work; the empty string sorts before any ISO
    timestamp, which would put undated tasks first. ``~`` sorts after every digit, so
    undated tasks fall to the end of their status group where they belong.
    """
    return f"{status}#{due_date or '~'}#{task_id}"


# ---------------------------------------------------------------------------
# Incident and discussion
# ---------------------------------------------------------------------------


def incident_sk(event_id: str, incident_id: str) -> str:
    return f"EVENT#{event_id}#INCIDENT#{incident_id}"


def incident_prefix(event_id: str) -> str:
    """Matches incidents and their comments; filter on ``entity_type``."""
    return f"EVENT#{event_id}#INCIDENT#"


def incident_gsi1sk(status: str, timestamp: str) -> str:
    return f"INCIDENT#{status}#{timestamp}"


def incident_comment_sk(event_id: str, incident_id: str, comment_id: str) -> str:
    return f"EVENT#{event_id}#INCIDENT#{incident_id}#COMMENT#{comment_id}"


def incident_comment_prefix(event_id: str, incident_id: str) -> str:
    return f"EVENT#{event_id}#INCIDENT#{incident_id}#COMMENT#"


def incident_comment_gsi1sk(incident_id: str, timestamp: str) -> str:
    return f"COMMENT#{incident_id}#{timestamp}"


# ---------------------------------------------------------------------------
# Approval
# ---------------------------------------------------------------------------


def approval_sk(event_id: str, approval_id: str) -> str:
    return f"EVENT#{event_id}#APPROVAL#{approval_id}"


def approval_prefix(event_id: str) -> str:
    return f"EVENT#{event_id}#APPROVAL#"


def approval_gsi1sk(status: str, timestamp: str) -> str:
    """Must be rewritten on decision, or pending-only listings return decided items."""
    return f"APPROVAL#{status}#{timestamp}"


# ---------------------------------------------------------------------------
# Budget
# ---------------------------------------------------------------------------


def budget_sk(event_id: str) -> str:
    """One budget record per event, so no id segment is needed."""
    return f"EVENT#{event_id}#BUDGET"


def budget_allocation_sk(event_id: str, category: str) -> str:
    return f"EVENT#{event_id}#BUDGET#CATEGORY#{category}"


def budget_allocation_prefix(event_id: str) -> str:
    return f"EVENT#{event_id}#BUDGET#CATEGORY#"


def expense_sk(event_id: str, expense_id: str) -> str:
    return f"EVENT#{event_id}#EXPENSE#{expense_id}"


def expense_prefix(event_id: str) -> str:
    return f"EVENT#{event_id}#EXPENSE#"


def expense_gsi1sk(timestamp: str) -> str:
    return f"EXPENSE#{timestamp}"


# ---------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------


def document_sk(event_id: str, document_id: str) -> str:
    return f"EVENT#{event_id}#DOC#{document_id}"


def document_prefix(event_id: str) -> str:
    return f"EVENT#{event_id}#DOC#"


def document_gsi1sk(category: str, timestamp: str) -> str:
    return f"DOC#{category}#{timestamp}"


def document_s3_key(organization_id: str, event_id: str, document_id: str, filename: str) -> str:
    return f"{organization_id}/{event_id}/documents/{document_id}/{filename}"


# ---------------------------------------------------------------------------
# Notifications and chat — per-user, not per-event
# ---------------------------------------------------------------------------


def notification_sk(user_id: str, notification_id: str) -> str:
    return f"USER#{user_id}#NOTIFICATION#{notification_id}"


def notification_prefix(user_id: str) -> str:
    return f"USER#{user_id}#NOTIFICATION#"


def chat_turn_sk(user_id: str, session_id: str, sequence: int) -> str:
    """Zero-padded sequence so lexicographic sort key order is turn order."""
    return f"USER#{user_id}#CHAT#{session_id}#{sequence:06d}"


def chat_session_prefix(user_id: str, session_id: str) -> str:
    return f"USER#{user_id}#CHAT#{session_id}#"


# ---------------------------------------------------------------------------
# Agent activity
# ---------------------------------------------------------------------------


def agent_activity_sk(event_id: str, timestamp: str, activity_id: str) -> str:
    """Timestamp before id so the natural sort key order is chronological."""
    return f"EVENT#{event_id}#AGENTACT#{timestamp}#{activity_id}"


def agent_activity_prefix(event_id: str) -> str:
    return f"EVENT#{event_id}#AGENTACT#"


def agent_activity_gsi1sk(timestamp: str) -> str:
    return f"AGENTACT#{timestamp}"


# ---------------------------------------------------------------------------
# Audit (separate table)
# ---------------------------------------------------------------------------


def audit_sk(timestamp: str, audit_id: str) -> str:
    return f"AUDIT#{timestamp}#{audit_id}"


def audit_prefix() -> str:
    return "AUDIT#"


def audit_gsi1pk(organization_id: str, event_id: str | None) -> str:
    """Audit records without an event land in a ``GLOBAL`` partition, not a missing one."""
    return f"{organization_id}#{event_id or 'GLOBAL'}"
