"""Event budget, allocations and expenses.

Routes:
    GET  /events/{eventId}/budget                  budget with category breakdown
    PUT  /events/{eventId}/budget                  set the total budget      (leader)
    POST /events/{eventId}/budget/allocations      allocate to a category    (leader)
    GET  /events/{eventId}/budget/expenses         list expenses
    POST /events/{eventId}/budget/expenses         record an expense         (leader)
    POST /events/{eventId}/budget/projection       preview a commitment, writes nothing

Every mutation here is HIGH risk under the policy catalogue, so a leader performing one
directly is the human approval. What the *agent* may not do is call these paths on its own:
its budget tools create an ``Approval`` and stop. The distinction matters — this handler
requires a leader token, and the agent never has one of its own.

Reads are open to team members so a volunteer can see what their team has left to spend,
but the figures are computed by ``budget_service`` in every case. There is no second
arithmetic implementation here that could disagree with it.
"""

from __future__ import annotations

import logging
from typing import Any

from services.api._common import (
    begin_request,
    handle_dynamodb_errors,
    path_param,
    require_fields,
)
from services.shared import budget_service
from services.shared.api_response import error, success
from services.shared.audit import create_audit_event
from services.shared.budget_service import BudgetError
from services.shared.models.base import ErrorCategory
from services.shared.models.budget import BudgetCategory
from services.shared.principal import Role, authorize_scope
from services.shared.validation import format_inr, sanitize_text, validate_amount_inr

logger = logging.getLogger(__name__)


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    method = event.get("httpMethod", "GET")
    event_id = path_param(event, "eventId")
    path = str(event.get("resource") or event.get("path") or "")

    if "/allocations" in path:
        if method == "POST":
            return allocate(event, event_id)
        return error(ErrorCategory.VALIDATION_ERROR, "Unsupported allocation operation")

    if "/expenses" in path:
        if method == "GET":
            return list_expenses(event, event_id)
        if method == "POST":
            return record_expense(event, event_id)
        return error(ErrorCategory.VALIDATION_ERROR, "Unsupported expense operation")

    if "/projection" in path:
        if method == "POST":
            return project(event, event_id)
        return error(ErrorCategory.VALIDATION_ERROR, "Unsupported projection operation")

    if method == "GET":
        return get_budget(event, event_id)
    if method == "PUT":
        return set_total(event, event_id)

    return error(ErrorCategory.VALIDATION_ERROR, "Unsupported operation")


def _budget_error(exc: BudgetError) -> dict[str, Any]:
    """Map a budget refusal to its API response.

    ``BudgetError`` already carries the category and a message written for the person who
    will read it, so nothing is re-derived here.
    """
    logger.info("Budget operation refused: %s", exc.message)
    return error(exc.category, exc.message)


