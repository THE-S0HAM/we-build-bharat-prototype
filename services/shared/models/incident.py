"""Incident model for IncidentOps workflow."""

from datetime import datetime
from enum import Enum

from pydantic import Field

from services.shared.models.base import DomainEntity


class IncidentSeverity(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class IncidentStatus(str, Enum):
    DETECTED = "DETECTED"
    ANALYZING = "ANALYZING"
    RECOMMENDATION_READY = "RECOMMENDATION_READY"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    APPROVED = "APPROVED"
    EXECUTING = "EXECUTING"
    RESOLVED = "RESOLVED"
    REJECTED = "REJECTED"
    ESCALATED = "ESCALATED"


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
    status: IncidentStatus = IncidentStatus.DETECTED

    # Context
    affected_resource_type: str = Field(default="", description="Speaker, Session, Venue, etc.")
    affected_resource_id: str = ""
    detected_at: datetime | None = None
    detected_by: str = Field(default="", description="user, agent, system")

    # Analysis
    impact_analysis: str = ""
    dependencies: list[str] = Field(default_factory=list, description="Other resources affected")
    backup_options: list[str] = Field(default_factory=list, description="Possible remediation options")
    recommendation: str = ""
    evidence: str = Field(default="", description="Facts supporting the recommendation")

    # Resolution
    approval_id: str | None = None
    resolved_at: datetime | None = None
    resolved_by: str = ""
    resolution_summary: str = ""
