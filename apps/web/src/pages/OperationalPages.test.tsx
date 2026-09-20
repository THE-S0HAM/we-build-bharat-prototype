import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { SessionContext } from "../session/sessionContext";
import { AgentConsole } from "./AgentConsole";
import { AttendeeOps } from "./AttendeeOps";
import { Budget } from "./Budget";

const api = vi.hoisted(() => ({ attendees: vi.fn(), budget: vi.fn(), expenses: vi.fn(), projection: vi.fn(), capabilities: vi.fn(), activity: vi.fn(), chat: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), getAttendeeOps: api.attendees, getBudget: api.budget, getExpenses: api.expenses, projectBudget: api.projection, getAgentCapabilities: api.capabilities, getAgentActivity: api.activity, agentChat: api.chat }));
const wrapper = (page: React.ReactNode) => render(<MemoryRouter><SessionContext.Provider value={{ status: "authenticated", user: { userId: "USR-1", name: "Asha", email: "asha@example.org", role: "LEADER", organizations: ["ORG-test"], isDemo: false }, refresh: () => Promise.resolve(), signOut: () => undefined }}>{page}</SessionContext.Provider></MemoryRouter>);
beforeEach(() => {
  api.attendees.mockResolvedValue({ event_id: "EVT-1", event_name: "Event", summary: { total_registered: 10, confirmed: 8, cancelled: 1, waitlisted: 1, checked_in: 2, not_checked_in: 8, accommodation_required: 1, dietary_provided: 7, dietary_missing: 3, arrival_confirmed: 6, arrival_conflicts: 1, missing_information: 3, data_completeness_percent: 70, expected_attendees: 10, registration_target: 10 }, funnel: [{ stage: "Registered", count: 10, detail: "Signed up" }, { stage: "Information complete", count: 7, detail: "Details provided" }], exceptions: { missing_dietary: [{ registration_id: "REG-1", attendee_name: "Priya", ticket_type: "GENERAL" }], missing_dietary_total: 1, accommodation_pending: [], accommodation_pending_total: 0, arrival_unconfirmed: [], arrival_unconfirmed_total: 0 } });
  api.budget.mockResolvedValue({ event_id: "EVT-1", currency: "INR", total_budget: 100000, allocated: 90000, spent: 15000, committed: 10000, remaining: 75000, unallocated: 10000, utilization_percent: 25, categories: [{ category: "VENUE", allocated: 50000, spent: 15000, committed: 10000, remaining: 25000, utilization_percent: 50 }], exists: true, total_budget_formatted: "1,00,000", remaining_formatted: "75,000", categories_available: ["VENUE"] });
  api.expenses.mockResolvedValue({ expenses: [], count: 0, total_inr: 0 });
  api.projection.mockResolvedValue({ projection: { category: "VENUE", amount_inr: 12500, affordable: true, blockers: [], current_remaining: 75000, projected_remaining: 62500, current_committed: 10000, projected_committed: 22500, current_utilization_percent: 25, projected_utilization_percent: 38, impact_summary: "₹75,000 → ₹62,500 remaining" }, budget: {} });
  api.capabilities.mockResolvedValue({ role: "LEADER", model_id: "hidden", model_region: "hidden", tool_count: 2, tools: [], automatic: ["get_budget"], requires_approval: ["record_expense"], withheld_from_role: [], notes: [] });
  api.activity.mockResolvedValue({ activity: [], count: 0, refused_count: 0, awaiting_approval_count: 0 });
  api.chat.mockResolvedValue({ session_id: "session-123", reply: "I prepared the expense request.", tools_used: ["record_expense"], approvals_created: ["APR-1"], turns_taken: 1, latency_ms: 10, truncated: false, evidence: [{ tool: "record_expense", summary: "approval APR-1 prepared" }] });
});

describe("operational pages", () => {
  it("uses pressed filter buttons and preserves privacy", async () => {
    wrapper(<AttendeeOps eventId="EVT-1" />);
    expect(await screen.findByText("70%")).toBeInTheDocument();
    expect(screen.getByText("Priya")).toBeInTheDocument();
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
    const dietary = screen.getByRole("button", { name: /Dietary details missing/ });
    const accommodation = screen.getByRole("button", { name: /Accommodation pending/ });
    expect(dietary).toHaveAttribute("aria-pressed", "true");
    expect(accommodation).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(accommodation);
    expect(accommodation).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });
  it("renders backend budget totals and projection without client subtraction", async () => { wrapper(<Budget eventId="EVT-1" />); expect(await screen.findByText("₹75,000")).toBeInTheDocument(); await userEvent.type(screen.getByLabelText("Amount in whole rupees"), "12500"); await userEvent.click(screen.getByRole("button", { name: "Check" })); expect(await screen.findByText(/₹75,000 → ₹62,500 remaining/)).toBeInTheDocument(); expect(screen.getByText(/Remaining after: ₹62,500/)).toBeInTheDocument(); });
  it("marks approval-gated output as prepared without exposing internal identifiers", async () => {
    wrapper(<AgentConsole eventId="EVT-1" />);
    await screen.findByText(/2 capabilities/);
    expect(screen.getByText("Get budget")).toBeInTheDocument();
    expect(screen.getByText("Record expense")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Ask CommunityOps"), "Record this expense");
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("Prepared, not performed.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review the prepared action in Approvals" })).toHaveAttribute("href", "/approvals");
    expect(screen.getByText(/approval request prepared/)).toBeInTheDocument();
    const rendered = document.body.textContent ?? "";
    expect(rendered).not.toMatch(/record_expense|APR-1|hidden/);
    await waitFor(() => expect(api.chat).toHaveBeenCalledOnce());
  });
});
