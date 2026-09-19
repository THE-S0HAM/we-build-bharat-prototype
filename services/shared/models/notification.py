"""Operational notifications.

Notifications are addressed to a specific user and stored under a ``USER#`` sort key so
a user's inbox is a single partition query that never collides with the ``EVENT#``
prefix scans used for event listings.

Each notification carries the identifiers needed to deep-link to the thing it is about,
so the console never has to guess where a notification should navigate.
"""

from datetime import datetime
from enum import Enum

from pydantic import Field

from services.shared.models.base import DomainEntity


class NotificationType(str, Enum):
    APPROVAL_REQUESTED = "APPROVAL_REQUESTED"
    APPROVAL_DECIDED = "APPROVAL_DECIDED"
    TASK_ASSIGNED = "TASK_ASSIGNED"
    TASK_OVERDUE = "TASK_OVERDUE"
    INCIDENT_REPORTED = "INCIDENT_REPORTED"
    INCIDENT_UPDATED = "INCIDENT_UPDATED"
    AGENT_RECOMMENDATION = "AGENT_RECOMMENDATION"
    SPEAKER_RESPONSE = "SPEAKER_RESPONSE"
    BUDGET_WARNING = "BUDGET_WARNING"


class NotificationSeverity(str, Enum):
    INFO = "INFO"
    ATTENTION = "ATTENTION"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class Notification(DomainEntity):
    """A single addressed notification."""

    notification_id: str = Field(..., min_length=1)
    user_id: str = Field(..., min_length=1, description="Cognito sub of the recipient")
    event_id: str = ""
    type: NotificationType
    severity: NotificationSeverity = NotificationSeverity.INFO
    title: str = Field(..., min_length=1, max_length=300)
    body: str = Field(default="", max_length=2000)

    # Deep link target so the console does not have to infer navigation.
    resource_type: str = Field(default="", description="Approval, Task, Incident, Budget")
    resource_id: str = ""

    is_read: bool = False
    read_at: datetime | None = None
