"""The authenticated caller, and what they are allowed to reach.

``tenancy`` answers one question: may this caller touch this organization at all? That
is the tenant boundary and it is necessary but not sufficient. Inside an organization a
leader and a volunteer are not equivalent, so something has to answer the narrower
questions: may this caller approve spending, and may they see this team's tasks?

This module answers them. It resolves an API Gateway event into a :class:`Principal` and
provides the two gates every handler and every agent tool runs after the tenant check:

    resolve_principal -> authorize_organization -> require_role / authorize_scope

Where role comes from
---------------------
Role is carried in the Cognito ``cognito:groups`` claim. Group names beginning ``ORG-``
are organization memberships; ``LEADER`` and ``TEAM_MEMBER`` are roles. Putting role in
the token is right because it changes rarely and is cheap to read.

Where scope comes from
----------------------
Team membership is *not* taken from the token. It is loaded from ``TeamMember`` records
in DynamoDB. Membership changes often and an ID token is valid for its full lifetime, so
a token-derived scope would let someone removed from a team keep reading that team's work
until their token happened to expire. Reading membership costs one indexed query and is
only done for team members, since a leader's scope is the whole organization anyway.

Fail closed
-----------
Every helper returns either ``None`` (permitted) or a ready-to-return API error. An
absent claim, an unreadable claim, or a role that is not recognised all resolve to
``TEAM_MEMBER`` with empty scope, which can read nothing. Being wrongly denied is
recoverable; being wrongly allowed is not.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from services.shared.api_response import error
from services.shared.dynamodb import DynamoDBError, DynamoDBRepository
from services.shared.keys import GSI2_INDEX, user_gsi2pk
from services.shared.models.base import ErrorCategory
from services.shared.tenancy import get_caller_organizations, get_claims, get_user_id

logger = logging.getLogger(__name__)

# Group names that denote a role rather than an organization membership.
ROLE_GROUP_LEADER = "LEADER"
ROLE_GROUP_TEAM_MEMBER = "TEAM_MEMBER"

# Organization group names carry this prefix, which is how a role group is told apart
# from an organization group in a single flat claim.
ORG_GROUP_PREFIX = "ORG-"


class Role(str, Enum):
    """What a caller is allowed to do within an organization."""

    LEADER = "LEADER"
    TEAM_MEMBER = "TEAM_MEMBER"


class ActorType(str, Enum):
    """Who is acting, for audit attribution.

    Kept distinct from :class:`Role` because the agent acts *as* a principal with that
    principal's authority, but the audit trail must still record that a model, not the
    person, initiated the action.
    """

    USER = "user"
    AGENT = "agent"
    SYSTEM = "system"


@dataclass(frozen=True)
class Principal:
    """The authenticated caller and the scope they may act within.

    Frozen because a principal is a fact about a request. Anything that could mutate it
    mid-request would be a way to widen authorization after the checks had run.
    """

    user_id: str
    email: str = ""
    display_name: str = ""
    role: Role = Role.TEAM_MEMBER
    actor_type: ActorType = ActorType.USER
    organizations: frozenset[str] = field(default_factory=frozenset)

    # Populated for team members from TeamMember records. Empty for leaders, whose
    # authority is organization-wide and therefore not expressed as a list.
    team_ids: frozenset[str] = field(default_factory=frozenset)
    event_ids: frozenset[str] = field(default_factory=frozenset)

    # Set when scope lookup failed rather than genuinely returning nothing. An empty
    # scope and an unknown scope look identical, and treating a database outage as
    # "member of no teams" would silently hide a volunteer's own work from them.
    scope_unavailable: bool = False

    @property
    def is_leader(self) -> bool:
        return self.role is Role.LEADER

    def may_see_event(self, event_id: str) -> bool:
        """Whether this principal's scope includes an event."""
        if self.is_leader:
            return True
        return event_id in self.event_ids

    def may_see_team(self, team_id: str) -> bool:
        """Whether this principal's scope includes a team."""
        if self.is_leader:
            return True
        return team_id in self.team_ids

    def to_audit_actor(self) -> dict[str, str]:
        """The actor fields for an audit event, so attribution is written one way."""
        return {"actor_type": self.actor_type.value, "actor_id": self.user_id}


