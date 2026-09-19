/**
 * Tests for the Command Center.
 *
 * The page exists to answer one question — does anything actually need me — so the tests are about
 * that answer being correct and unambiguous in each of the three states:
 *
 *   - nothing needs the leader
 *   - a decision is waiting
 *   - something needs attention but no decision is waiting
 *
 * The third is the easiest to get wrong and the most damaging: a page that shows no decision card
 * and says nothing else reads as "all clear" while two incidents sit open.
 *
 * The financial figures in the dominant decision come from the backend's own projection, so the
 * fixture reports 75,000 → 62,500 and the test asserts both appear. Nothing here is subtracted in
 * the browser.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import { AGENT_ACTIVITY, APPROVAL_DETAIL, COMMAND_CENTER, EVENT_ID } from "../test/fixtures";
import type { CommandCenterData } from "../types";

const getCommandCenter = vi.fn();
const getAgentActivity = vi.fn();
const getApproval = vi.fn();

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getCommandCenter: (...args: unknown[]) => getCommandCenter(...args),
    getAgentActivity: (...args: unknown[]) => getAgentActivity(...args),
    getApproval: (...args: unknown[]) => getApproval(...args),
  };
});

const { CommandCenter } = await import("./CommandCenter");

function renderPage(role: "LEADER" | "TEAM_MEMBER" = "LEADER") {
  return render(
    <MemoryRouter>
      <CommandCenter
        eventId={EVENT_ID}
        role={role}
        funMode={false}
        onToggleFunMode={() => undefined}
      />
    </MemoryRouter>,
  );
}

/** A copy of the fixture with no attention items and nothing pending. */
function quietState(): CommandCenterData {
  return {
    ...COMMAND_CENTER,
    summary: {
      ...COMMAND_CENTER.summary,
      pending_approvals: 0,
      open_incidents: 0,
      overdue_tasks: 0,
      unresponsive_speakers: 0,
      attention_required: 0,
    },
    attention_items: [],
  };
}

beforeEach(() => {
  getCommandCenter.mockResolvedValue(COMMAND_CENTER);
  getAgentActivity.mockResolvedValue(AGENT_ACTIVITY);
  getApproval.mockResolvedValue(APPROVAL_DETAIL);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("does anything need me?", () => {
  it("says so plainly when nothing does", async () => {
    getCommandCenter.mockResolvedValue(quietState());
    getAgentActivity.mockResolvedValue({ ...AGENT_ACTIVITY, activity: [], count: 0 });

    renderPage();

    expect(await screen.findByText(/Nothing needs you right now/i)).toBeInTheDocument();
    expect(screen.queryByText(/Needs your decision/i)).not.toBeInTheDocument();
  });

  it("leads with the count of decisions when some are waiting", async () => {
    renderPage();
    expect(await screen.findByText(/decision needs you/i)).toBeInTheDocument();
  });

  it("names outstanding items even when no decision is waiting", async () => {
    // The dangerous case: no approval to show, but two incidents open. Silence here would read as
    // "all clear".
    getCommandCenter.mockResolvedValue({
      ...COMMAND_CENTER,
      attention_items: COMMAND_CENTER.attention_items.filter((i) => i.kind !== "APPROVAL"),
    });

    renderPage();

    expect(await screen.findByText(/item needs attention|items need attention/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing needs you right now/i)).not.toBeInTheDocument();
  });
});

describe("the dominant decision", () => {
  it("shows the amount and the backend's projected balance", async () => {
    renderPage();

    expect(await screen.findByText(/Needs your decision/i)).toBeInTheDocument();
    expect(screen.getByText("₹12,500")).toBeInTheDocument();
    // Both sides of the transition, exactly as the backend projected them.
    expect(screen.getByText(/₹75,000\s*→\s*₹62,500/)).toBeInTheDocument();
  });

  it("states that nothing has been committed", async () => {
    renderPage();
    expect(
      await screen.findByText(/Nothing has been committed — the decision is yours/i),
    ).toBeInTheDocument();
  });

  it("does not offer approve or decline from the summary card", async () => {
    // Deliberate: a decision worth this much visual weight is made beside its evidence, not from a
    // card that invites approving without reading.
    renderPage();
    await screen.findByText(/Needs your decision/i);
    expect(screen.queryByRole("button", { name: /^Approve$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Review and decide/i })).toBeInTheDocument();
  });

  it("warns when the projection says the commitment is unaffordable", async () => {
    getApproval.mockResolvedValue({
      approval: APPROVAL_DETAIL.approval,
      budget_projection: {
        ...APPROVAL_DETAIL.budget_projection!,
        affordable: false,
        projected_remaining: -2000,
        blockers: ["ACCOMMODATION has only 2,000 left."],
      },
    });

    renderPage();

    expect(await screen.findByText(/Not affordable as things stand/i)).toBeInTheDocument();
    expect(screen.getByText(/ACCOMMODATION has only 2,000 left/i)).toBeInTheDocument();
  });
});

describe("resilience", () => {
  it("still renders when the agent activity feed fails", async () => {
    getAgentActivity.mockRejectedValue(new ApiError("down", 500));
    renderPage();
    expect(await screen.findByText(/decision needs you/i)).toBeInTheDocument();
  });

  it("still renders when the approval detail cannot be fetched", async () => {
    getApproval.mockRejectedValue(new ApiError("gone", 404));
    renderPage();
    // Falls back to naming the outstanding items rather than showing an empty page.
    await waitFor(() =>
      expect(screen.getByText(/items need attention|item needs attention/i)).toBeInTheDocument(),
    );
  });

  it("surfaces a failure of the command centre itself rather than an empty page", async () => {
    getCommandCenter.mockRejectedValue(
      new ApiError("You are not authorized to access this organization's data.", 403, "FORBIDDEN"),
    );

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(/not authorized/i);
  });
});

describe("role differences", () => {
  it("tells a team member what is reserved for leaders", async () => {
    renderPage("TEAM_MEMBER");
    expect(
      await screen.findByText(/Approvals, budget and the audit log are reserved/i),
    ).toBeInTheDocument();
  });

  it("says nothing of the sort to a leader", async () => {
    renderPage("LEADER");
    await screen.findByText(/decision needs you/i);
    expect(screen.queryByText(/reserved for community leaders/i)).not.toBeInTheDocument();
  });
});

describe("fun mode", () => {
  it("adds no Hindi flourish while it is off", async () => {
    renderPage();
    await screen.findByText(/decision needs you/i);
    expect(screen.queryByText(/Tension lene ka nahi/i)).not.toBeInTheDocument();
  });

  it("adds one when it is on", async () => {
    render(
      <MemoryRouter>
        <CommandCenter
          eventId={EVENT_ID}
          role="LEADER"
          funMode
          onToggleFunMode={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Tension lene ka nahi, action lene ka/i)).toBeInTheDocument();
  });
});
