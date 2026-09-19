"""Shared plumbing for API handlers.

Every handler needs the same opening moves: parse the body, find the organization, run the
tenant check, resolve the principal, apply the role and scope gates. That sequence was
previously copy-pasted into each handler, including private ``_get_org_id`` and
``_get_user_id`` functions duplicated verbatim across seven files.

Duplicated authorization is the kind that drifts. A handler added later, or one fixed
without the others, ends up subtly more permissive than its siblings, and nothing points
at the discrepancy. Centralising it here means the chain is defined once and a new
handler gets the whole thing by calling :func:`begin_request`.

The chain, in order:

1. ``organization_id`` — caller-supplied and therefore untrusted.
2. ``authorize_organization`` — tenant boundary. Fails closed.
3. ``resolve_principal``    — role from the token, team scope from DynamoDB.
4. ``require_role`` / ``authorize_scope`` — the caller's narrower authority.
5. ``evaluate_policy``      — whether this action needs an approval.

Nothing here touches step 5; policy is evaluated by the handler or tool that knows which
action it is performing.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any

from services.shared.api_response import error
from services.shared.dynamodb import DynamoDBError, DynamoDBRepository
from services.shared.models.base import ErrorCategory
from services.shared.principal import Principal, Role, resolve_principal
from services.shared.tenancy import authorize_organization

logger = logging.getLogger(__name__)

MAIN_TABLE = os.environ.get("MAIN_TABLE", "CommunityOps-Main-dev")
AUDIT_TABLE = os.environ.get("AUDIT_TABLE", "CommunityOps-Audit-dev")

# Upper bound on any list endpoint, so a caller cannot ask for an unbounded read.
MAX_PAGE_SIZE = 200
DEFAULT_PAGE_SIZE = 50


def parse_body(event: dict[str, Any]) -> dict[str, Any]:
    """Parse a JSON request body, tolerating absence and malformation.

    Returns an empty dict for a missing or unparseable body. Handlers then fail on the
    specific field they needed, which tells the caller what is actually wrong; a generic
    "invalid JSON" points at the envelope rather than the mistake.
    """
    body = event.get("body")
    if not body:
        return {}
    if isinstance(body, dict):
        return body
    try:
        parsed = json.loads(body)
    except (TypeError, ValueError):
        logger.warning("Request body was not valid JSON")
        return {}
    return parsed if isinstance(parsed, dict) else {}


def get_organization_id(event: dict[str, Any]) -> str:
    """Read the requested organization from the query string, then the body.

    Query string first because GETs carry it there and a GET has no body worth parsing.
    This value is untrusted until ``authorize_organization`` has passed on it.
    """
    params = event.get("queryStringParameters") or {}
    if params.get("organization_id"):
        return str(params["organization_id"]).strip()
    return str(parse_body(event).get("organization_id", "")).strip()


def path_param(event: dict[str, Any], name: str) -> str:
    return str((event.get("pathParameters") or {}).get(name, "") or "").strip()


def query_param(event: dict[str, Any], name: str, default: str = "") -> str:
    return str((event.get("queryStringParameters") or {}).get(name, default) or default).strip()


def page_size(event: dict[str, Any]) -> int:
    """Clamp a caller-supplied page size into a sane range."""
    raw = query_param(event, "limit", str(DEFAULT_PAGE_SIZE))
    try:
        requested = int(raw)
    except ValueError:
        return DEFAULT_PAGE_SIZE
    return max(1, min(requested, MAX_PAGE_SIZE))


@dataclass
class RequestContext:
    """A request that has passed the tenant check, with its principal resolved."""

    organization_id: str
    principal: Principal
    body: dict[str, Any]
    repo: DynamoDBRepository
    event: dict[str, Any]

    @property
    def user_id(self) -> str:
        return self.principal.user_id

    @property
    def actor_type(self) -> str:
        return self.principal.actor_type.value


def begin_request(
    event: dict[str, Any],
    *,
    require: Role | None = None,
    load_scope: bool = True,
    table_name: str | None = None,
) -> tuple[RequestContext | None, dict[str, Any] | None]:
    """Run the opening authorization chain.

    Returns ``(context, None)`` when the request may proceed, or ``(None, response)``
    with a ready-to-return error when it may not. Handlers are then a single guard:

        ctx, denied = begin_request(event, require=Role.LEADER)
        if denied:
            return denied

    Args:
        require: a role the caller must hold. Checked before any data is read, so an
            unauthorized caller cannot use error messages to probe for existence.
        load_scope: whether to load a team member's memberships. Skipped when
            ``require=LEADER``, since a team member is rejected regardless and the query
            could not change the outcome.
    """
    organization_id = get_organization_id(event)
    if not organization_id:
        return None, error(ErrorCategory.VALIDATION_ERROR, "organization_id is required")

    denied = authorize_organization(event, organization_id)
    if denied:
        return None, denied

    table = table_name or MAIN_TABLE
    needs_scope = load_scope and require is not Role.LEADER

    try:
        principal = resolve_principal(
            event, organization_id, table_name=table, load_scope=needs_scope
        )
    except DynamoDBError:
        logger.error("Could not resolve the caller's principal", exc_info=True)
        return None, error(
            ErrorCategory.EXTERNAL_SERVICE_ERROR,
            "Your access could not be confirmed right now. Please retry.",
        )

    if require is not None:
        role_denied = _require(principal, require)
        if role_denied:
            return None, role_denied

    return (
        RequestContext(
            organization_id=organization_id,
            principal=principal,
            body=parse_body(event),
            repo=DynamoDBRepository(table),
            event=event,
        ),
        None,
    )


def _require(principal: Principal, required: Role) -> dict[str, Any] | None:
    from services.shared.principal import require_role

    return require_role(principal, required)


def handle_dynamodb_errors(fn: Any) -> Any:
    """Turn a ``DynamoDBError`` into the API error its category describes.

    Handlers previously let these propagate, so a conditional-check failure surfaced as an
    unhandled exception and API Gateway returned a bare 502 with no indication that the
    request had been *refused* rather than broken. The category already knows the right
    answer; this just uses it.
    """
    import functools

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> dict[str, Any]:
        try:
            return fn(*args, **kwargs)
        except DynamoDBError as exc:
            logger.error("Data layer error in %s: %s", fn.__name__, exc)
            return error(exc.category, str(exc))

    return wrapper


def list_response(key: str, items: list[Any], **extra: Any) -> dict[str, Any]:
    """Build the standard list envelope: ``{"<plural>": [...], "count": n}``."""
    from services.shared.api_response import success

    return success({key: items, "count": len(items), **extra})


def require_fields(body: dict[str, Any], *names: str) -> dict[str, Any] | None:
    """Check that required fields are present and non-empty.

    Reports every missing field at once rather than the first, so a caller fixing a
    request does not have to discover the problems one round trip at a time.
    """
    missing = [
        name
        for name in names
        if body.get(name) in (None, "", [])
        or (isinstance(body.get(name), str) and not str(body[name]).strip())
    ]
    if missing:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            f"Missing required {'field' if len(missing) == 1 else 'fields'}: {', '.join(missing)}",
        )
    return None


def pick(body: dict[str, Any], allowed: list[str]) -> dict[str, Any]:
    """Select only the whitelisted fields a caller may update.

    A whitelist rather than a blocklist: a field added to a model is not writable by
    clients until it is deliberately listed, so new attributes cannot become
    unintentionally caller-controlled.
    """
    return {name: body[name] for name in allowed if name in body}
