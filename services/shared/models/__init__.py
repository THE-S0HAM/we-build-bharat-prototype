"""CommunityOps domain models.

All domain entities are Pydantic models with strict validation.
These models define the operational data structures used across
services, agents, and tools.
"""

from services.shared.models.agent import (
    AgentActivity,
    AgentActivityOutcome,
    ChatRole,
    ChatTurn,
)
from services.shared.models.approval import Approval, ApprovalStatus, RiskLevel
from services.shared.models.attendee import Attendee
from services.shared.models.base import AuditEvent, DomainEntity, ErrorCategory, ErrorResponse
from services.shared.models.budget import (
    Budget,
    BudgetAllocation,
    BudgetCategory,
    Expense,
    ExpenseStatus,
)
from services.shared.models.checkin import CheckIn, CheckInStatus, RecoveryCase, RecoveryCaseStatus
from services.shared.models.document import (
    ALLOWED_CONTENT_TYPES,
    MAX_DOCUMENT_BYTES,
    Document,
    DocumentCategory,
)
from services.shared.models.event import Event, EventStatus, HealthBand
from services.shared.models.incident import (
    AGENT_RESOLVABLE_SEVERITIES,
    CLOSED_INCIDENT_STATUSES,
    CommentAuthorType,
    Incident,
    IncidentCategory,
    IncidentComment,
    IncidentSeverity,
    IncidentStatus,
)
from services.shared.models.notification import (
    Notification,
    NotificationSeverity,
    NotificationType,
)
from services.shared.models.organization import Organization, OrganizationRole, UserRole
from services.shared.models.registration import (
    PaymentReference,
    PaymentStatus,
    Registration,
    RegistrationStatus,
)
from services.shared.models.speaker import Speaker, SpeakerStatus
from services.shared.models.team import (
    TERMINAL_TASK_STATUSES,
    Task,
    TaskPriority,
    TaskRisk,
    TaskStatus,
    Team,
    TeamMember,
    TeamRole,
)
from services.shared.models.ticket import Ticket, TicketStatus

__all__ = [
    # Base and cross-cutting
    "AuditEvent",
    "DomainEntity",
    "ErrorCategory",
    "ErrorResponse",
    # Organization and identity
    "Organization",
    "OrganizationRole",
    "UserRole",
    # Event
    "Event",
    "EventStatus",
    "HealthBand",
    # Registration, payment, ticketing, check-in
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
    # Speaker
    "Speaker",
    "SpeakerStatus",
    # Team, membership and tasks
    "Team",
    "TeamMember",
    "TeamRole",
    "Task",
    "TaskStatus",
    "TaskPriority",
    "TaskRisk",
    "TERMINAL_TASK_STATUSES",
    # Attendee
    "Attendee",
    # Incident and discussion
    "Incident",
    "IncidentSeverity",
    "IncidentStatus",
    "IncidentCategory",
    "IncidentComment",
    "CommentAuthorType",
    "AGENT_RESOLVABLE_SEVERITIES",
    "CLOSED_INCIDENT_STATUSES",
    # Approval
    "Approval",
    "ApprovalStatus",
    "RiskLevel",
    # Budget
    "Budget",
    "BudgetAllocation",
    "BudgetCategory",
    "Expense",
    "ExpenseStatus",
    # Documents
    "Document",
    "DocumentCategory",
    "ALLOWED_CONTENT_TYPES",
    "MAX_DOCUMENT_BYTES",
    # Notifications
    "Notification",
    "NotificationType",
    "NotificationSeverity",
    # Agent observability
    "AgentActivity",
    "AgentActivityOutcome",
    "ChatTurn",
    "ChatRole",
]
