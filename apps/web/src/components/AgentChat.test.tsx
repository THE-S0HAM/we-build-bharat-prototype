/**
 * Tests for the operations chat.
 *
 * Two behaviours carry the product's central claim, and both are asserted here:
 *
 * 1. **Prepared is not performed.** When a turn raises an approval, the reply must be visibly marked
 *    as waiting for a decision. If that marking is ever lost, the agent appears to have acted, which
 *    is the exact misrepresentation the approval gate exists to prevent.
 *
 * 2. **Answers show their sources.** The tools a reply relied on are rendered, so a figure can be
 *    checked rather than taken on faith.
 *
 * A failed turn is also covered: it belongs in the transcript, attached to the question it failed to
 * answer, rather than vanishing into a toast.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import { EVENT_ID } from "../test/fixtures";
import type { AgentChatResponse } from "../types";

const agentChat = vi.fn();

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, agentChat: (...args: unknown[]) => agentChat(...args) };
});

const { AgentChat } = await import("./AgentChat");

const PLAIN_REPLY: AgentChatResponse = {
  session_id: "sess-1",
  reply: "₹75,000 remains, which is 70% of the ₹2,50,000 budget used.",
  tools_used: ["get_budget"],
  approvals_created: [],
  turns_taken: 2,
  latency_ms: 850,
  truncated: false,
  evidence: [{ tool: "get_budget", summary: "remaining 75,000" }],
};

const GATED_REPLY: AgentChatResponse = {
  session_id: "sess-1",
  reply: "I have prepared the accommodation commitment for Kavya Nair and it needs your approval.",
  tools_used: ["get_budget", "request_accommodation"],
  approvals_created: ["APR-009"],
  turns_taken: 3,
  latency_ms: 1400,
  truncated: false,
  evidence: [],
};

beforeEach(() => {
  agentChat.mockResolvedValue(PLAIN_REPLY);
});

afterEach(() => {
  vi.clearAllMocks();
});

async function ask(question: string) {
  const input = screen.getByLabelText(/Ask CommunityOps/i);
  await userEvent.type(input, question);
  await userEvent.click(screen.getByRole("button", { name: /^Send$/ }));
}

describe("the approval gate", () => {
  it("marks a reply that raised an approval as prepared, not done", async () => {
    agentChat.mockResolvedValue(GATED_REPLY);
    render(<AgentChat eventId={EVENT_ID} role="LEADER" />);

    await ask("Book accommodation for Kavya");

    expect(await screen.findByText(/Prepared, not performed/i)).toBeInTheDocument();
    expect(screen.getByText(/APR-009/)).toBeInTheDocument();
  });

  it("tells the surrounding page so its counts can refresh", async () => {
    agentChat.mockResolvedValue(GATED_REPLY);
    const onApprovalCreated = vi.fn();
    render(
      <AgentChat eventId={EVENT_ID} role="LEADER" onApprovalCreated={onApprovalCreated} />,
    );

    await ask("Book accommodation for Kavya");

    await waitFor(() => expect(onApprovalCreated).toHaveBeenCalledWith(["APR-009"]));
  });

  it("adds no such marking to a reply that only read data", async () => {
    render(<AgentChat eventId={EVENT_ID} role="LEADER" />);
    await ask("How much budget remains?");

    expect(await screen.findByText(/₹75,000 remains/)).toBeInTheDocument();
    expect(screen.queryByText(/Prepared, not performed/i)).not.toBeInTheDocument();
  });
});

describe("showing its sources", () => {
  it("lists the tools the answer relied on", async () => {
    render(<AgentChat eventId={EVENT_ID} role="LEADER" />);
    await ask("How much budget remains?");

    expect(await screen.findByText("get_budget")).toBeInTheDocument();
  });

  it("warns when the answer was cut short rather than presenting it as complete", async () => {
    agentChat.mockResolvedValue({ ...PLAIN_REPLY, truncated: true });
    render(<AgentChat eventId={EVENT_ID} role="LEADER" />);
    await ask("Tell me everything");

    expect(await screen.findByText(/The answer was cut short/i)).toBeInTheDocument();
  });
});

describe("role awareness", () => {
  it("offers a leader openers about the whole operation", () => {
    render(<AgentChat eventId={EVENT_ID} role="LEADER" />);
    expect(screen.getByRole("button", { name: "How much budget remains?" })).toBeInTheDocument();
    expect(
      screen.getByText(/Consequential actions are prepared for your approval, never performed/i),
    ).toBeInTheDocument();
  });

  it("offers a team member openers about their own work", () => {
    render(<AgentChat eventId={EVENT_ID} role="TEAM_MEMBER" />);
    expect(screen.getByRole("button", { name: "What are my tasks?" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "How much budget remains?" })).not.toBeInTheDocument();
    expect(screen.getByText(/Decisions are reserved for community leaders/i)).toBeInTheDocument();
  });
});

describe("failure handling", () => {
  it("keeps a failed answer in the transcript beside the question", async () => {
    agentChat.mockRejectedValue(new ApiError("The assistant timed out.", 504, "TIMEOUT"));
    render(<AgentChat eventId={EVENT_ID} role="LEADER" />);

    await ask("Why is this event orange?");

    expect(await screen.findByText(/The assistant timed out/i)).toBeInTheDocument();
    // The question stays visible, so it is clear which one went unanswered.
    expect(screen.getByText("Why is this event orange?")).toBeInTheDocument();
  });

  it("reassures that a chat failure did not touch operational data", async () => {
    agentChat.mockRejectedValue(new Error("boom"));
    render(<AgentChat eventId={EVENT_ID} role="LEADER" />);

    await ask("What needs me?");

    expect(await screen.findByText(/Your operational data is unaffected/i)).toBeInTheDocument();
  });
});

describe("the request", () => {
  it("carries the event and the fun-mode preference", async () => {
    render(<AgentChat eventId={EVENT_ID} role="LEADER" funMode />);
    await ask("What needs me?");

    await waitFor(() =>
      expect(agentChat).toHaveBeenCalledWith(
        expect.objectContaining({ event_id: EVENT_ID, fun_mode: true }),
      ),
    );
  });

  it("continues the same session on a second question", async () => {
    render(<AgentChat eventId={EVENT_ID} role="LEADER" />);
    await ask("How much budget remains?");
    await screen.findByText(/₹75,000 remains/);

    await ask("And what about equipment?");

    await waitFor(() =>
      expect(agentChat).toHaveBeenLastCalledWith(
        expect.objectContaining({ session_id: "sess-1" }),
      ),
    );
  });

  it("sends nothing for an empty message", async () => {
    render(<AgentChat eventId={EVENT_ID} role="LEADER" />);
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeDisabled();
    expect(agentChat).not.toHaveBeenCalled();
  });
});
