"""Budget arithmetic and its invariants.

Money is the part of this system where being approximately right is the same as being wrong, so
these tests care about two things: that the figures reconcile exactly, and that the invariants
hold under concurrency rather than only in the happy path.

The concurrency tests are the important ones. The obvious implementation — read, add, write —
passes every sequential test and silently loses increments under contention, which is precisely
the bug that would be discovered by a budget that does not add up weeks later.
"""

from __future__ import annotations

import pytest

from services.shared import budget_service
from services.shared.budget_service import BudgetError
from services.shared.models.base import ErrorCategory
from tests.conftest import EVENT_ID, MAIN_TABLE, ORG_ID


@pytest.fixture
def budget(seeded):  # noqa: ANN001, ANN201
    return budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)


class TestSeededFigures:
    """The demo dataset has to reconcile, because the demo asserts specific numbers."""

    def test_the_headline_figures_are_exact(self, budget) -> None:  # noqa: ANN001
        assert budget.total_budget == 250_000
        assert budget.spent == 130_000
        assert budget.committed == 45_000
        assert budget.remaining == 75_000
        assert budget["utilization_percent"] == 70

    def test_categories_never_exceed_their_allocation(self, budget) -> None:  # noqa: ANN001
        for line in budget["categories"]:
            assert line["spent"] + line["committed"] <= line["allocated"], line

    def test_allocations_never_exceed_the_total(self, budget) -> None:  # noqa: ANN001
        assert budget["allocated"] <= budget.total_budget

    def test_approving_the_headline_request_lands_on_the_documented_figure(self, budget) -> None:  # noqa: ANN001
        """75,000 - 12,500 = 62,500, computed by the same code the approve button runs."""
        projection = budget_service.project_commitment(budget, "ACCOMMODATION", 12_500)
        assert projection["affordable"] is True
        assert projection["projected_remaining"] == 62_500


class TestCommit:
    def test_committing_reduces_remaining_without_changing_spent(self, seeded) -> None:  # noqa: ANN001
        before = budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        after = budget_service.commit(
            ORG_ID, EVENT_ID, "ACCOMMODATION", 12_500, table_name=MAIN_TABLE
        )
        assert after.committed == before.committed + 12_500
        assert after.spent == before.spent
        assert after.remaining == before.remaining - 12_500
        assert after.remaining == 62_500

    def test_committing_more_than_the_category_allows_is_refused(self, seeded) -> None:  # noqa: ANN001
        # ACCOMMODATION has 25,000 allocated and nothing committed.
        with pytest.raises(BudgetError) as exc:
            budget_service.commit(ORG_ID, EVENT_ID, "ACCOMMODATION", 30_000, table_name=MAIN_TABLE)
        assert exc.value.category is ErrorCategory.CONFLICT
        # The message names the actual headroom, so the caller knows what would fit.
        assert "25,000" in exc.value.message

    def test_a_refused_commit_changes_nothing(self, seeded) -> None:  # noqa: ANN001
        before = budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        with pytest.raises(BudgetError):
            budget_service.commit(ORG_ID, EVENT_ID, "ACCOMMODATION", 30_000, table_name=MAIN_TABLE)
        after = budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        assert after.committed == before.committed
        assert after.remaining == before.remaining

    def test_zero_and_negative_amounts_are_refused(self, seeded) -> None:  # noqa: ANN001
        for amount in (0, -100):
            with pytest.raises(BudgetError):
                budget_service.commit(
                    ORG_ID, EVENT_ID, "ACCOMMODATION", amount, table_name=MAIN_TABLE
                )

    def test_an_unknown_category_is_refused_with_the_valid_list(self, seeded) -> None:  # noqa: ANN001
        with pytest.raises(BudgetError) as exc:
            budget_service.commit(ORG_ID, EVENT_ID, "SNACKS", 100, table_name=MAIN_TABLE)
        assert exc.value.category is ErrorCategory.VALIDATION_ERROR
        assert "CATERING" in exc.value.message


class TestRelease:
    def test_releasing_returns_money_to_available(self, seeded) -> None:  # noqa: ANN001
        after_commit = budget_service.commit(
            ORG_ID, EVENT_ID, "ACCOMMODATION", 10_000, table_name=MAIN_TABLE
        )
        after_release = budget_service.release(
            ORG_ID, EVENT_ID, "ACCOMMODATION", 10_000, table_name=MAIN_TABLE
        )
        assert after_release.committed == after_commit.committed - 10_000
        assert after_release.remaining == 75_000

    def test_releasing_more_than_is_committed_is_refused(self, seeded) -> None:  # noqa: ANN001
        """Releasing into negative committed would invent money."""
        with pytest.raises(BudgetError):
            budget_service.release(ORG_ID, EVENT_ID, "ACCOMMODATION", 5_000, table_name=MAIN_TABLE)


