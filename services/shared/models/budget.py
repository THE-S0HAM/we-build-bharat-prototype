"""Budget models for event financial operations.

Money rule: every amount is an integer number of rupees. DynamoDB stores them as
Number attributes and boto3 returns them as ``Decimal``, so the read path coerces to
``int`` at the boundary. Floating point is never used for money.

Derived rule: ``remaining`` and ``utilization_percent`` are computed from
``total_budget``, ``spent`` and ``committed`` rather than stored, so they can never
drift out of step with the counters that atomic writes actually update.
"""

from datetime import datetime
from enum import Enum

from pydantic import Field

from services.shared.models.base import DomainEntity


class BudgetCategory(str, Enum):
    """Spending categories for a community event."""

    VENUE = "VENUE"
    CATERING = "CATERING"
    SPEAKER_TRAVEL = "SPEAKER_TRAVEL"
    ACCOMMODATION = "ACCOMMODATION"
    EQUIPMENT = "EQUIPMENT"
    MARKETING = "MARKETING"
    CERTIFICATES = "CERTIFICATES"
    TRANSPORTATION = "TRANSPORTATION"
    EMERGENCY = "EMERGENCY"
    OTHER = "OTHER"


class ExpenseStatus(str, Enum):
    RECORDED = "RECORDED"
    REIMBURSED = "REIMBURSED"
    REJECTED = "REJECTED"


class Budget(DomainEntity):
    """The financial envelope for one event.

    One record per event. ``allocated`` is the sum of category allocations,
    ``committed`` is approved-but-unspent, ``spent`` is money gone.
    """

    event_id: str = Field(..., min_length=1)
    currency: str = Field(default="INR", max_length=3)
    total_budget: int = Field(default=0, ge=0, description="Whole rupees")
    allocated: int = Field(default=0, ge=0, description="Sum of category allocations")
    spent: int = Field(default=0, ge=0)
    committed: int = Field(default=0, ge=0, description="Approved but not yet spent")
    notes: str = ""

    @property
    def remaining(self) -> int:
        """Money not yet spent or committed. Derived, never stored."""
        return self.total_budget - self.spent - self.committed

    @property
    def unallocated(self) -> int:
        """Total budget that has not been assigned to any category."""
        return self.total_budget - self.allocated

    @property
    def utilization_percent(self) -> int:
        """Share of the total budget that is spent or committed, 0-100."""
        if self.total_budget <= 0:
            return 0
        return round((self.spent + self.committed) * 100 / self.total_budget)


class BudgetAllocation(DomainEntity):
    """Budget assigned to one spending category of one event."""

    event_id: str = Field(..., min_length=1)
    category: BudgetCategory
    allocated: int = Field(default=0, ge=0)
    spent: int = Field(default=0, ge=0)
    committed: int = Field(default=0, ge=0)
    notes: str = ""

    @property
    def remaining(self) -> int:
        return self.allocated - self.spent - self.committed

    @property
    def utilization_percent(self) -> int:
        if self.allocated <= 0:
            return 0
        return round((self.spent + self.committed) * 100 / self.allocated)


class Expense(DomainEntity):
    """A recorded expense against a budget category.

    An expense moves money from ``committed`` (when it came from an approval) or
    directly from ``remaining`` into ``spent``.
    """

    event_id: str = Field(..., min_length=1)
    expense_id: str = Field(..., min_length=1)
    category: BudgetCategory
    amount_inr: int = Field(..., gt=0, description="Whole rupees, must be positive")
    description: str = Field(..., min_length=1, max_length=500)
    status: ExpenseStatus = ExpenseStatus.RECORDED
    vendor: str = ""
    approval_id: str | None = Field(
        default=None, description="Set when the expense was pre-approved"
    )
    incurred_at: datetime | None = None
    recorded_by: str = ""
    receipt_document_id: str | None = None
    notes: str = ""
