/**
 * Approvals — the page, end to end against a stubbed API boundary.
 *
 * Only `getApprovals` and `decideApproval` are replaced. The queue, the card, the
 * evidence allowlist, the error-category table and the session-level failure
 * handling are the real modules, because every behaviour here is a statement
 * about what those do together:
 *
 *   - a pending-only queue, oldest first, with no resolved table (5.1, A3)
 *   - "Faisla aapka." once, "Nothing needs your decision." when empty (5.12, 5.13)
 *   - one request per Approve, with the item's controls locked (5.3)
 *   - 409 replaces the item and refetches the queue (5.6)
 *   - "Decision recorded." plus the concrete outcome, no continuation claim (5.7, A9)
 *   - the decision attributed to the user, the action to CommunityOps (5.8)
 *   - evidence as allowlisted rows and a count, never as serialized text (5.9)
 *   - a session-scoped strip linking to the Audit Log (5.11)
 *   - no rendered string carries an AWS identifier (16.7)
 *
 * **Validates: Requirements 5.1, 5.3, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13, 16.5, 16.7**
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_QUEUE_TITLE, QUEUE_FRAMING } from "../approvals/decision";
import {
  AUDIT_LOG_LINK_LABEL,
  RECENTLY_DECIDED_HEADING,
  SESSION_SCOPE_NOTICE,
} from "../approvals/RecentlyDecided";
import { SessionProvider } from "../session/SessionProvider";
import type { Approval } from "../types";
import { ApprovalCenter } from "./ApprovalCenter";

const api = vi.hoisted(() => ({
  getApprovals: vi.fn(),
  getApproval: vi.fn(),
  decideApproval: vi.fn(),
}));

const authFixture = vi.hoisted(() => ({
  token: "header.eyJzdWIiOiJVU1ItMSIsImVtYWlsIjoiYXNoYUBleGFtcGxlLm9yZyIsImNvZ25pdG86Z3JvdXBzIjpbIkxFQURFUiIsIk9SRy13ZW1ha2VkZXYiXX0.signature",
  user: {
    userId: "USR-1",
    email: "asha@example.org",
    name: "Asha",
    role: "LEADER" as const,
    organizations: ["ORG-wemakedev"],
    isDemo: false,
  },
}));

vi.mock("../auth", () => ({
  isAuthConfigured: true,
  isSignedIn: () => Promise.resolve(true),
  signOut: () => undefined,
  getIdToken: () => Promise.resolve(authFixture.token),
  getSignedInUser: () => Promise.resolve(authFixture.user),
  isDemoSession: () => false,
  getSignedInEmail: () => authFixture.user.email,
  getMemberOrganizations: () => Promise.resolve(authFixture.user.organizations),
  signIn: () => Promise.resolve(),
  AuthError: class AuthError extends Error {},
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();

  return { ...actual, getApprovals: api.getApprovals, getApproval: api.getApproval, decideApproval: api.decideApproval };
});

const EVENT_ID = "EVT-devcon-2026";

/** A failure shaped like one `api.ts` throws, read structurally by the console. */
function apiFailure(status: number, category: string): { status: number; category: string } {
  return { status, category };
}

function approval(overrides: Partial<Approval> & { approval_id: string }): Approval {
  return {
    event_id: EVENT_ID,
    title: "Send 3rd follow-up to Raj Malhotra",
    description: "SpeakerOps wants to send a 3rd follow-up to a speaker who has not replied.",
    status: "PENDING",
    risk_level: "MEDIUM",
    requested_action: "SEND_SPEAKER_FOLLOWUP",
    reason: "Follow-up count exceeds the auto-send threshold",
    evidence: { speaker_id: "SPK-002", followup_count: 2 },
    affected_resource_type: "Speaker",
    affected_resource_id: "SPK-002",
    agent_name: "SpeakerOps",
    requested_at: "2026-10-14T09:00:00Z",
    ...overrides,
  };
}

/** What `getApprovals` answers with, in order, one call after another. */
function respondWith(...responses: readonly Approval[][]) {
  api.getApprovals.mockReset();
  api.getApproval.mockImplementation((_eventId: string, approvalId: string) => Promise.resolve({ approval: approval({ approval_id: approvalId }), budget_projection: null }));

  for (const approvals of responses) {
    api.getApprovals.mockResolvedValueOnce({ approvals, count: approvals.length });
  }

  // Any further refresh answers with the last response given.
  const last = responses[responses.length - 1] ?? [];
  api.getApprovals.mockResolvedValue({ approvals: last, count: last.length });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SessionProvider>
        <ApprovalCenter eventId={EVENT_ID} />
      </SessionProvider>
    </MemoryRouter>,
  );
}

