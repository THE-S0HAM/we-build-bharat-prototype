"""Authoritative budget arithmetic.

Every rupee figure the leader sees and the agent quotes is produced here. The agent may
explain a number and predict the effect of a decision; it never computes one, because a
budget the model arrived at by reasoning is a budget nobody can reconcile.

Why optimistic concurrency rather than a conditional ``ADD``
-----------------------------------------------------------
The obvious way to hold "allocations must not exceed the total" is an atomic ``ADD`` with
a condition like ``allocated + :amount <= total_budget``. DynamoDB does not support that:
condition expressions compare attribute paths and values but have no arithmetic, so there
is no way to express a sum on the left-hand side.

The next idea fails more subtly. Pre-computing the ceiling in the caller and conditioning
on ``allocated <= :ceiling`` looks race-safe but is not: conditions are evaluated against
the item's pre-update state, so two concurrent ``+40,000`` writes against a 50,000 budget
both see ``allocated = 0``, both satisfy ``0 <= 10,000``, and both apply. The budget ends
up at 80,000 with no error raised anywhere.

So the invariant is held by optimistic concurrency instead: read the current counters,
compute the new values, and write them conditional on the counters still being exactly
what was read. A concurrent change makes the condition fail, and the operation retries
against fresh state. One writer wins, the other recomputes; neither silently overwrites.
That is what ``ConditionalCheckFailedException`` is for, and the retry bound stops a
pathological contention loop from running forever.

Multi-item atomicity
--------------------
Committing an amount touches the event budget *and* its category allocation. A budget
whose categories do not sum to its totals is worse than a rejected write, so both updates
go in one ``TransactWriteItems`` call. DynamoDB gives transactions serializable isolation,
so the two items move together or not at all.
"""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any

from services.shared.dynamodb import DynamoDBError, DynamoDBRepository
from services.shared.keys import (
    budget_allocation_prefix,
    budget_allocation_sk,
    budget_sk,
    event_gsi1pk,
    expense_gsi1sk,
    expense_sk,
)
from services.shared.models.base import ErrorCategory, utc_now
from services.shared.models.budget import BudgetCategory
from services.shared.validation import coerce_int, format_inr

logger = logging.getLogger(__name__)

MAIN_TABLE = os.environ.get("MAIN_TABLE", "CommunityOps-Main-dev")

# How many times a conditional write is recomputed against fresh state before giving up.
# Contention on one event's budget is low — a handful of leaders at most — so three
# attempts is generous. Failing after that surfaces a CONFLICT the caller can retry,
# which is preferable to looping while holding a Lambda invocation open.
MAX_WRITE_ATTEMPTS = 3

BUDGET_COUNTERS = ("total_budget", "allocated", "spent", "committed")


class BudgetError(Exception):
    """A budget operation that cannot proceed, with a user-safe explanation.

    Carries an :class:`~services.shared.models.base.ErrorCategory` so handlers map it to
    the right status code without re-deriving the reason.
    """

    def __init__(self, message: str, category: ErrorCategory = ErrorCategory.CONFLICT):
        super().__init__(message)
        self.message = message
        self.category = category


class BudgetSummary(dict):
    """A budget read, with derived figures already resolved.

    A plain ``dict`` subclass so it serializes directly into an API response while still
    offering named access at the call sites that do arithmetic on it.
    """

    @property
    def total_budget(self) -> int:
        return int(self["total_budget"])

    @property
    def remaining(self) -> int:
        return int(self["remaining"])

    @property
    def committed(self) -> int:
        return int(self["committed"])

    @property
    def spent(self) -> int:
        return int(self["spent"])


def _repo(table_name: str | None = None) -> DynamoDBRepository:
    return DynamoDBRepository(table_name or MAIN_TABLE)


def _counters(item: dict[str, Any]) -> dict[str, int]:
    """Read the money attributes back as plain ints.

    boto3 returns every DynamoDB Number as ``Decimal``. Coercing once here keeps
    ``Decimal`` out of the arithmetic, the JSON responses and the audit details, rather
    than handling it at every use site.
    """
    return {name: coerce_int(item.get(name)) for name in BUDGET_COUNTERS}


