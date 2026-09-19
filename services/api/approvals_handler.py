"""Approvals — the human-in-the-loop decision interface.

Routes:
    GET  /events/{eventId}/approvals                  list approvals
    GET  /events/{eventId}/approvals/{approvalId}     one approval with its budget effect
    POST /events/{eventId}/approvals                  request an approval
    PUT  /events/{eventId}/approvals/{approvalId}     decide: APPROVED, DECLINED, EDITED

This is where the product's central promise is actually kept: an agent that wants to do
something consequential creates a record here and stops, and nothing happens until a
leader decides. Two things follow from that.

First, only a leader may decide. A team member may *request* — that is how a volunteer
asks for a reimbursement — but the decision is the leader's. Both roles reach the same
route and the role gate separates them.

Second, approving a financial request has to move money, deterministically, in the same
operation. The agent explains the effect; this handler applies it, by calling
``budget_service``. The budget mutation runs *before* the status change, so a refused
budget write leaves the approval pending rather than marking it approved with no money
reserved — an approval whose effect silently failed is worse than one that was rejected.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from services.api._common import (
    begin_request,
    handle_dynamodb_errors,
    path_param,
    query_param,
    require_fields,
)
from services.shared import budget_service
from services.shared.api_response import error, success
from services.shared.audit import create_audit_event
from services.shared.budget_service import BudgetError
from services.shared.keys import (
    approval_gsi1sk,
    approval_prefix,
    approval_sk,
    event_gsi1pk,
)
from services.shared.models.base import ErrorCategory, utc_now
from services.shared.models.budget import BudgetCategory
from services.shared.principal import Role, authorize_scope
from services.shared.validation import (
    coerce_int,
    format_inr,
    sanitize_name,
    sanitize_text,
    validate_amount_inr,
)

logger = logging.getLogger(__name__)

DECISIONS = ("APPROVED", "DECLINED", "EDITED")


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    method = event.get("httpMethod", "GET")
    event_id = path_param(event, "eventId")
    approval_id = path_param(event, "approvalId")

    if method == "GET" and approval_id:
        return get_approval(event, event_id, approval_id)
    if method == "GET":
        return list_approvals(event, event_id)
    if method == "POST":
        return request_approval(event, event_id)
    if method == "PUT" and approval_id:
        return decide_approval(event, event_id, approval_id)

    return error(ErrorCategory.VALIDATION_ERROR, "Unsupported operation")


@handle_dynamodb_errors
def list_approvals(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """List an event's approvals, pending first.

    Reads the sort-key prefix and filters on the ``status`` attribute rather than querying
    ``GSI1SK begins_with "APPROVAL#PENDING"``. The index key encodes the status at creation
    time, and although the decision path now rewrites it, records written by earlier
    versions still carry a stale ``PENDING`` key. Filtering on the attribute is correct for
    both, where trusting the key would report decided approvals as pending.
    """
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    if not event_id:
        return error(ErrorCategory.VALIDATION_ERROR, "eventId is required")

    scope_denied = authorize_scope(ctx.principal, event_id=event_id)
    if scope_denied:
        return scope_denied

    items = ctx.repo.query_all(ctx.organization_id, approval_prefix(event_id), max_items=500)

    status_filter = query_param(event, "status").upper()
    if status_filter:
        items = [a for a in items if str(a.get("status")) == status_filter]

    # A team member sees the requests they raised, not the organization's whole queue: a
    # volunteer's reimbursement is their business, another team's venue spend is not.
    if not ctx.principal.is_leader:
        items = [a for a in items if str(a.get("requested_by")) == ctx.user_id]

    def sort_key(approval: dict[str, Any]) -> tuple[int, str]:
        pending_first = 0 if str(approval.get("status")) == "PENDING" else 1
        return pending_first, str(approval.get("requested_at", ""))

    items.sort(key=sort_key)

    pending = [a for a in items if str(a.get("status")) == "PENDING"]
    return success(
        {
            "approvals": items,
            "count": len(items),
            "pending_count": len(pending),
            "pending_financial_exposure_inr": sum(coerce_int(a.get("amount_inr")) for a in pending),
        }
    )


@handle_dynamodb_errors
def get_approval(event: dict[str, Any], event_id: str, approval_id: str) -> dict[str, Any]:
    """One approval, with the budget effect approving it would have.

    The projection is attached to the read so the leader sees the consequence on the same
    screen as the decision, computed by the same code that will apply it. That is the
    difference between "approve and find out" and an informed decision.
    """
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    approval = ctx.repo.get_item(ctx.organization_id, approval_sk(event_id, approval_id))
    if not approval:
        return error(ErrorCategory.NOT_FOUND, "Approval request not found")

    scope_denied = authorize_scope(ctx.principal, event_id=event_id)
    if scope_denied:
        return scope_denied
    if not ctx.principal.is_leader and str(approval.get("requested_by")) != ctx.user_id:
        return error(ErrorCategory.FORBIDDEN, "You can only view approvals you requested.")

    amount = coerce_int(approval.get("amount_inr"))
    projection = None
    if amount > 0 and str(approval.get("status")) == "PENDING":
        summary = budget_service.get_budget(
            ctx.organization_id, event_id, table_name=ctx.repo.table_name
        )
        projection = budget_service.project_commitment(
            summary, str(approval.get("budget_category", "OTHER")), amount
        )

    return success({"approval": approval, "budget_projection": projection})


@handle_dynamodb_errors
def request_approval(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Raise an approval request.

    Open to both roles: a team member requesting a reimbursement is exactly the flow this
    supports. A financial request must name a valid budget category, because the category
    is what the commitment will be applied against and a request that cannot be applied is
    not a decision anybody can usefully make.
    """
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    if not event_id:
        return error(ErrorCategory.VALIDATION_ERROR, "eventId is required")

    scope_denied = authorize_scope(ctx.principal, event_id=event_id)
    if scope_denied:
        return scope_denied

    missing = require_fields(ctx.body, "title", "requested_action")
    if missing:
        return missing

    amount = 0
    if ctx.body.get("amount_inr") not in (None, "", 0, "0"):
        validated = validate_amount_inr(ctx.body["amount_inr"])
        if validated is None:
            return error(
                ErrorCategory.VALIDATION_ERROR,
                "amount_inr must be a whole number of rupees.",
            )
        amount = validated

    category = str(ctx.body.get("budget_category", "")).strip().upper()
    if amount > 0:
        if not category:
            return error(
                ErrorCategory.VALIDATION_ERROR,
                "A financial request must name a budget_category so the amount can be "
                "committed against it.",
            )
        if category not in {c.value for c in BudgetCategory}:
            return error(
                ErrorCategory.VALIDATION_ERROR,
                f"budget_category must be one of: {', '.join(c.value for c in BudgetCategory)}",
            )

    # The risk level shown to the leader comes from the policy catalogue, not from the
    # requester, so a request cannot describe itself as low risk to attract a faster yes.
    from services.shared.policy import risk_tier_for

    tier = risk_tier_for(str(ctx.body["requested_action"]))

    approval_id = f"APR-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()

    budget_impact = ""
    if amount > 0:
        summary = budget_service.get_budget(
            ctx.organization_id, event_id, table_name=ctx.repo.table_name
        )
        projection = budget_service.project_commitment(summary, category, amount)
        budget_impact = projection["impact_summary"]

    ctx.repo.put_item(
        ctx.organization_id,
        approval_sk(event_id, approval_id),
        {
            "entity_type": "APPROVAL",
            "event_id": event_id,
            "approval_id": approval_id,
            "title": sanitize_name(str(ctx.body["title"])),
            "description": sanitize_text(str(ctx.body.get("description", ""))),
            "status": "PENDING",
            "risk_level": "CRITICAL" if tier.value == "NEVER" else tier.value,
            "requested_action": str(ctx.body["requested_action"]),
            "reason": sanitize_text(str(ctx.body.get("reason", "")), 2000),
            "evidence": ctx.body.get("evidence") or {},
            "affected_resource_type": str(ctx.body.get("affected_resource_type", "")),
            "affected_resource_id": str(ctx.body.get("affected_resource_id", "")),
            "amount_inr": amount,
            "currency": "INR",
            "budget_category": category,
            "budget_impact": budget_impact,
            "requested_by": ctx.user_id,
            "requested_by_name": ctx.principal.display_name or ctx.principal.email,
            "requested_by_role": ctx.principal.role.value,
            "agent_name": str(ctx.body.get("agent_name", "")),
            "agent_recommendation": sanitize_text(
                str(ctx.body.get("agent_recommendation", "")), 2000
            ),
            "requested_at": now,
            "created_at": now,
            "updated_at": now,
            "created_by": ctx.user_id,
            "updated_by": ctx.user_id,
            "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
            "GSI1SK": approval_gsi1sk("PENDING", now),
        },
    )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="APPROVAL_REQUESTED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Approval",
        resource_id=approval_id,
        event_id=event_id,
        details={
            "requested_action": str(ctx.body["requested_action"]),
            "amount_inr": amount,
            "risk_tier": tier.value,
        },
        policy_evaluated="RequestApproval",
        outcome="pending",
    )

    _notify_leaders_of_request(ctx, event_id, approval_id, str(ctx.body["title"]), amount)

    return success(
        {
            "approval_id": approval_id,
            "status": "PENDING",
            "risk_level": tier.value,
            "budget_impact": budget_impact,
            "message": "Approval requested. A community leader will decide.",
        },
        status_code=201,
    )


