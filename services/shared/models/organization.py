"""Organization and user role models."""

from enum import Enum

from pydantic import Field

from services.shared.models.base import DomainEntity


class OrganizationRole(str, Enum):
    OWNER = "OWNER"
    ADMIN = "ADMIN"
    ORGANIZER = "ORGANIZER"
    VOLUNTEER = "VOLUNTEER"
    VIEWER = "VIEWER"


class Organization(DomainEntity):
    """Tenant root. All data is scoped to an organization."""

    name: str = Field(..., min_length=1, max_length=200)
    slug: str = Field(..., min_length=1, max_length=100, pattern=r"^[a-z0-9-]+$")
    description: str = ""
    contact_email: str = ""
    is_active: bool = True


class UserRole(DomainEntity):
    """Maps a Cognito user to an organization role."""

    user_id: str = Field(..., min_length=1, description="Cognito sub")
    email: str
    display_name: str
    role: OrganizationRole
    event_id: str | None = Field(
        default=None,
        description="If set, role is scoped to a specific event",
    )
