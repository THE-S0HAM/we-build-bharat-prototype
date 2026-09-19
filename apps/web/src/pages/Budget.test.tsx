/**
 * Tests for the Budget screen.
 *
 * The rule under test is that this page performs no arithmetic. Every figure it shows is read from
 * the backend, which derives them on each read in `budget_service._derive`.
 *
 * Proving a negative takes a deliberately inconsistent fixture: the stub reports a `remaining` and a
 * `utilization_percent` that do not follow from the other numbers. A page that displays gets them
 * right; a page that recalculates gets them wrong. In production the two agree, so this is the only
 * point at which the difference is observable.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import { BUDGET_BEFORE, EVENT_ID } from "../test/fixtures";

const getBudget = vi.fn();
const getExpenses = vi.fn();
const projectBudget = vi.fn();

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getBudget: (...args: unknown[]) => getBudget(...args),
    getExpenses: (...args: unknown[]) => getExpenses(...args),
    projectBudget: (...args: unknown[]) => projectBudget(...args),
  };
});

const { BudgetPage } = await import("./Budget");

function renderPage(role: "LEADER" | "TEAM_MEMBER" = "LEADER") {
  return render(<BudgetPage eventId={EVENT_ID} role={role} />);
}

beforeEach(() => {
  getBudget.mockResolvedValue(BUDGET_BEFORE);
  getExpenses.mockResolvedValue({
    expenses: [
      {
        expense_id: "EXP-001",
        event_id: EVENT_ID,
        category: "EQUIPMENT",
        amount_inr: 30000,
        description: "Stage lighting rental",
        status: "PAID",
        vendor: "Pune AV Hire",
        approval_id: "APR-006",
      },
    ],
    count: 1,
    total_inr: 30000,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("figures come from the backend", () => {
  it("renders the seeded state as the backend reports it", async () => {
    renderPage();

    expect(await screen.findByText("₹75,000")).toBeInTheDocument();
    expect(screen.getByText("₹1,30,000")).toBeInTheDocument();
    expect(screen.getByText("₹45,000")).toBeInTheDocument();
    expect(screen.getByText("70%")).toBeInTheDocument();
  });

  it("displays a remaining figure that local arithmetic would not produce", async () => {
    // 2,50,000 − 1,30,000 − 45,000 would be 75,000. The backend says 71,000.
    getBudget.mockResolvedValue({ ...BUDGET_BEFORE, remaining: 71000, utilization_percent: 72 });

    renderPage();

    expect(await screen.findByText("₹71,000")).toBeInTheDocument();
    expect(screen.getByText("72%")).toBeInTheDocument();
    expect(screen.queryByText("₹75,000")).not.toBeInTheDocument();
  });

  it("shows each category's headroom as reported, not recomputed", async () => {
    renderPage();
    await screen.findByText("₹75,000");

    // EQUIPMENT: 40,000 allocated, 30,000 spent, 8,000 committed, 2,000 left. "Equipment" also
    // appears in the projection dropdown and the expense table, so the row is located by its own
    // class rather than by the name alone.
    const rowTitles = document.querySelectorAll(".row-title");
    expect([...rowTitles].map((n) => n.textContent)).toEqual(["Accommodation", "Equipment"]);
    expect(screen.getByText("₹2,000")).toBeInTheDocument();
    expect(screen.getByText("₹25,000")).toBeInTheDocument();
  });

  it("flags a category that is over its allocation", async () => {
    getBudget.mockResolvedValue({
      ...BUDGET_BEFORE,
      categories: [
        {
          category: "EQUIPMENT",
          allocated: 40000,
          spent: 39000,
          committed: 6000,
          remaining: -5000,
          utilization_percent: 113,
        },
      ],
    });

    renderPage();
    expect(await screen.findByText("Over")).toBeInTheDocument();
  });
});

describe("warnings", () => {
  it("stays quiet below the warning threshold", async () => {
    renderPage();
    await screen.findByText("₹75,000");
    expect(screen.queryByText(/% utilized\./i)).not.toBeInTheDocument();
  });

  it("warns once utilization reaches the backend's own threshold", async () => {
    // 75% is where `_warn_if_budget_tight` starts notifying, so the screen agrees with it.
    getBudget.mockResolvedValue({ ...BUDGET_BEFORE, utilization_percent: 82, remaining: 45000 });
    renderPage();
    expect(await screen.findByText(/This event is 82% utilized/i)).toBeInTheDocument();
  });
});

describe("no budget set", () => {
  it("says so rather than showing zeroes as if the money were gone", async () => {
    getBudget.mockResolvedValue({
      currency: "INR",
      total_budget: 0,
      allocated: 0,
      spent: 0,
      committed: 0,
      remaining: 0,
      unallocated: 0,
      utilization_percent: 0,
      categories: [],
      exists: false,
    });

    renderPage();
    expect(await screen.findByText(/No budget set/i)).toBeInTheDocument();
  });

  it("tells a team member who can set one", async () => {
    getBudget.mockResolvedValue({
      currency: "INR",
      total_budget: 0,
      allocated: 0,
      spent: 0,
      committed: 0,
      remaining: 0,
      unallocated: 0,
      utilization_percent: 0,
      categories: [],
      exists: false,
    });

    renderPage("TEAM_MEMBER");
    expect(
      await screen.findByText(/A community leader has not set a budget for this event yet/i),
    ).toBeInTheDocument();
  });
});

describe("affordability preview", () => {
  it("asks the backend rather than subtracting", async () => {
    projectBudget.mockResolvedValue({
      projection: {
        category: "EQUIPMENT",
        amount_inr: 7000,
        affordable: false,
        blockers: ["EQUIPMENT has 2,000 left; this needs 7,000."],
        current_remaining: 75000,
        projected_remaining: 68000,
        current_committed: 45000,
        projected_committed: 52000,
        current_utilization_percent: 70,
        projected_utilization_percent: 73,
        impact_summary: "Not affordable within EQUIPMENT.",
      },
      budget: BUDGET_BEFORE,
    });

    renderPage();
    await screen.findByText("₹75,000");

    await userEvent.selectOptions(screen.getByLabelText(/Category/i), "EQUIPMENT");
    await userEvent.type(screen.getByLabelText(/Amount in rupees/i), "7000");
    await userEvent.click(screen.getByRole("button", { name: /^Check$/ }));

    expect(await screen.findByText(/Not affordable within EQUIPMENT/i)).toBeInTheDocument();
    expect(screen.getByText(/EQUIPMENT has 2,000 left/i)).toBeInTheDocument();
    expect(projectBudget).toHaveBeenCalledWith(EVENT_ID, "EQUIPMENT", 7000);
  });

  it("rejects a non-numeric amount without calling the backend", async () => {
    renderPage();
    await screen.findByText("₹75,000");

    await userEvent.type(screen.getByLabelText(/Amount in rupees/i), "lots");
    await userEvent.click(screen.getByRole("button", { name: /^Check$/ }));

    expect(await screen.findByText(/Enter a whole number of rupees/i)).toBeInTheDocument();
    expect(projectBudget).not.toHaveBeenCalled();
  });

  it("is not offered to a team member, who cannot commit money", async () => {
    renderPage("TEAM_MEMBER");
    await screen.findByText("₹75,000");
    expect(screen.queryByLabelText(/Amount in rupees/i)).not.toBeInTheDocument();
  });
});

describe("resilience", () => {
  it("keeps the totals when the expense list fails", async () => {
    getExpenses.mockRejectedValue(new ApiError("unavailable", 503));
    renderPage();

    expect(await screen.findByText("₹75,000")).toBeInTheDocument();
    expect(screen.getByText(/No expenses recorded/i)).toBeInTheDocument();
  });

  it("surfaces a budget read failure rather than showing zero", async () => {
    getBudget.mockRejectedValue(new ApiError("Budget is unavailable right now.", 503));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Budget is unavailable/);
  });
});
