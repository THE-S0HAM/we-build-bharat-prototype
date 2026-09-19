/**
 * Tests for the Approvals screen.
 *
 * The load-bearing assertion is in "money": after a decision, the balance on screen must be the one
 * the backend returned, not `remaining - amount`. To prove the frontend is genuinely displaying
 * rather than calculating, the stubbed response deliberately returns a figure that naive subtraction
 * would *not* produce. If the code ever starts doing its own arithmetic, that test fails — which is
 * the only way to catch it, since in production the two usually agree and the bug only appears when
 * a concurrent change or a category limit alters the outcome.
 *
 * The rest covers the authority boundary: a team member must not be offered a decision, and the copy
 * must say the agent prepared the action rather than took it.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import { APPROVAL_001, BUDGET_BEFORE, EVENT_ID } from "../test/fixtures";
import type { Approval } from "../types";

const getApprovals = vi.fn();
const decideApproval = vi.fn();

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getApprovals: (...args: unknown[]) => getApprovals(...args),
    decideApproval: (...args: unknown[]) => decideApproval(...args),
  };
});

const { ApprovalsPage } = await import("./Approvals");

const DECIDED: Approval = {
  ...APPROVAL_001,
  approval_id: "APR-007",
  title: "Extra catering for 40 additional attendees",
  status: "DECLINED",
  amount_inr: 18000,
  budget_category: "CATERING",
  decided_by: "demo-leader-priya",
  decision_notes: "Headcount is not confirmed yet.",
};

function renderPage(role: "LEADER" | "TEAM_MEMBER" = "LEADER") {
  const onDecided = vi.fn();
  const view = render(
    <ApprovalsPage eventId={EVENT_ID} role={role} onDecided={onDecided} />,
  );
  return { ...view, onDecided };
}

beforeEach(() => {
  getApprovals.mockResolvedValue({
    approvals: [APPROVAL_001, DECIDED],
    count: 2,
    pending_count: 1,
    pending_financial_exposure_inr: 12500,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the waiting list", () => {
  it("separates what is waiting from what has been decided", async () => {
    renderPage();
    expect(await screen.findByRole("tab", { name: /Waiting on you \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Decided \(1\)/ })).toBeInTheDocument();
    expect(screen.getByText(APPROVAL_001.title)).toBeInTheDocument();
    expect(screen.queryByText(DECIDED.title)).not.toBeInTheDocument();
  });

  it("totals the financial exposure of everything waiting", async () => {
    renderPage();
    expect(await screen.findByText(/committing ₹12,500 in total if all are approved/i)).toBeInTheDocument();
  });

  it("says nothing is waiting when nothing is", async () => {
    getApprovals.mockResolvedValue({
      approvals: [],
      count: 0,
      pending_count: 0,
      pending_financial_exposure_inr: 0,
    });
    renderPage();
    expect(await screen.findByText(/Nothing is waiting on you/i)).toBeInTheDocument();
  });

  it("surfaces a load failure rather than an empty list", async () => {
    getApprovals.mockRejectedValue(new ApiError("Approvals are unavailable.", 503));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Approvals are unavailable/);
  });
});

describe("authority attribution", () => {
  it("says the agent prepared the action, never that it decided", async () => {
    renderPage();
    await userEvent.click(await screen.findByText(APPROVAL_001.title));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/prepared this action and has not performed it/i);
    expect(dialog).not.toHaveTextContent(/CommunityOps decided/i);
  });

  it("offers a leader approve, edit and decline", async () => {
    renderPage("LEADER");
    await userEvent.click(await screen.findByText(APPROVAL_001.title));

    expect(await screen.findByRole("button", { name: /^Approve$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Edit$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Decline$/ })).toBeInTheDocument();
  });

  it("offers a team member none of them", async () => {
    renderPage("TEAM_MEMBER");
    await userEvent.click(await screen.findByText(APPROVAL_001.title));

    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: /^Approve$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Decline$/ })).not.toBeInTheDocument();
  });

  it("explains to a team member that this is the design, not their account", async () => {
    renderPage("TEAM_MEMBER");
    expect(
      await screen.findByText(/This is the boundary the product is built around/i),
    ).toBeInTheDocument();
  });
});

describe("money", () => {
  it("displays the balance the backend returned, not one it worked out", async () => {
    // 75,000 − 12,500 would be 62,500. The backend says 61,000 — perhaps a concurrent commitment
    // landed first. The screen must show 61,000.
    decideApproval.mockResolvedValue({
      approval_id: "APR-001",
      status: "APPROVED",
      message: "Approved. 61,000 remaining.",
      budget: {
        ...BUDGET_BEFORE,
        committed: 59000,
        remaining: 61000,
        utilization_percent: 76,
      },
    });

    renderPage();
    await userEvent.click(await screen.findByText(APPROVAL_001.title));
    await userEvent.click(await screen.findByRole("button", { name: /^Approve$/ }));

    expect(await screen.findByText("₹61,000")).toBeInTheDocument();
    expect(screen.queryByText("₹62,500")).not.toBeInTheDocument();
  });

  it("labels the figures as the backend's own recalculation", async () => {
    decideApproval.mockResolvedValue({
      approval_id: "APR-001",
      status: "APPROVED",
      message: "Approved.",
      budget: { ...BUDGET_BEFORE, remaining: 62500, committed: 57500, utilization_percent: 75 },
    });

    renderPage();
    await userEvent.click(await screen.findByText(APPROVAL_001.title));
    await userEvent.click(await screen.findByRole("button", { name: /^Approve$/ }));

    expect(
      await screen.findByText(/not from subtracting in the browser/i),
    ).toBeInTheDocument();
  });

  it("shows no budget panel when the decision had no financial effect", async () => {
    decideApproval.mockResolvedValue({
      approval_id: "APR-001",
      status: "DECLINED",
      message: "Declined. Nothing was committed.",
    });

    renderPage();
    await userEvent.click(await screen.findByText(APPROVAL_001.title));
    await userEvent.click(await screen.findByRole("button", { name: /^Decline$/ }));

    expect(await screen.findByText(/Nothing was committed/i)).toBeInTheDocument();
    expect(screen.queryByText(/Budget after your decision/i)).not.toBeInTheDocument();
  });

  it("keeps the panel open and explains when the backend refuses the commitment", async () => {
    // A budget can legitimately reject a commitment. That is an answer, so the leader stays where
    // they are and reads it rather than having the drawer close on them.
    decideApproval.mockRejectedValue(
      new ApiError("ACCOMMODATION has only 2,000 left; this needs 12,500.", 409, "CONFLICT"),
    );

    renderPage();
    await userEvent.click(await screen.findByText(APPROVAL_001.title));
    await userEvent.click(await screen.findByRole("button", { name: /^Approve$/ }));

    expect(await screen.findByText(/ACCOMMODATION has only 2,000 left/i)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("recording the decision", () => {
  it("sends the decision and the notes to the backend", async () => {
    decideApproval.mockResolvedValue({
      approval_id: "APR-001",
      status: "APPROVED",
      message: "Approved.",
    });

    renderPage();
    await userEvent.click(await screen.findByText(APPROVAL_001.title));
    await userEvent.type(
      await screen.findByLabelText(/Notes \(optional\)/i),
      "Confirmed with the hotel.",
    );
    await userEvent.click(screen.getByRole("button", { name: /^Approve$/ }));

    await waitFor(() =>
      expect(decideApproval).toHaveBeenCalledWith(EVENT_ID, "APR-001", "APPROVED", {
        notes: "Confirmed with the hotel.",
        edited_action: undefined,
      }),
    );
  });

  it("records an edited action as its own decision", async () => {
    decideApproval.mockResolvedValue({
      approval_id: "APR-001",
      status: "EDITED",
      message: "Recorded as edited.",
    });

    renderPage();
    await userEvent.click(await screen.findByText(APPROVAL_001.title));
    await userEvent.click(await screen.findByRole("button", { name: /^Edit$/ }));

    const field = await screen.findByLabelText(/Edited action/i);
    await userEvent.clear(field);
    await userEvent.type(field, "Book one night only");
    await userEvent.click(screen.getByRole("button", { name: /Save and approve as edited/i }));

    await waitFor(() =>
      expect(decideApproval).toHaveBeenCalledWith(
        EVENT_ID,
        "APR-001",
        "EDITED",
        expect.objectContaining({ edited_action: "Book one night only" }),
      ),
    );
  });

  it("tells the shell to refresh so its count cannot go stale", async () => {
    decideApproval.mockResolvedValue({
      approval_id: "APR-001",
      status: "APPROVED",
      message: "Approved.",
    });

    const { onDecided } = renderPage();
    await userEvent.click(await screen.findByText(APPROVAL_001.title));
    await userEvent.click(await screen.findByRole("button", { name: /^Approve$/ }));

    await waitFor(() => expect(onDecided).toHaveBeenCalled());
  });
});

describe("evidence", () => {
  it("exposes the figures the request rests on", async () => {
    renderPage();
    await userEvent.click(await screen.findByText(APPROVAL_001.title));

    await userEvent.click(await screen.findByText(/Evidence CommunityOps used/i));
    expect(screen.getByText("Nights")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
