"""Incident and incident discussion models for IncidentOps workflow."""

from datetime import datetime
from enum import Enum

from pydantic import Field

from services.shared.models.base import DomainEntity


class IncidentSeverity(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


# Severities the agent must never resolve on its own. Resolving a serious incident is a
# judgement call about whether the underlying problem is actually gone, which is not
# something the model can verify.
AGENT_RESOLVABLE_SEVERITIES: frozenset[str] = frozenset(
    {IncidentSeverity.LOW.value, IncidentSeverity.MEDIUM.value}
)


class IncidentStatus(str, Enum):
    """Incident lifecycle.

    ``REPORTED`` is the human entry point and ``DETECTED`` the agent one; both are open
    and unacknowledged. ``DETECTED`` predates ``REPORTED`` and is retained because
    existing records use it.
    """

    REPORTED = "REPORTED"
    DETECTED = "DETECTED"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    ANALYZING = "ANALYZING"
    RECOMMENDATION_READY = "RECOMMENDATION_READY"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    APPROVED = "APPROVED"
    EXECUTING = "EXECUTING"
    RESOLVED = "RESOLVED"
    REOPENED = "REOPENED"
    CLOSED = "CLOSED"
    REJECTED = "REJECTED"
    ESCALATED = "ESCALATED"


# Statuses where the incident no longer needs attention. The health engine and the
# attention list both use this one definition.
CLOSED_INCIDENT_STATUSES: frozenset[str] = frozenset(
    {IncidentStatus.RESOLVED.value, IncidentStatus.CLOSED.value, IncidentStatus.REJECTED.value}
)


class IncidentCategory(str, Enum):
    VENUE = "VENUE"
    TECHNICAL = "TECHNICAL"
    SPEAKER = "SPEAKER"
    REGISTRATION = "REGISTRATION"
    CATERING = "CATERING"
    SAFETY = "SAFETY"
    LOGISTICS = "LOGISTICS"
    OTHER = "OTHER"


class Incident(DomainEntity):
    """An operational incident during an event.

    IncidentOps detects risks, analyzes context, identifies dependencies
    and backup options, prepares recommendations, and requests human
    approval before executing resolutions. The agent never directly
    mutates critical state without approval for HIGH/CRITICAL incidents.
    """

    event_id: str = Field(..., min_length=1)
    incident_id: str = Field(..., min_length=1)
    title: str = Field(..., min_length=1, max_length=500)
    description: str = ""
    severity: IncidentSeverity = IncidentSeverity.MEDIUM
    status: IncidentStatus = IncidentStatus.REPORTED
    category: IncidentCategory = IncidentCategory.OTHER

    # Context
    team_id: str = Field(default="", description="Team that owns or reported the incident")
    affected_resource_type: str = Field(default="", description="Speaker, Session, Venue, etc.")
    affected_resource_id: str = ""
    detected_at: datetime | None = None
    detected_by: str = Field(default="", description="user, agent, system")
    reported_by: str = ""
    reported_by_name: str = ""
    reported_by_role: str = ""

    # Ownership
    assigned_to: str = ""
    assigned_to_name: str = ""
    acknowledged_at: datetime | None = None
    acknowledged_by: str = ""
    escalated_at: datetime | None = None

    # Analysis
    impact_analysis: str = ""
    dependencies: list[str] = Field(default_factory=list, description="Other resources affected")
    backup_options: list[str] = Field(
        default_factory=list, description="Possible remediation options"
    )
    recommendation: str = ""
    evidence: str = Field(default="", description="Facts supporting the recommendation")

    # Resolution
    approval_id: str | None = None
    resolved_at: datetime | None = None
    resolved_by: str = ""
    resolution_summary: str = ""
    root_cause: str = ""
    actions_taken: list[str] = Field(default_factory=list)
    reopened_count: int = Field(default=0, ge=0)

    # Denormalized so the incident list can show discussion volume without a second
    # query per incident.
    comment_count: int = Field(default=0, ge=0)


class CommentAuthorType(str, Enum):
    USER = "user"
    AGENT = "agent"
    SYSTEM = "system"


class IncidentComment(DomainEntity):
    """One message in an incident's discussion thread.

    Threading is a single level of parenting: a comment may reply to another comment but
    replies do not nest further. That keeps the read model a flat ordered list the
    console can group, rather than a tree requiring recursive fetches.
    """

    event_id: str = Field(..., min_length=1)
    incident_id: str = Field(..., min_length=1)
    comment_id: str = Field(..., min_length=1)
    body: str = Field(..., min_length=1, max_length=5000)

    author_id: str = Field(..., min_length=1)
    author_name: str = Field(default="", max_length=200)
    author_type: CommentAuthorType = CommentAuthorType.USER
    author_role: str = ""
    team_id: str = ""

    parent_comment_id: str | None = None
    attachment_document_id: str | None = None

    # Set when a comment led to real work, so the thread and the resulting records stay
    # linked in both directions.
    created_task_id: str | None = None
    created_approval_id: str | None = None
