import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionContext, type SessionValue } from "../session/sessionContext";
import type { BudgetSummary, Role } from "../types";
import { Budget } from "./Budget";

const api = vi.hoisted(() => ({
  getBudget: vi.fn(),
  getExpenses: vi.fn(),
  projectBudget: vi.fn(),
  setBudget: vi.fn(),
  allocateBudget: vi.fn(),
  recordExpense: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getBudget: api.getBudget,
  getExpenses: api.getExpenses,
  projectBudget: api.projectBudget,
  setBudget: api.setBudget,
  allocateBudget: api.allocateBudget,
  recordExpense: api.recordExpense,
}));

const BUDGET: BudgetSummary = {
  event_id: "EVT-1",
  currency: "INR",
  total_budget: 100000,
  allocated: 90000,
  spent: 15000,
  committed: 10000,
  remaining: 75000,
  unallocated: 10000,
  utilization_percent: 25,
  categories: [{ category: "VENUE", allocated: 50000, spent: 15000, committed: 10000, remaining: 25000, utilization_percent: 50 }],
  exists: true,
  total_budget_formatted: "1,00,000",
  remaining_formatted: "75,000",
  categories_available: ["VENUE", "CATERING"],
};

const UPDATED_BUDGET: BudgetSummary = {
  ...BUDGET,
  total_budget: 110000,
  remaining: 85000,
  unallocated: 20000,
  total_budget_formatted: "1,10,000",
  remaining_formatted: "85,000",
};

const NO_BUDGET: BudgetSummary = {
  ...BUDGET,
  total_budget: 0,
  allocated: 0,
  spent: 0,
  committed: 0,
  remaining: 0,
  unallocated: 0,
  utilization_percent: 0,
  categories: [],
  exists: false,
  total_budget_formatted: "0",
  remaining_formatted: "0",
};

function renderBudget(role: Role = "LEADER") {
  const session: SessionValue = {
    status: "authenticated",
    user: { userId: "USR-1", name: "Asha", email: "asha@example.org", role, organizations: ["ORG-test"], isDemo: false },
    activeOrganizationId: "ORG-test",
    refresh: () => Promise.resolve(),
    signOut: () => undefined,
  };
  return render(<MemoryRouter><SessionContext.Provider value={session}><Budget eventId="EVT-1" /></SessionContext.Provider></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getBudget.mockResolvedValue(BUDGET);
  api.getExpenses.mockResolvedValue({ expenses: [], count: 0, total_inr: 0 });
  api.projectBudget.mockResolvedValue({
    projection: {
      category: "VENUE", amount_inr: 1000, affordable: true, blockers: [], current_remaining: 75000,
      projected_remaining: 74000, current_committed: 10000, projected_committed: 11000,
      current_utilization_percent: 25, projected_utilization_percent: 26, impact_summary: "Backend projection",
    },
    budget: BUDGET,
  });
  api.setBudget.mockResolvedValue({ message: "Total budget updated by the backend." });
  api.allocateBudget.mockResolvedValue({ message: "Allocation updated by the backend." });
  api.recordExpense.mockResolvedValue({ message: "Expense recorded by the backend." });
});