@handle_dynamodb_errors
def get_budget(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    if not event_id:
        return error(ErrorCategory.VALIDATION_ERROR, "eventId is required")

    scope_denied = authorize_scope(ctx.principal, event_id=event_id)
    if scope_denied:
        return scope_denied

    summary = budget_service.get_budget(
        ctx.organization_id, event_id, table_name=ctx.repo.table_name
    )
    return success(
        {
            **summary,
            # A formatted figure travels with the raw one so the console and the agent
            # render the same grouping rather than each inventing their own.
            "total_budget_formatted": format_inr(summary.total_budget),
            "remaining_formatted": format_inr(summary.remaining),
            "categories_available": [c.value for c in BudgetCategory],
        }
    )


@handle_dynamodb_errors
def set_total(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Set or adjust the event's total budget."""
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    missing = require_fields(ctx.body, "total_budget")
    if missing:
        return missing

    total = validate_amount_inr(ctx.body["total_budget"])
    if total is None:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            "total_budget must be a whole number of rupees, zero or more.",
        )

    try:
        summary = budget_service.ensure_budget(
            ctx.organization_id,
            event_id,
            total,
            actor_id=ctx.user_id,
            table_name=ctx.repo.table_name,
        )
    except BudgetError as exc:
        return _budget_error(exc)

    create_audit_event(
        organization_id=ctx.organization_id,
        action="BUDGET_TOTAL_SET",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Budget",
        resource_id=event_id,
        event_id=event_id,
        details={"total_budget": total},
        policy_evaluated="AllocateBudget",
    )
    return success({**summary, "message": f"Total budget set to {format_inr(total)}"})


@handle_dynamodb_errors
def allocate(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Allocate budget to a category."""
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    missing = require_fields(ctx.body, "category", "amount_inr")
    if missing:
        return missing

    amount = validate_amount_inr(ctx.body["amount_inr"])
    if amount is None:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            "amount_inr must be a whole number of rupees, zero or more.",
        )

    try:
        summary = budget_service.allocate(
            ctx.organization_id,
            event_id,
            str(ctx.body["category"]),
            amount,
            actor_id=ctx.user_id,
            notes=sanitize_text(str(ctx.body.get("notes", "")), 500),
            table_name=ctx.repo.table_name,
        )
    except BudgetError as exc:
        return _budget_error(exc)

    create_audit_event(
        organization_id=ctx.organization_id,
        action="BUDGET_ALLOCATED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="BudgetAllocation",
        resource_id=str(ctx.body["category"]).upper(),
        event_id=event_id,
        details={"amount_inr": amount, "unallocated_after": summary["unallocated"]},
        policy_evaluated="AllocateBudget",
    )
    return success(
        {
            **summary,
            "message": (
                f"{str(ctx.body['category']).upper()} allocated {format_inr(amount)}. "
                f"{format_inr(summary['unallocated'])} still unallocated."
            ),
        }
    )


@handle_dynamodb_errors
def list_expenses(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    scope_denied = authorize_scope(ctx.principal, event_id=event_id)
    if scope_denied:
        return scope_denied

    expenses = budget_service.list_expenses(
        ctx.organization_id, event_id, table_name=ctx.repo.table_name
    )
    total = sum(int(e.get("amount_inr", 0)) for e in expenses)
    return success({"expenses": expenses, "count": len(expenses), "total_inr": total})


@handle_dynamodb_errors
def record_expense(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Record money spent.

    ``approval_id`` is how a pre-approved spend is distinguished from a new one. When it
    references an approved request the amount is already reserved, so it moves from
    committed to spent rather than being deducted a second time. Without that check a
    pre-approved expense would be counted twice: once when approved, once when paid.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    missing = require_fields(ctx.body, "category", "amount_inr", "description")
    if missing:
        return missing

    amount = validate_amount_inr(ctx.body["amount_inr"])
    if amount is None or amount == 0:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            "amount_inr must be a positive whole number of rupees.",
        )

    approval_id = str(ctx.body.get("approval_id", "")).strip() or None
    from_committed = False

    if approval_id:
        from services.shared.keys import approval_sk

        approval = ctx.repo.get_item(ctx.organization_id, approval_sk(event_id, approval_id))
        if approval is None:
            return error(ErrorCategory.NOT_FOUND, f"Approval {approval_id} not found")
        if str(approval.get("status")) != "APPROVED":
            return error(
                ErrorCategory.CONFLICT,
                f"Approval {approval_id} is {approval.get('status')}, not APPROVED, so its "
                "amount was never committed.",
            )
        from_committed = True

    try:
        expense_id, summary = budget_service.record_expense(
            ctx.organization_id,
            event_id,
            str(ctx.body["category"]),
            amount,
            sanitize_text(str(ctx.body["description"]), 500),
            actor_id=ctx.user_id,
            approval_id=approval_id,
            vendor=sanitize_text(str(ctx.body.get("vendor", "")), 200),
            from_committed=from_committed,
            table_name=ctx.repo.table_name,
        )
    except BudgetError as exc:
        return _budget_error(exc)

    create_audit_event(
        organization_id=ctx.organization_id,
        action="EXPENSE_RECORDED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Expense",
        resource_id=expense_id,
        event_id=event_id,
        details={
            "amount_inr": amount,
            "category": str(ctx.body["category"]).upper(),
            "from_committed": from_committed,
            "remaining_after": summary.remaining,
        },
        approval_id=approval_id,
        policy_evaluated="RecordExpense",
    )

    _warn_if_budget_tight(ctx.organization_id, event_id, summary, ctx.user_id)

    return success(
        {
            "expense_id": expense_id,
            "budget": summary,
            "message": (
                f"Recorded {format_inr(amount)}. {format_inr(summary.remaining)} remaining."
            ),
        },
        status_code=201,
    )


@handle_dynamodb_errors
def project(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Preview the effect of committing an amount, without writing anything.

    This is what answers "can we afford this?" and "what happens if I approve it?". It
    deliberately runs the same arithmetic as the write path, so the preview the leader
    reads matches what the approve button will actually do.
    """
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    scope_denied = authorize_scope(ctx.principal, event_id=event_id)
    if scope_denied:
        return scope_denied

    missing = require_fields(ctx.body, "category", "amount_inr")
    if missing:
        return missing

    amount = validate_amount_inr(ctx.body["amount_inr"])
    if amount is None:
        return error(ErrorCategory.VALIDATION_ERROR, "amount_inr must be a whole number of rupees.")

    summary = budget_service.get_budget(
        ctx.organization_id, event_id, table_name=ctx.repo.table_name
    )
    projection = budget_service.project_commitment(summary, str(ctx.body["category"]), amount)
    return success({"projection": projection, "budget": summary})


def _warn_if_budget_tight(
    organization_id: str, event_id: str, summary: budget_service.BudgetSummary, actor_id: str
) -> None:
    """Notify the leader when utilization crosses into warning territory.

    Only fired at the crossing points rather than on every spend, so the notification
    means "this just changed" instead of becoming background noise that gets ignored.
    """
    utilization = summary["utilization_percent"]
    if utilization < 75:
        return

    from services.shared.models.notification import NotificationSeverity, NotificationType
    from services.shared.notify import notify

    notify(
        organization_id,
        actor_id,
        NotificationType.BUDGET_WARNING,
        f"Budget {utilization}% utilized",
        body=(
            f"{format_inr(summary.remaining)} of "
            f"{format_inr(summary.total_budget)} remains for this event."
        ),
        event_id=event_id,
        resource_type="Budget",
        resource_id=event_id,
        severity=(
            NotificationSeverity.CRITICAL if utilization >= 90 else NotificationSeverity.WARNING
        ),
        actor_id=actor_id,
    )