@handle_dynamodb_errors
def decide_approval(event: dict[str, Any], event_id: str, approval_id: str) -> dict[str, Any]:
    """Decide an approval, applying its budget effect when it has one.

    Order of operations is deliberate:

    1. Confirm the approval is still ``PENDING`` — deciding twice must not double-commit.
    2. Apply the budget commitment, if any. A refusal here aborts the whole decision.
    3. Write the status, rewriting the index sort key so pending listings stay truthful.
    4. Audit, then notify the requester.

    Money moves before the status changes because the reverse order can leave an approval
    marked APPROVED whose funds were never reserved, and nothing downstream would know.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    decision = str(ctx.body.get("decision", "")).upper()
    if decision not in DECISIONS:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            f"decision must be one of: {', '.join(DECISIONS)}",
        )

    sk = approval_sk(event_id, approval_id)
    existing = ctx.repo.get_item(ctx.organization_id, sk)
    if not existing:
        return error(ErrorCategory.NOT_FOUND, "Approval request not found")

    current_status = str(existing.get("status", ""))
    if current_status != "PENDING":
        return error(
            ErrorCategory.CONFLICT,
            f"This approval was already {current_status.lower()} and cannot be decided again.",
        )

    requested_action = str(existing.get("requested_action", ""))

    # An action in the NEVER tier cannot be unlocked by approving it. Allowing the
    # decision would create a record implying an automated path exists, and something
    # downstream would eventually act on it.
    from services.shared.policy import RiskTier, risk_tier_for

    if risk_tier_for(requested_action) is RiskTier.NEVER and decision == "APPROVED":
        return error(
            ErrorCategory.FORBIDDEN,
            f"{requested_action} may never be carried out automatically, even with "
            "approval. It has to be done directly by a person.",
        )

    amount = coerce_int(existing.get("amount_inr"))
    category = str(existing.get("budget_category", ""))
    budget_summary = None

    if decision == "APPROVED" and amount > 0 and category:
        try:
            budget_summary = budget_service.commit(
                ctx.organization_id,
                event_id,
                category,
                amount,
                actor_id=ctx.user_id,
                table_name=ctx.repo.table_name,
            )
        except BudgetError as exc:
            # The approval stays PENDING. The leader is told why, and can raise the
            # allocation or decline, rather than being left with an approval that
            # appears to have worked.
            logger.info("Approval blocked by the budget: %s", exc.message)
            return error(exc.category, f"This approval was not applied. {exc.message}")

    now = utc_now().isoformat()
    updates: dict[str, Any] = {
        "status": decision,
        "decided_by": ctx.user_id,
        "decided_at": now,
        "decision_notes": sanitize_text(str(ctx.body.get("notes", "")), 2000),
        "updated_at": now,
        "updated_by": ctx.user_id,
        # The status lives in the index sort key, so it has to be rewritten here. Without
        # this, a query for pending approvals keeps returning this one forever.
        "GSI1SK": approval_gsi1sk(decision, str(existing.get("requested_at", now))),
    }
    if decision == "EDITED":
        updates["edited_action"] = sanitize_text(str(ctx.body.get("edited_action", "")), 2000)

    if budget_summary is not None:
        updates["budget_impact"] = (
            f"Committed {format_inr(amount)}; {format_inr(budget_summary.remaining)} remaining"
        )

    ctx.repo.update_item(ctx.organization_id, sk, updates)

    create_audit_event(
        organization_id=ctx.organization_id,
        action=f"APPROVAL_{decision}",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Approval",
        resource_id=approval_id,
        event_id=event_id,
        details={
            "decision": decision,
            "requested_action": requested_action,
            "risk_level": str(existing.get("risk_level", "")),
            "amount_inr": amount,
            "budget_committed": budget_summary is not None,
            "remaining_after": budget_summary.remaining if budget_summary else None,
        },
        approval_id=approval_id,
        policy_evaluated="DecideApproval",
    )

    if budget_summary is not None:
        create_audit_event(
            organization_id=ctx.organization_id,
            action="BUDGET_COMMITTED",
            actor_type=ctx.actor_type,
            actor_id=ctx.user_id,
            resource_type="Budget",
            resource_id=event_id,
            event_id=event_id,
            details={
                "category": category,
                "amount_inr": amount,
                "committed_total": budget_summary.committed,
                "remaining": budget_summary.remaining,
            },
            approval_id=approval_id,
        )

    _notify_requester_of_decision(ctx, event_id, existing, decision)
    _recompute_event_health(ctx, event_id)

    response: dict[str, Any] = {
        "approval_id": approval_id,
        "status": decision,
        "message": f"Approval {decision.lower()}.",
    }
    if budget_summary is not None:
        response["budget"] = budget_summary
        response["message"] = (
            f"Approved. {format_inr(amount)} committed to {category}; "
            f"{format_inr(budget_summary.remaining)} remaining."
        )
    return success(response)


def _notify_leaders_of_request(
    ctx: Any, event_id: str, approval_id: str, title: str, amount: int
) -> None:
    """Tell the leaders there is a decision waiting.

    Leadership is a Cognito group rather than a DynamoDB record, so there is no query that
    enumerates leaders. Team leads are notified instead, since they are the people
    recorded as accountable for the event's teams, and the leader sees the request in the
    command centre's attention list regardless.
    """
    from boto3.dynamodb.conditions import Attr

    from services.shared.keys import team_prefix
    from services.shared.models.notification import NotificationType
    from services.shared.notify import notify_many

    teams = ctx.repo.query_all(
        ctx.organization_id,
        team_prefix(event_id),
        filter_expression=Attr("entity_type").eq("TEAM"),
    )
    lead_ids = [str(t.get("lead_user_id", "")) for t in teams if t.get("lead_user_id")]
    detail = f"{format_inr(amount)} requested" if amount else "Decision required"
    notify_many(
        ctx.organization_id,
        lead_ids,
        NotificationType.APPROVAL_REQUESTED,
        title,
        body=detail,
        event_id=event_id,
        resource_type="Approval",
        resource_id=approval_id,
        actor_id=ctx.user_id,
    )


def _notify_requester_of_decision(
    ctx: Any, event_id: str, approval: dict[str, Any], decision: str
) -> None:
    requester = str(approval.get("requested_by", ""))
    if not requester or requester == ctx.user_id:
        return

    from services.shared.models.notification import NotificationType
    from services.shared.notify import notify

    notify(
        ctx.organization_id,
        requester,
        NotificationType.APPROVAL_DECIDED,
        f"{str(approval.get('title', 'Your request'))} was {decision.lower()}",
        body=str(approval.get("decision_notes", "")) or "Decided by a community leader.",
        event_id=event_id,
        resource_type="Approval",
        resource_id=str(approval.get("approval_id", "")),
        actor_id=ctx.user_id,
    )


def _recompute_event_health(ctx: Any, event_id: str) -> None:
    """Refresh the event's cached health after a decision.

    Deciding an approval changes the inputs to the score — a pending approval that was
    ageing is no longer pending — so the cached band is refreshed here rather than waiting
    for somebody to open the command centre. Failure is swallowed: a stale health band is
    a cosmetic problem, and the decision itself has already succeeded.
    """
    try:
        from services.shared.aggregate import load_event_snapshot
        from services.shared.health import compute_health
        from services.shared.keys import event_sk

        snapshot = load_event_snapshot(
            ctx.organization_id, event_id, table_name=ctx.repo.table_name
        )
        result = compute_health(snapshot)
        ctx.repo.update_item(
            ctx.organization_id,
            event_sk(event_id),
            {
                "health_band": result.band.value,
                "health_score": result.score,
                "health_reasons": [r.detail for r in result.reasons],
                "health_computed_at": utc_now().isoformat(),
            },
        )
    except Exception:  # noqa: BLE001 - health refresh must never fail a decision
        logger.warning("Could not refresh event health after the decision", exc_info=True)