describe("Budget leader controls", () => {
  it("shows all mutation controls to leaders and none to team members", async () => {
    const leader = renderBudget();
    expect(await screen.findByRole("heading", { name: "Leader budget controls" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adjust total budget" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allocate budget" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record expense" })).toBeInTheDocument();

    leader.unmount();
    renderBudget("TEAM_MEMBER");
    expect(await screen.findByText("₹75,000")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Leader budget controls" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adjust total budget" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allocate budget" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record expense" })).not.toBeInTheDocument();
  });

  it("keeps the set-total form available when no budget exists", async () => {
    api.getBudget.mockResolvedValue(NO_BUDGET);
    renderBudget();

    expect(await screen.findByText("No budget set for this event.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set total budget" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allocate budget" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record expense" })).not.toBeInTheDocument();
  });

  it.each(["", "-1", "1.5", "01", "abc", "9007199254740992"])("rejects invalid total %p before requesting", async (value) => {
    const user = userEvent.setup();
    renderBudget();
    const input = await screen.findByLabelText("Total budget in whole rupees");
    if (value) await user.type(input, value);
    await user.click(screen.getByRole("button", { name: "Adjust total budget" }));
    expect(api.setBudget).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/whole number of rupees/i);
  });

  it("rejects malformed, negative, decimal, empty, and unsafe allocations before requesting", async () => {
    const user = userEvent.setup();
    renderBudget();
    const input = await screen.findByLabelText("Allocation amount in whole rupees");
    for (const value of ["", "-1", "1.5", "01", "abc", "9007199254740992"]) {
      await user.clear(input);
      if (value) await user.type(input, value);
      await user.click(screen.getByRole("button", { name: "Allocate budget" }));
    }
    expect(api.allocateBudget).not.toHaveBeenCalled();
  });

  it("accepts zero for total and allocation, then refreshes authoritative budget and expenses", async () => {
    const user = userEvent.setup();
    api.getBudget.mockResolvedValueOnce(BUDGET).mockResolvedValueOnce(UPDATED_BUDGET);
    renderBudget();

    await user.type(await screen.findByLabelText("Total budget in whole rupees"), "0");
    await user.click(screen.getByRole("button", { name: "Adjust total budget" }));

    expect(await screen.findByText("Total budget updated by the backend.")).toBeInTheDocument();
    expect(api.setBudget).toHaveBeenCalledWith("EVT-1", { total_budget: 0 });
    expect(api.getBudget).toHaveBeenCalledTimes(2);
    expect(api.getExpenses).toHaveBeenCalledTimes(2);
    expect(screen.getByText("₹85,000")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Allocation amount in whole rupees"), "0");
    await user.type(screen.getByLabelText("Allocation notes (optional)"), "Keep category open");
    await user.click(screen.getByRole("button", { name: "Allocate budget" }));
    await waitFor(() => expect(api.allocateBudget).toHaveBeenCalledWith("EVT-1", { category: "VENUE", amount_inr: 0, notes: "Keep category open" }));
  });

  it("rejects malformed, negative, decimal, empty, zero, and unsafe expenses before requesting", async () => {
    const user = userEvent.setup();
    renderBudget();
    const amount = await screen.findByLabelText("Expense amount in whole rupees");
    await user.type(screen.getByLabelText("Expense description"), "Hall deposit");
    for (const value of ["", "0", "-1", "1.5", "01", "abc", "9007199254740992"]) {
      await user.clear(amount);
      if (value) await user.type(amount, value);
      await user.click(screen.getByRole("button", { name: "Record expense" }));
    }
    expect(api.recordExpense).not.toHaveBeenCalled();
  }, 15_000);

  it("requires a positive expense and sends only validated useful fields", async () => {
    const user = userEvent.setup();
    renderBudget();

    const amount = await screen.findByLabelText("Expense amount in whole rupees");
    await user.type(amount, "0");
    await user.type(screen.getByLabelText("Expense description"), "Hall deposit");
    await user.click(screen.getByRole("button", { name: "Record expense" }));
    expect(api.recordExpense).not.toHaveBeenCalled();

    await user.clear(amount);
    await user.type(amount, "12500");
    await user.type(screen.getByLabelText("Vendor (optional)"), "City Hall");
    await user.type(screen.getByLabelText("Approval ID (optional)"), "APR-1");
    await user.click(screen.getByRole("button", { name: "Record expense" }));

    await waitFor(() => expect(api.recordExpense).toHaveBeenCalledWith("EVT-1", {
      category: "VENUE",
      amount_inr: 12500,
      description: "Hall deposit",
      vendor: "City Hall",
      approval_id: "APR-1",
    }));
  });

  it("locks every mutation form while one write and its authoritative refresh are in flight", async () => {
    const user = userEvent.setup();
    let resolveAllocation: ((value: { message: string }) => void) | undefined;
    api.allocateBudget.mockReturnValue(new Promise((resolve) => { resolveAllocation = resolve; }));
    renderBudget();

    await user.type(await screen.findByLabelText("Allocation amount in whole rupees"), "1000");
    await user.click(screen.getByRole("button", { name: "Allocate budget" }));

    expect(screen.getByRole("button", { name: "Adjust total budget" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Allocating…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Record expense" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Record expense" }));
    expect(api.recordExpense).not.toHaveBeenCalled();

    resolveAllocation?.({ message: "Allocation updated by the backend." });
    expect(await screen.findByText("Allocation updated by the backend.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adjust total budget" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Allocate budget" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Record expense" })).toBeEnabled();
  });

  it("preserves useful input and displayed balances when a mutation fails", async () => {
    const user = userEvent.setup();
    api.allocateBudget.mockRejectedValue({ status: 500, category: "INTERNAL_ERROR", message: "private backend detail" });
    renderBudget();

    const amount = await screen.findByLabelText("Allocation amount in whole rupees");
    await user.type(amount, "5000");
    await user.type(screen.getByLabelText("Allocation notes (optional)"), "Catering reserve");
    await user.click(screen.getByRole("button", { name: "Allocate budget" }));

    expect(await screen.findByText("CommunityOps couldn't load this view.")).toBeInTheDocument();
    expect(amount).toHaveValue("5000");
    expect(screen.getByLabelText("Allocation notes (optional)")).toHaveValue("Catering reserve");
    expect(screen.getByText("₹75,000")).toBeInTheDocument();
    expect(screen.queryByText("private backend detail")).not.toBeInTheDocument();
    expect(api.getBudget).toHaveBeenCalledTimes(1);
    expect(api.getExpenses).toHaveBeenCalledTimes(1);
  });

  it("clears a stale projection after a successful mutation", async () => {
    const user = userEvent.setup();
    renderBudget();

    await user.type(await screen.findByLabelText("Amount in whole rupees"), "1000");
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Backend projection")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Allocation amount in whole rupees"), "1000");
    await user.click(screen.getByRole("button", { name: "Allocate budget" }));
    expect(await screen.findByText("Allocation updated by the backend.")).toBeInTheDocument();
    expect(screen.queryByText("Backend projection")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Amount in whole rupees")).toHaveValue("");
  });
});