def _derive(
    total: int, allocated: int, spent: int, committed: int, currency: str
) -> dict[str, Any]:
    """Compute the figures that are never stored.

    ``remaining`` and ``utilization_percent`` are derived on every read because only the
    counters are maintained by writes; storing a total would add one more value that could
    fall out of step with the numbers it summarises.
    """
    return {
        "total_budget": total,
        "allocated": allocated,
        "spent": spent,
        "committed": committed,
        "remaining": total - spent - committed,
        "unallocated": total - allocated,
        "utilization_percent": (round((spent + committed) * 100 / total) if total > 0 else 0),
        "currency": currency,
    }


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def get_budget(
    organization_id: str, event_id: str, *, table_name: str | None = None
) -> BudgetSummary:
    """Read an event's budget and category allocations.

    An event with no budget record returns a zeroed summary with ``exists: False`` rather
    than raising. "No budget has been set" is a normal state for a draft event, and a
    caller asking how much is left should be told zero, not handed an error.
    """
    repo = _repo(table_name)
    item = repo.get_item(organization_id, budget_sk(event_id)) or {}
    allocations = repo.query_all(organization_id, budget_allocation_prefix(event_id))

    counters = _counters(item)
    currency = str(item.get("currency", "INR"))
    summary = BudgetSummary(
        _derive(
            counters["total_budget"],
            counters["allocated"],
            counters["spent"],
            counters["committed"],
            currency,
        )
    )

    categories = []
    for allocation in allocations:
        allocated = coerce_int(allocation.get("allocated"))
        spent = coerce_int(allocation.get("spent"))
        committed = coerce_int(allocation.get("committed"))
        categories.append(
            {
                "category": str(allocation.get("category", "OTHER")),
                "allocated": allocated,
                "spent": spent,
                "committed": committed,
                "remaining": allocated - spent - committed,
                "utilization_percent": (
                    round((spent + committed) * 100 / allocated) if allocated > 0 else 0
                ),
                "notes": str(allocation.get("notes", "")),
            }
        )
    categories.sort(key=lambda c: -c["allocated"])

    summary["event_id"] = event_id
    summary["categories"] = categories
    summary["exists"] = bool(item)
    return summary


def list_expenses(
    organization_id: str, event_id: str, *, table_name: str | None = None
) -> list[dict[str, Any]]:
    """Expenses for an event, newest first."""
    repo = _repo(table_name)
    items = repo.query_all(organization_id, expense_prefix_for(event_id), max_items=1000)
    return sorted(items, key=lambda e: str(e.get("created_at", "")), reverse=True)


def expense_prefix_for(event_id: str) -> str:
    from services.shared.keys import expense_prefix

    return expense_prefix(event_id)


# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------


def ensure_budget(
    organization_id: str,
    event_id: str,
    total_budget: int,
    *,
    actor_id: str = "system",
    table_name: str | None = None,
) -> BudgetSummary:
    """Create an event's budget record, or adjust its total.

    Lowering the total below what is already spent and committed is refused. Doing so
    would put the event immediately into overrun by bookkeeping alone, which hides the
    real question — whether that spending should be reversed — behind a number change.
    """
    repo = _repo(table_name)
    sk = budget_sk(event_id)
    now = utc_now().isoformat()

    existing = repo.get_item(organization_id, sk)
    if existing is None:
        repo.put_item(
            organization_id,
            sk,
            {
                "entity_type": "BUDGET",
                "event_id": event_id,
                "currency": "INR",
                "total_budget": total_budget,
                "allocated": 0,
                "spent": 0,
                "committed": 0,
                "notes": "",
                "created_at": now,
                "updated_at": now,
                "created_by": actor_id,
                "updated_by": actor_id,
                "GSI1PK": event_gsi1pk(organization_id, event_id),
                "GSI1SK": "BUDGET",
            },
        )
        return get_budget(organization_id, event_id, table_name=table_name)

    counters = _counters(existing)
    if total_budget < counters["spent"] + counters["committed"]:
        raise BudgetError(
            f"The total budget cannot be set below the "
            f"{format_inr(counters['spent'] + counters['committed'])} already spent and "
            f"committed. Release or reverse that spending first.",
            ErrorCategory.VALIDATION_ERROR,
        )

    repo.update_item(
        organization_id,
        sk,
        {"total_budget": total_budget, "updated_at": now, "updated_by": actor_id},
    )
    return get_budget(organization_id, event_id, table_name=table_name)


# ---------------------------------------------------------------------------
# Mutations — each holds its invariant with a conditional write
# ---------------------------------------------------------------------------


