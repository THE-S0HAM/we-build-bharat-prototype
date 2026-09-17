"""Base domain model and cross-cutting types."""

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class DomainEntity(BaseModel):
    """Base for all domain entities.

    Every entity is scoped to an organization for tenant isolation.
    """

    organization_id: str = Field(..., min_length=1, description="Tenant boundary — every query must include this")
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    created_by: str = Field(default="system")
    updated_by: str = Field(default="system")


class ErrorCategory(str, Enum):
    """Explicit error categories for consistent API responses."""

    VALIDATION_ERROR = "VALIDATION_ERROR"
    NOT_FOUND = "NOT_FOUND"
    AMBIGUOUS_MATCH = "AMBIGUOUS_MATCH"
    UNAUTHORIZED = "UNAUTHORIZED"
    FORBIDDEN = "FORBIDDEN"
    EXTERNAL_SERVICE_ERROR = "EXTERNAL_SERVICE_ERROR"
    TIMEOUT = "TIMEOUT"
    CONFLICT = "CONFLICT"
    DUPLICATE = "DUPLICATE"
    POLICY_REQUIRES_APPROVAL = "POLICY_REQUIRES_APPROVAL"
    INTERNAL_ERROR = "INTERNAL_ERROR"


class ErrorResponse(BaseModel):
    """Standard API error response. Safe for end users — no internal details."""

    error: ErrorCategory
    message: str = Field(..., description="User-safe message explaining what happened")
    request_id: str | None = None
    details: dict[str, Any] | None = Field(
        default=None,
        description="Additional context (e.g., candidate list for AMBIGUOUS_MATCH)",
    )


class AuditEvent(BaseModel):
    """Immutable audit record for every consequential operation."""

    audit_id: str
    organization_id: str
    event_id: str | None = None
    timestamp: datetime = Field(default_factory=utc_now)
    action: str = Field(..., description="What happened, e.g. TICKET_RECOVERED, CHECKIN_COMPLETED")
    actor_type: str = Field(..., description="user, agent, system")
    actor_id: str = Field(..., description="User ID, agent name, or 'system'")
    resource_type: str = Field(..., description="Entity type affected, e.g. Registration, Ticket")
    resource_id: str = Field(..., description="ID of the affected resource")
    details: dict[str, Any] = Field(default_factory=dict, description="Action-specific context")
    tool_used: str | None = Field(default=None, description="Agent tool that performed the action")
    policy_evaluated: str | None = Field(default=None, description="Cedar policy that was checked")
    approval_id: str | None = Field(default=None, description="If this action required approval")
    outcome: str = Field(default="success", description="success, failure, pending")
