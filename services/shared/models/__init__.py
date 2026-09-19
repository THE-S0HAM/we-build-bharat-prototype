"""CommunityOps domain models.

All domain entities are Pydantic models with strict validation.
These models define the operational data structures used across
services, agents, and tools.
"""

from services.shared.models.approval import Approval, ApprovalStatus, RiskLevel
from services.shared.models.attendee import Attendee
from services.shared.models.base import AuditEvent, DomainEntity, ErrorCategory, ErrorResponse
from services.shared.models.checkin import CheckIn, CheckInStatus, RecoveryCase, RecoveryCaseStatus
from services.shared.models.event import Event, EventStatus
from services.shared.models.incident import Incident, IncidentSeverity, IncidentStatus
from services.shared.models.organization import Organization, OrganizationRole, UserRole
from services.shared.models.registration import (
    PaymentReference,
    PaymentStatus,
    Registration,
    RegistrationStatus,
)
from services.shared.models.speaker import Speaker, SpeakerStatus
from services.shared.models.team import Task, TaskPriority, TaskStatus, Team
from services.shared.models.ticket import Ticket, TicketStatus

__all__ = [
    "AuditEvent",
    "DomainEntity",
    "ErrorCategory",
    "ErrorResponse",
    "Organization",
    "OrganizationRole",
    "UserRole",
    "Event",
    "EventStatus",
    "Registration",
    "RegistrationStatus",
    "PaymentReference",
    "PaymentStatus",
    "Ticket",
    "TicketStatus",
    "CheckIn",
    "CheckInStatus",
    "RecoveryCase",
    "RecoveryCaseStatus",
    "Speaker",
    "SpeakerStatus",
    "Team",
    "Task",
    "TaskStatus",
    "TaskPriority",
    "Attendee",
    "Incident",
    "IncidentSeverity",
    "IncidentStatus",
    "Approval",
    "ApprovalStatus",
    "RiskLevel",
]