def _budget_update(
    organization_id: str,
    event_id: str,
    *,
    sets: dict[str, Any],
    expected: dict[str, int],
) -> dict[str, Any]:
    """Build a TransactWriteItems entry updating the event budget under a value guard.

    The condition pins every counter the caller read. Any concurrent change makes the
    transaction fail rather than letting this write flatten it.
    """
    names = {f"#n{i}": key for i, key in enumerate(sets)}
    values = {f":v{i}": value for i, value in enumerate(sets.values())}
    expression = "SET " + ", ".join(f"#n{i} = :v{i}" for i in range(len(sets)))

    condition_parts = []
    for i, (key, value) in enumerate(expected.items()):
        names[f"#c{i}"] = key
        values[f":c{i}"] = value
        condition_parts.append(f"#c{i} = :c{i}")

    return {
        "Update": {
            "TableName": "",  # filled in by the caller, which knows the table
            "Key": {"PK": organization_id, "SK": budget_sk(event_id)},
            "UpdateExpression": expression,
            "ConditionExpression": " AND ".join(condition_parts),
            "ExpressionAttributeNames": names,
            "ExpressionAttributeValues": values,
        }
    }


def _allocation_update(
    organization_id: str,
    event_id: str,
    category: str,
    *,
    sets: dict[str, Any],
    expected: dict[str, int] | None,
    create: bool,
) -> dict[str, Any]:
    """Build a TransactWriteItems entry for a category allocation.

    When ``create`` is set the entry is a ``Put`` guarded by ``attribute_not_exists``, so
    two callers racing to create the same category produce one record and one conflict
    rather than one record silently overwriting the other.
    """
    sk = budget_allocation_sk(event_id, category)
    if create:
        return {
            "Put": {
                "TableName": "",
                "Item": {"PK": organization_id, "SK": sk, **sets},
                "ConditionExpression": "attribute_not_exists(SK)",
            }
        }

    names = {f"#n{i}": key for i, key in enumerate(sets)}
    values = {f":v{i}": value for i, value in enumerate(sets.values())}
    expression = "SET " + ", ".join(f"#n{i} = :v{i}" for i in range(len(sets)))

    condition_parts = ["attribute_exists(SK)"]
    for i, (key, value) in enumerate((expected or {}).items()):
        names[f"#c{i}"] = key
        values[f":c{i}"] = value
        condition_parts.append(f"#c{i} = :c{i}")

    return {
        "Update": {
            "TableName": "",
            "Key": {"PK": organization_id, "SK": sk},
            "UpdateExpression": expression,
            "ConditionExpression": " AND ".join(condition_parts),
            "ExpressionAttributeNames": names,
            "ExpressionAttributeValues": values,
        }
    }


def _apply(repo: DynamoDBRepository, entries: list[dict[str, Any]]) -> None:
    """Fill in the table name and apply the transaction."""
    for entry in entries:
        for operation in entry.values():
            operation["TableName"] = repo.table_name
    repo.transact_write(entries)