/**
 * The card for one approval, found by its title.
 *
 * `level: 2` because the page's heading order runs `<h1>` (PageHeader) → `<h2>`
 * (each card) → `<h3>` (the card's evidence section). The queue section is named
 * by `aria-label`, so there is no heading between the page title and the cards to
 * make a card an `<h3>` (requirement 15.1).
 */
async function cardFor(title: string): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { name: title, level: 2 });
  const card = heading.closest("article");

  if (card === null) {
    throw new Error(`The card for "${title}" was not rendered as an article.`);
  }

  return card;
}

beforeEach(() => {
  api.decideApproval.mockReset();
  api.decideApproval.mockResolvedValue({});
  respondWith([approval({ approval_id: "APR-001" })]);
});

describe("the queue (requirements 5.1, 5.12, 5.13, A3)", () => {
  it("renders pending items oldest first, and no resolved table", async () => {
    respondWith([
      approval({ approval_id: "APR-002", title: "Newer decision", requested_at: "2026-10-14T11:00:00Z" }),
      approval({ approval_id: "APR-001", title: "Oldest decision", requested_at: "2026-10-14T08:00:00Z" }),
      approval({ approval_id: "APR-003", title: "Middle decision", requested_at: "2026-10-14T09:30:00Z" }),
      // The endpoint queries `sk_begins_with="APPROVAL#PENDING"`, so this cannot
      // arrive — and if it did, it is not a decision surface.
      approval({ approval_id: "APR-004", title: "Already approved elsewhere", status: "APPROVED" }),
    ]);

    renderPage();

    // Card titles are the page's `<h2>`s: nothing else on the page renders one
    // while no decision has been recorded this session.
    const titles = (await screen.findAllByRole("heading", { level: 2 })).map(
      (heading) => heading.textContent,
    );
    expect(titles).toEqual(["Oldest decision", "Middle decision", "Newer decision"]);

    // The permanently-empty resolved table is gone (A3).
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("Already approved elsewhere")).not.toBeInTheDocument();
  });

  it("renders the framing line exactly once, beside the waiting count", async () => {
    respondWith([
      approval({ approval_id: "APR-001" }),
      approval({ approval_id: "APR-002", title: "Second decision" }),
    ]);

    renderPage();
    await cardFor("Second decision");

    const framing = screen.getAllByText(new RegExp(QUEUE_FRAMING));
    expect(framing).toHaveLength(1);
    expect(framing[0]).toHaveTextContent("2 decisions are waiting for you.");
  });

  it("says nothing needs deciding when the queue is empty", async () => {
    respondWith([]);
    renderPage();

    expect(await screen.findByText(EMPTY_QUEUE_TITLE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });
});

describe("recording a decision (requirements 5.3, 5.7, 5.8, 5.11, A9)", () => {
  it("issues one request, then states the outcome without claiming the workflow continues", async () => {
    renderPage();
    const card = await cardFor("Send 3rd follow-up to Raj Malhotra");

    // Before deciding: the action is attributed to CommunityOps, the decision to
    // the user (requirement 5.8).
    expect(
      within(card).getByText("CommunityOps prepared this action. The decision is yours."),
    ).toBeInTheDocument();

    await userEvent.click(within(card).getByRole("button", { name: "Approve" }));

    expect(api.decideApproval).toHaveBeenCalledTimes(1);
    expect(api.decideApproval).toHaveBeenCalledWith(
      EVENT_ID,
      "APR-001",
      "APPROVED",
      "",
      undefined,
    );

    expect(await within(card).findByText("Decision recorded.")).toBeInTheDocument();
    expect(
      within(card).getByText(
        "Approval recorded for later execution. This decision did not execute the action.",
      ),
    ).toBeInTheDocument();
    expect(
      within(card).getByText("CommunityOps prepared this action. You approved it."),
    ).toBeInTheDocument();

    // A9: the Step Functions callback is not wired, so nothing may say execution
    // resumes from here.
    expect(document.body.textContent).not.toMatch(/continue|resume|carry on|from here/i);

    // The decided item stops being a decision surface (requirement 13.11).
    expect(within(card).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("adds the decision to a session-scoped strip that links to the Audit Log", async () => {
    renderPage();
    const card = await cardFor("Send 3rd follow-up to Raj Malhotra");

    expect(screen.queryByText(RECENTLY_DECIDED_HEADING)).not.toBeInTheDocument();

    await userEvent.click(within(card).getByRole("button", { name: "Approve" }));

    const strip = (await screen.findByText(RECENTLY_DECIDED_HEADING)).closest("section");
    expect(strip).not.toBeNull();
    expect(screen.getByText(SESSION_SCOPE_NOTICE)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: AUDIT_LOG_LINK_LABEL })).toHaveAttribute(
      "href",
      "/audit",
    );
  });
});

describe("a decision taken elsewhere (requirement 5.6)", () => {
  it("replaces the item with the already-decided message and refetches the queue", async () => {
    respondWith(
      [
        approval({ approval_id: "APR-001", title: "Contested decision" }),
        approval({ approval_id: "APR-002", title: "Untouched decision" }),
      ],
      [approval({ approval_id: "APR-002", title: "Untouched decision" })],
    );
    api.decideApproval.mockRejectedValueOnce(apiFailure(409, "CONFLICT"));

    renderPage();
    const card = await cardFor("Contested decision");

    await userEvent.click(within(card).getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("This was already decided elsewhere.")).toBeInTheDocument();

    // The queue is refetched, and the item is not retried (Property 15).
    await waitFor(() => {
      expect(api.getApprovals).toHaveBeenCalledTimes(2);
    });
    expect(api.decideApproval).toHaveBeenCalledTimes(1);

    // The replacement survives the refresh that removed the item from the queue,
    // and the rest of the queue is still decidable.
    expect(screen.getByRole("heading", { name: "Contested decision", level: 2 })).toBeInTheDocument();
    const untouched = await cardFor("Untouched decision");
    expect(within(untouched).getByRole("button", { name: "Approve" })).toBeEnabled();
  });
});

describe("what the page will and will not render (requirements 5.9, 5.10, 16.5, 16.7)", () => {
  const LEAKY_EVIDENCE: Record<string, unknown> = {
    incident_id: "INC-001",
    // Written onto the APPROVAL item by the workflows and returned raw by
    // `_list_approvals` (A8). Not modelled, so not rendered.
    task_token: "AAAAKgAAAAIAAAAAAAAAAeExampleTaskToken",
    workflow_execution_id: "arn:aws:states:ap-south-1:123456789012:execution:approval:1",
    search_criteria: { attendee_email: "priya@example.com" },
  };

  it("renders recognised keys as rows, the rest as a count, and never as serialized text", async () => {
    respondWith([approval({ approval_id: "APR-001", evidence: LEAKY_EVIDENCE })]);
    const { container } = renderPage();
    const card = await cardFor("Send 3rd follow-up to Raj Malhotra");

    expect(within(card).getByText("Incident")).toBeInTheDocument();
    expect(within(card).getByText("INC-001")).toBeInTheDocument();
    expect(within(card).getByText(/3 more fields are recorded on this approval/)).toBeInTheDocument();

    // No key name, no value, no serialization anywhere in the markup.
    for (const leak of [
      "task_token",
      "workflow_execution_id",
      "AAAAKgAAAAIAAAAAAAAAAeExampleTaskToken",
      "arn:aws",
      "search_criteria",
      "priya@example.com",
    ]) {
      expect(container.innerHTML).not.toContain(leak);
    }
    expect(container.querySelector("pre")).toBeNull();
  });

  it("renders no financial line for evidence that states no amount (A10)", async () => {
    renderPage();
    await cardFor("Send 3rd follow-up to Raj Malhotra");

    expect(screen.queryByText(/Financial commitment/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/₹/);
  });

  it("puts no AWS identifier in any rendered string (Property 7)", async () => {
    respondWith([approval({ approval_id: "APR-001", evidence: LEAKY_EVIDENCE })]);
    api.decideApproval.mockRejectedValueOnce(apiFailure(502, "EXTERNAL_SERVICE_ERROR"));

    renderPage();
    const card = await cardFor("Send 3rd follow-up to Raj Malhotra");
    await userEvent.click(within(card).getByRole("button", { name: "Approve" }));
    await screen.findByText("CommunityOps couldn't complete that just now.");

    const rendered = document.body.textContent ?? "";
    for (const pattern of [
      /arn:/i,
      /\b\d{12}\b/,
      /\b(?:aws|amazonaws|lambda|dynamodb|cloudwatch|cognito|execute-api|sfn)\b/i,
      /task[\s_-]?token/i,
      /workflow[\s_-]?execution/i,
      /request[\s_-]?id/i,
      /\bat\s+\S+\s*\(/,
      /(?:error|exception|traceback)\b/i,
    ]) {
      expect(rendered).not.toMatch(pattern);
    }

    // A failure that leaves the approval decidable unlocks it again.
    expect(within(card).getByRole("button", { name: "Approve" })).toBeEnabled();
  });
});