def derive_role(groups: set[str]) -> Role:
    """Pick the role from a caller's Cognito groups.

    ``LEADER`` wins when both groups are present, because a leader who is also on a team
    should not lose organization-wide authority. An unrecognised or absent role group
    yields ``TEAM_MEMBER``, the least-privileged role, so a misconfigured user is
    under-privileged rather than over-privileged.
    """
    if ROLE_GROUP_LEADER in groups:
        return Role.LEADER
    return Role.TEAM_MEMBER


def get_member_organizations(event: dict[str, Any]) -> set[str]:
    """Organization memberships from the claim, excluding role groups."""
    return {g for g in get_caller_organizations(event) if g.startswith(ORG_GROUP_PREFIX)}


def _load_team_scope(
    organization_id: str, user_id: str, table_name: str
) -> tuple[frozenset[str], frozenset[str], bool]:
    """Load a team member's teams and events from their TeamMember records.

    Returns ``(team_ids, event_ids, unavailable)``. On a read failure the scope is empty
    and ``unavailable`` is True, so callers can report "we could not determine your
    access" instead of the misleading "you have no assignments".
    """
    try:
        repo = DynamoDBRepository(table_name)
        items = repo.query_gsi_all(
            GSI2_INDEX,
            user_gsi2pk(organization_id, user_id),
            sk_begins_with="MEMBER#",
            max_items=200,
        )
    except DynamoDBError:
        logger.error(
            "Could not load team scope for principal",
            extra={"organization_id": organization_id},
            exc_info=True,
        )
        return frozenset(), frozenset(), True

    team_ids: set[str] = set()
    event_ids: set[str] = set()
    for item in items:
        # An inactive membership is retained for history but confers no access.
        if item.get("is_active") is False:
            continue
        if team_id := item.get("team_id"):
            team_ids.add(str(team_id))
        if event_id := item.get("event_id"):
            event_ids.add(str(event_id))
    return frozenset(team_ids), frozenset(event_ids), False


def resolve_principal(
    event: dict[str, Any],
    organization_id: str,
    *,
    table_name: str,
    load_scope: bool = True,
) -> Principal:
    """Build the :class:`Principal` for an API Gateway request.

    Args:
        event: the raw API Gateway event, for its authorizer claims.
        organization_id: the organization the request is scoped to. Callers must have
            already passed it through ``tenancy.authorize_organization``; this function
            trusts that check rather than repeating it, and only uses the value to scope
            the membership lookup.
        table_name: main table, so tests can point at a fixture table.
        load_scope: set False for leader-only routes that will reject a team member
            anyway, to avoid a query whose result cannot change the outcome.
    """
    claims = get_claims(event)
    groups = get_caller_organizations(event)
    role = derive_role(groups)

    principal = Principal(
        user_id=get_user_id(event),
        email=str(claims.get("email", "")),
        display_name=str(claims.get("name", "")),
        role=role,
        actor_type=ActorType.USER,
        organizations=frozenset(g for g in groups if g.startswith(ORG_GROUP_PREFIX)),
    )

    # A leader's authority is organization-wide, so enumerating their teams would cost a
    # query and change nothing about what they may reach.
    if role is Role.LEADER or not load_scope:
        return principal

    team_ids, event_ids, unavailable = _load_team_scope(
        organization_id, principal.user_id, table_name
    )
    return Principal(
        user_id=principal.user_id,
        email=principal.email,
        display_name=principal.display_name,
        role=principal.role,
        actor_type=principal.actor_type,
        organizations=principal.organizations,
        team_ids=team_ids,
        event_ids=event_ids,
        scope_unavailable=unavailable,
    )