def _load_pair(
    repo: DynamoDBRepository, organization_id: str, event_id: str, category: str
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Read the event budget and one category allocation together."""
    budget = repo.get_item(organization_id, budget_sk(event_id))
    if budget is None:
        raise BudgetError(
            "This event has no budget yet. Set a total budget before allocating or spending.",
            ErrorCategory.NOT_FOUND,
        )
    allocation = repo.get_item(organization_id, budget_allocation_sk(event_id, category))
    return budget, allocation


def _validated_category(category: str) -> str:
    try:
        return BudgetCategory(category.strip().upper()).value
    except ValueError as exc:
        valid = ", ".join(c.value for c in BudgetCategory)
        raise BudgetError(
            f"'{category}' is not a budget category. Use one of: {valid}.",
            ErrorCategory.VALIDATION_ERROR,
        ) from exc


def allocate(
    organization_id: str,
    event_id: str,
    category: str,
    amount: int,
    *,
    actor_id: str = "system",
    notes: str = "",
    table_name: str | None = None,
) -> BudgetSummary:
    """Set a category's allocation to ``amount``, holding the total-budget invariant.

    ``amount`` is the category's new absolute allocation, not a delta, because that is how
    a leader thinks about it: "Venue gets 50,000." The event-level ``allocated`` counter
    moves by the difference.

    Two invariants are enforced:

    * the sum of allocations may not exceed the event total;
    * a category's allocation may not drop below what it has already spent and committed,
      since that would mean money was spent against a budget line that no longer covers it.
    """
    category = _validated_category(category)
    if amount < 0:
        raise BudgetError("An allocation cannot be negative.", ErrorCategory.VALIDATION_ERROR)

    repo = _repo(table_name)
    now = utc_now().isoformat()

    for attempt in range(MAX_WRITE_ATTEMPTS):
        budget, allocation = _load_pair(repo, organization_id, event_id, category)
        counters = _counters(budget)

        current_allocated = coerce_int((allocation or {}).get("allocated"))
        category_spent = coerce_int((allocation or {}).get("spent"))
        category_committed = coerce_int((allocation or {}).get("committed"))

        if amount < category_spent + category_committed:
            raise BudgetError(
                f"{category} already has {format_inr(category_spent + category_committed)} "
                f"spent or committed, so its allocation cannot be reduced to "
                f"{format_inr(amount)}.",
                ErrorCategory.VALIDATION_ERROR,
            )

        delta = amount - current_allocated
        new_total_allocated = counters["allocated"] + delta
        if new_total_allocated > counters["total_budget"]:
            over = new_total_allocated - counters["total_budget"]
            raise BudgetError(
                f"Allocating {format_inr(amount)} to {category} would exceed the event "
                f"budget by {format_inr(over)}. "
                f"{format_inr(counters['total_budget'] - counters['allocated'])} is unallocated.",
                ErrorCategory.VALIDATION_ERROR,
            )

        entries = [
            _budget_update(
                organization_id,
                event_id,
                sets={
                    "allocated": new_total_allocated,
                    "updated_at": now,
                    "updated_by": actor_id,
                },
                expected={"allocated": counters["allocated"]},
            )
        ]

        if allocation is None:
            entries.append(
                _allocation_update(
                    organization_id,
                    event_id,
                    category,
                    sets={
                        "entity_type": "BUDGET_ALLOCATION",
                        "event_id": event_id,
                        "category": category,
                        "allocated": amount,
                        "spent": 0,
                        "committed": 0,
                        "notes": notes,
                        "created_at": now,
                        "updated_at": now,
                        "created_by": actor_id,
                        "updated_by": actor_id,
                        "GSI1PK": event_gsi1pk(organization_id, event_id),
                        "GSI1SK": f"BUDGETCAT#{category}",
                    },
                    expected=None,
                    create=True,
                )
            )
        else:
            sets: dict[str, Any] = {
                "allocated": amount,
                "updated_at": now,
                "updated_by": actor_id,
            }
            if notes:
                sets["notes"] = notes
            entries.append(
                _allocation_update(
                    organization_id,
                    event_id,
                    category,
                    sets=sets,
                    expected={"allocated": current_allocated},
                    create=False,
                )
            )

        try:
            _apply(repo, entries)
            return get_budget(organization_id, event_id, table_name=table_name)
        except DynamoDBError as exc:
            if exc.category is not ErrorCategory.CONFLICT or attempt == MAX_WRITE_ATTEMPTS - 1:
                raise BudgetError(
                    "The budget changed while this allocation was being applied. "
                    "Review the current figures and try again.",
                    ErrorCategory.CONFLICT,
                ) from exc
            logger.info("Allocation contended, recomputing", extra={"attempt": attempt + 1})

    raise BudgetError(  # pragma: no cover - loop always returns or raises
        "The allocation could not be applied.", ErrorCategory.CONFLICT
    )


def _move(
    organization_id: str,
    event_id: str,
    category: str,
    *,
    budget_deltas: dict[str, int],
    actor_id: str,
    require_category_headroom: int = 0,
    require_event_headroom: int = 0,
    table_name: str | None = None,
    failure_message: str,
) -> BudgetSummary:
    """Shared body for commit, release and spend.

    Each of those moves money between the same three counters under the same concurrency
    rules; only the deltas and the headroom checks differ. ``budget_deltas`` maps counter
    name to a signed change applied to both the event budget and the category allocation.

    ``require_*_headroom`` is the amount that must be available before the move. It is
    checked against freshly read values inside the retry loop, so a check that passed
    against stale state cannot let the write through.
    """
    category = _validated_category(category)
    repo = _repo(table_name)
    now = utc_now().isoformat()

    for attempt in range(MAX_WRITE_ATTEMPTS):
        budget, allocation = _load_pair(repo, organization_id, event_id, category)
        counters = _counters(budget)

        if allocation is None:
            raise BudgetError(
                f"{category} has no allocation yet. Allocate budget to it first.",
                ErrorCategory.NOT_FOUND,
            )

        category_allocated = coerce_int(allocation.get("allocated"))
        category_spent = coerce_int(allocation.get("spent"))
        category_committed = coerce_int(allocation.get("committed"))

        if require_event_headroom:
            available = counters["total_budget"] - counters["spent"] - counters["committed"]
            if require_event_headroom > available:
                raise BudgetError(
                    f"{failure_message} Only {format_inr(available)} of the "
                    f"{format_inr(counters['total_budget'])} event budget is uncommitted.",
                    ErrorCategory.CONFLICT,
                )

        if require_category_headroom:
            available = category_allocated - category_spent - category_committed
            if require_category_headroom > available:
                raise BudgetError(
                    f"{failure_message} {category} has {format_inr(available)} left of its "
                    f"{format_inr(category_allocated)} allocation.",
                    ErrorCategory.CONFLICT,
                )

        budget_sets: dict[str, Any] = {"updated_at": now, "updated_by": actor_id}
        allocation_sets: dict[str, Any] = {"updated_at": now, "updated_by": actor_id}
        budget_expected: dict[str, int] = {}
        allocation_expected: dict[str, int] = {}
        category_current = {
            "spent": category_spent,
            "committed": category_committed,
            "allocated": category_allocated,
        }

        for counter, delta in budget_deltas.items():
            new_budget_value = counters[counter] + delta
            new_category_value = category_current[counter] + delta
            if new_budget_value < 0 or new_category_value < 0:
                raise BudgetError(
                    f"{failure_message} It would take {counter} below zero.",
                    ErrorCategory.CONFLICT,
                )
            budget_sets[counter] = new_budget_value
            budget_expected[counter] = counters[counter]
            allocation_sets[counter] = new_category_value
            allocation_expected[counter] = category_current[counter]

        entries = [
            _budget_update(organization_id, event_id, sets=budget_sets, expected=budget_expected),
            _allocation_update(
                organization_id,
                event_id,
                category,
                sets=allocation_sets,
                expected=allocation_expected,
                create=False,
            ),
        ]

        try:
            _apply(repo, entries)
            return get_budget(organization_id, event_id, table_name=table_name)
        except DynamoDBError as exc:
            if exc.category is not ErrorCategory.CONFLICT or attempt == MAX_WRITE_ATTEMPTS - 1:
                raise BudgetError(
                    "The budget changed while this change was being applied. "
                    "Review the current figures and try again.",
                    ErrorCategory.CONFLICT,
                ) from exc
            logger.info("Budget move contended, recomputing", extra={"attempt": attempt + 1})

    raise BudgetError(  # pragma: no cover
        "The budget change could not be applied.", ErrorCategory.CONFLICT
    )


def commit(
    organization_id: str,
    event_id: str,
    category: str,
    amount: int,
    *,
    actor_id: str = "system",
    table_name: str | None = None,
) -> BudgetSummary:
    """Reserve ``amount`` against a category, reducing what remains.

    Called when a leader approves a financial request. The money is not gone, but it is no
    longer available, and the leader considering the *next* request needs to see that.
    """
    if amount <= 0:
        raise BudgetError("A committed amount must be positive.", ErrorCategory.VALIDATION_ERROR)
    return _move(
        organization_id,
        event_id,
        category,
        budget_deltas={"committed": amount},
        actor_id=actor_id,
        require_category_headroom=amount,
        require_event_headroom=amount,
        table_name=table_name,
        failure_message=f"Cannot commit {format_inr(amount)}.",
    )


def release(
    organization_id: str,
    event_id: str,
    category: str,
    amount: int,
    *,
    actor_id: str = "system",
    table_name: str | None = None,
) -> BudgetSummary:
    """Return a previously committed ``amount`` to the available balance.

    Used when an approved request is reversed or an expense comes in below its estimate.
    """
    if amount <= 0:
        raise BudgetError("A released amount must be positive.", ErrorCategory.VALIDATION_ERROR)
    return _move(
        organization_id,
        event_id,
        category,
        budget_deltas={"committed": -amount},
        actor_id=actor_id,
        table_name=table_name,
        failure_message=f"Cannot release {format_inr(amount)}.",
    )


def record_expense(
    organization_id: str,
    event_id: str,
    category: str,
    amount: int,
    description: str,
    *,
    actor_id: str = "system",
    approval_id: str | None = None,
    vendor: str = "",
    from_committed: bool = False,
    table_name: str | None = None,
) -> tuple[str, BudgetSummary]:
    """Record money actually spent, and return the expense id with the new totals.

    ``from_committed`` distinguishes the two ways money leaves a budget. When the spend
    was pre-approved the amount was already reserved, so it moves from ``committed`` to
    ``spent`` and the remaining balance does not change. Without it, the amount is spent
    straight out of the available balance. Getting this wrong would double-count a
    pre-approved expense — reserved once at approval and again at payment.

    The expense record is written before the counters move. If the counter update then
    fails, an orphan expense row exists with no effect on the totals, which is visible and
    correctable; the reverse order would move money with no record of why.
    """
    category = _validated_category(category)
    if amount <= 0:
        raise BudgetError("An expense amount must be positive.", ErrorCategory.VALIDATION_ERROR)
    description = description.strip()
    if not description:
        raise BudgetError("An expense needs a description.", ErrorCategory.VALIDATION_ERROR)

    repo = _repo(table_name)
    now = utc_now().isoformat()
    expense_id = f"EXP-{uuid.uuid4().hex[:8]}"

    repo.put_item(
        organization_id,
        expense_sk(event_id, expense_id),
        {
            "entity_type": "EXPENSE",
            "event_id": event_id,
            "expense_id": expense_id,
            "category": category,
            "amount_inr": amount,
            "description": description,
            "status": "RECORDED",
            "vendor": vendor,
            "approval_id": approval_id,
            "incurred_at": now,
            "recorded_by": actor_id,
            "created_at": now,
            "updated_at": now,
            "created_by": actor_id,
            "updated_by": actor_id,
            "GSI1PK": event_gsi1pk(organization_id, event_id),
            "GSI1SK": expense_gsi1sk(now),
        },
    )

    if from_committed:
        deltas = {"spent": amount, "committed": -amount}
        category_headroom = 0
        event_headroom = 0
    else:
        deltas = {"spent": amount}
        category_headroom = amount
        event_headroom = amount

    summary = _move(
        organization_id,
        event_id,
        category,
        budget_deltas=deltas,
        actor_id=actor_id,
        require_category_headroom=category_headroom,
        require_event_headroom=event_headroom,
        table_name=table_name,
        failure_message=f"Cannot record a {format_inr(amount)} expense.",
    )
    return expense_id, summary


# ---------------------------------------------------------------------------
# Prediction — used by the agent to answer "what happens if I approve this?"
# ---------------------------------------------------------------------------


def project_commitment(summary: BudgetSummary, category: str, amount: int) -> dict[str, Any]:
    """Compute the effect of committing ``amount``, without writing anything.

    This exists so the agent can answer "what happens if I approve this?" with the same
    arithmetic the write path uses, rather than estimating. It returns whether the move
    would be permitted and why, so the answer the leader reads matches what the button
    will actually do.
    """
    category = category.strip().upper()
    categories = {c["category"]: c for c in summary.get("categories", [])}
    line = categories.get(category)

    event_available = summary.remaining
    projected_remaining = event_available - amount
    projected_committed = summary.committed + amount
    total = summary.total_budget
    projected_utilization = (
        round((summary.spent + projected_committed) * 100 / total) if total > 0 else 0
    )

    blockers: list[str] = []
    if amount <= 0:
        blockers.append("The amount must be positive.")
    if amount > event_available:
        blockers.append(
            f"It exceeds the {format_inr(event_available)} uncommitted event budget by "
            f"{format_inr(amount - event_available)}."
        )
    if line is None:
        blockers.append(f"{category} has no allocation yet.")
    else:
        category_available = int(line["remaining"])
        if amount > category_available:
            blockers.append(
                f"{category} has only {format_inr(category_available)} left of its "
                f"{format_inr(int(line['allocated']))} allocation."
            )

    return {
        "category": category,
        "amount_inr": amount,
        "affordable": not blockers,
        "blockers": blockers,
        "current_remaining": event_available,
        "projected_remaining": projected_remaining,
        "current_committed": summary.committed,
        "projected_committed": projected_committed,
        "current_utilization_percent": summary["utilization_percent"],
        "projected_utilization_percent": projected_utilization,
        "impact_summary": (
            f"Remaining {format_inr(event_available)} -> {format_inr(projected_remaining)}"
        ),
    }