class TestExpenses:
    def test_a_fresh_expense_reduces_remaining(self, seeded) -> None:  # noqa: ANN001
        before = budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        _, after = budget_service.record_expense(
            ORG_ID,
            EVENT_ID,
            "ACCOMMODATION",
            5_000,
            "Test booking",
            table_name=MAIN_TABLE,
        )
        assert after.spent == before.spent + 5_000
        assert after.remaining == before.remaining - 5_000

    def test_a_pre_approved_expense_does_not_deduct_twice(self, seeded) -> None:  # noqa: ANN001
        """The double-count bug this flag exists to prevent.

        Money reserved at approval and then spent must leave the remaining balance unchanged: it
        was already taken out of circulation once.
        """
        committed = budget_service.commit(
            ORG_ID, EVENT_ID, "ACCOMMODATION", 12_500, table_name=MAIN_TABLE
        )
        _, after = budget_service.record_expense(
            ORG_ID,
            EVENT_ID,
            "ACCOMMODATION",
            12_500,
            "Approved accommodation",
            from_committed=True,
            table_name=MAIN_TABLE,
        )
        assert after.spent == committed.spent + 12_500
        assert after.committed == committed.committed - 12_500
        # The balance is unchanged because the money was already committed.
        assert after.remaining == committed.remaining

    def test_an_expense_is_recorded_even_though_it_is_written_first(self, seeded) -> None:  # noqa: ANN001
        expense_id, _ = budget_service.record_expense(
            ORG_ID, EVENT_ID, "EMERGENCY", 1_000, "Contingency", table_name=MAIN_TABLE
        )
        expenses = budget_service.list_expenses(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        assert any(e["expense_id"] == expense_id for e in expenses)

    def test_an_expense_needs_a_description(self, seeded) -> None:  # noqa: ANN001
        with pytest.raises(BudgetError):
            budget_service.record_expense(
                ORG_ID, EVENT_ID, "EMERGENCY", 1_000, "   ", table_name=MAIN_TABLE
            )


class TestAllocation:
    def test_allocation_is_absolute_and_moves_the_total_by_the_difference(self, seeded) -> None:  # noqa: ANN001
        """A leader says "Venue gets 60,000", not "add 5,000 to Venue"."""
        before = budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        venue_before = next(c for c in before["categories"] if c["category"] == "VENUE")
        after = budget_service.allocate(ORG_ID, EVENT_ID, "VENUE", 60_000, table_name=MAIN_TABLE)
        venue_after = next(c for c in after["categories"] if c["category"] == "VENUE")
        assert venue_after["allocated"] == 60_000
        assert after["allocated"] == before["allocated"] + (60_000 - venue_before["allocated"])

    def test_over_allocating_the_event_budget_is_refused(self, seeded) -> None:  # noqa: ANN001
        """The invariant DynamoDB cannot express as a condition expression."""
        with pytest.raises(BudgetError) as exc:
            budget_service.allocate(ORG_ID, EVENT_ID, "EMERGENCY", 200_000, table_name=MAIN_TABLE)
        assert "exceed" in exc.value.message.lower()

    def test_allocation_cannot_drop_below_committed_spend(self, seeded) -> None:  # noqa: ANN001
        """VENUE has 50,000 spent; allocating 10,000 to it would strand that spending."""
        with pytest.raises(BudgetError) as exc:
            budget_service.allocate(ORG_ID, EVENT_ID, "VENUE", 10_000, table_name=MAIN_TABLE)
        assert exc.value.category is ErrorCategory.VALIDATION_ERROR

    def test_allocating_to_a_new_category_creates_it(self, seeded) -> None:  # noqa: ANN001
        after = budget_service.allocate(
            ORG_ID, EVENT_ID, "CERTIFICATES", 6_000, table_name=MAIN_TABLE
        )
        line = next(c for c in after["categories"] if c["category"] == "CERTIFICATES")
        assert line["allocated"] == 6_000


class TestTotalBudget:
    def test_lowering_the_total_below_existing_spend_is_refused(self, seeded) -> None:  # noqa: ANN001
        """Otherwise the event goes into overrun by bookkeeping alone."""
        with pytest.raises(BudgetError) as exc:
            budget_service.ensure_budget(ORG_ID, EVENT_ID, 50_000, table_name=MAIN_TABLE)
        assert "already spent and committed" in exc.value.message

    def test_raising_the_total_increases_remaining(self, seeded) -> None:  # noqa: ANN001
        after = budget_service.ensure_budget(ORG_ID, EVENT_ID, 300_000, table_name=MAIN_TABLE)
        assert after.remaining == 125_000

    def test_an_event_with_no_budget_reads_as_zero_not_an_error(self, seeded) -> None:  # noqa: ANN001
        """ "No budget set" is a normal state for a draft event."""
        summary = budget_service.get_budget(ORG_ID, "EVT-nonexistent", table_name=MAIN_TABLE)
        assert summary["exists"] is False
        assert summary.remaining == 0


class TestProjection:
    def test_projection_writes_nothing(self, seeded) -> None:  # noqa: ANN001
        before = budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        budget_service.project_commitment(before, "ACCOMMODATION", 12_500)
        after = budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        assert after.remaining == before.remaining
        assert after.committed == before.committed

    def test_projection_agrees_with_what_the_write_actually_does(self, seeded) -> None:  # noqa: ANN001
        """The preview a leader reads must match the result of pressing the button."""
        before = budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        projection = budget_service.project_commitment(before, "ACCOMMODATION", 12_500)
        after = budget_service.commit(
            ORG_ID, EVENT_ID, "ACCOMMODATION", 12_500, table_name=MAIN_TABLE
        )
        assert projection["projected_remaining"] == after.remaining
        assert projection["projected_committed"] == after.committed
        assert projection["projected_utilization_percent"] == after["utilization_percent"]

    def test_an_unaffordable_request_is_reported_with_reasons(self, seeded) -> None:  # noqa: ANN001
        before = budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        projection = budget_service.project_commitment(before, "ACCOMMODATION", 90_000)
        assert projection["affordable"] is False
        assert projection["blockers"]

    def test_a_category_with_no_allocation_blocks_the_projection(self, seeded) -> None:  # noqa: ANN001
        before = budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        # Nothing has been allocated to OTHER in the demo dataset.
        projection = budget_service.project_commitment(before, "OTHER", 1_000)
        assert projection["affordable"] is False
        assert any("no allocation" in b for b in projection["blockers"])


class TestConcurrency:
    def test_a_stale_write_is_refused_rather_than_applied(self, seeded, monkeypatch) -> None:  # noqa: ANN001
        """Optimistic concurrency, which is what holds the invariant.

        A conditional ``ADD`` cannot express "allocated + amount <= total" because DynamoDB
        condition expressions have no arithmetic, and pre-computing the ceiling is not race-safe:
        conditions evaluate against pre-update state, so two concurrent writes both pass.

        This simulates the interleaving. A second committer changes the budget between the first
        committer's read and its write; the first must fail its condition and retry against fresh
        state rather than flattening the change.
        """
        from services.shared.dynamodb import DynamoDBRepository

        original_get = DynamoDBRepository.get_item
        interference = {"fired": False}

        def interfering_get(self, organization_id, sk):  # noqa: ANN001, ANN202
            item = original_get(self, organization_id, sk)
            # After the caller reads the budget, a competing commit lands.
            if sk.endswith("#BUDGET") and not interference["fired"]:
                interference["fired"] = True
                budget_service.commit(
                    ORG_ID, EVENT_ID, "ACCOMMODATION", 5_000, table_name=MAIN_TABLE
                )
            return item

        monkeypatch.setattr(DynamoDBRepository, "get_item", interfering_get)

        result = budget_service.commit(
            ORG_ID, EVENT_ID, "ACCOMMODATION", 10_000, table_name=MAIN_TABLE
        )

        # Both commits are present. Neither was lost, which a read-modify-write would have done.
        assert result.committed == 45_000 + 5_000 + 10_000
        assert result.remaining == 75_000 - 15_000

    def test_retries_are_bounded(self, seeded, monkeypatch) -> None:  # noqa: ANN001
        """Persistent contention surfaces as a CONFLICT rather than looping forever."""
        from services.shared.dynamodb import DynamoDBError, DynamoDBRepository

        def always_conflict(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
            raise DynamoDBError("simulated contention", ErrorCategory.CONFLICT)

        monkeypatch.setattr(DynamoDBRepository, "transact_write", always_conflict)

        with pytest.raises(BudgetError) as exc:
            budget_service.commit(ORG_ID, EVENT_ID, "ACCOMMODATION", 1_000, table_name=MAIN_TABLE)
        assert exc.value.category is ErrorCategory.CONFLICT