def agent_principal(base: Principal) -> Principal:
    """The same authority, re-attributed to the agent for audit purposes.

    The agent acts strictly within the authority of whoever is talking to it — it never
    gains scope by being an agent. Only ``actor_type`` changes, so the audit trail shows
    a model initiated the action while the permission checks remain the user's.
    """
    return Principal(
        user_id=base.user_id,
        email=base.email,
        display_name=base.display_name,
        role=base.role,
        actor_type=ActorType.AGENT,
        organizations=base.organizations,
        team_ids=base.team_ids,
        event_ids=base.event_ids,
        scope_unavailable=base.scope_unavailable,
    )


def system_principal(organization_id: str, *, user_id: str = "system") -> Principal:
    """A principal for background work with no human caller.

    Used by workflow Lambdas and the demo simulation. It carries leader authority
    because those paths run operations a leader configured, and every action they take
    still goes through policy evaluation and the audit log. It is deliberately not
    reachable from an HTTP request: nothing derives this from a token.
    """
    return Principal(
        user_id=user_id,
        display_name="CommunityOps System",
        role=Role.LEADER,
        actor_type=ActorType.SYSTEM,
        organizations=frozenset({organization_id}),
    )


# ---------------------------------------------------------------------------
# Gates — each returns None when permitted, or a ready-to-return error response
# ---------------------------------------------------------------------------


def require_role(principal: Principal, required: Role) -> dict[str, Any] | None:
    """Gate a route or tool on a minimum role.

    Only ``LEADER`` is a privileged role, so this is an equality check rather than a
    hierarchy walk. If more roles are added it should become an ordering.
    """
    if required is Role.LEADER and not principal.is_leader:
        logger.warning(
            "Role check denied",
            extra={"required_role": required.value, "actual_role": principal.role.value},
        )
        return error(
            ErrorCategory.FORBIDDEN,
            "This action is available to community leaders only.",
        )
    return None


def authorize_scope(
    principal: Principal,
    *,
    event_id: str = "",
    team_id: str = "",
) -> dict[str, Any] | None:
    """Gate a team member to the events and teams they belong to.

    A leader passes unconditionally. A team member must belong to the event and, when a
    team is named, to that team.

    A principal whose scope could not be loaded is denied with a distinct message. That
    is deliberate: silently treating a failed lookup as "no memberships" would tell a
    volunteer they have no assignments during a database problem, which is both wrong and
    alarming at exactly the wrong moment.
    """
    if principal.is_leader:
        return None

    if principal.scope_unavailable:
        return error(
            ErrorCategory.EXTERNAL_SERVICE_ERROR,
            "Your team assignments could not be loaded, so access could not be confirmed. "
            "Please retry.",
        )

    if event_id and event_id not in principal.event_ids:
        logger.warning("Scope check denied for event", extra={"event_id": event_id})
        return error(
            ErrorCategory.FORBIDDEN,
            "You are not assigned to this event.",
        )

    if team_id and team_id not in principal.team_ids:
        logger.warning("Scope check denied for team", extra={"team_id": team_id})
        return error(
            ErrorCategory.FORBIDDEN,
            "You are not a member of this team.",
        )

    return None


def authorize_task_access(
    principal: Principal,
    task: dict[str, Any],
    *,
    write: bool = False,
) -> dict[str, Any] | None:
    """Gate access to a single task record.

    A leader may read and write any task. A team member may read any task belonging to
    one of their teams, because coordinating with teammates requires seeing their work,
    but may only write a task assigned to them or unassigned within their own team.

    Writing a teammate's in-flight task is refused rather than allowed: two people
    silently editing the same task is how work gets lost, and reassignment is a leader's
    decision.
    """
    if principal.is_leader:
        return None

    team_id = str(task.get("team_id", ""))
    denied = authorize_scope(principal, event_id=str(task.get("event_id", "")), team_id=team_id)
    if denied:
        return denied

    if not write:
        return None

    assignee = str(task.get("assigned_to", ""))
    if assignee and assignee != principal.user_id:
        return error(
            ErrorCategory.FORBIDDEN,
            "This task is assigned to another team member. Ask a leader to reassign it.",
        )
    return None
