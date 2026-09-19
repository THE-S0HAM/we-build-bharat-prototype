/**
 * The event gate on an event-scoped route (requirements 3.7, 3.10, 13.1, 13.3).
 *
 * The rule worth protecting: a page that fetches per event is never mounted
 * without one. Before the event context replaced the hardcoded `EVENT_ID`
 * (design.md A16) there was nothing to wait for, so this is the component that
 * has to hold the page back — and has to do it without inventing an identifier.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { EventContext } from "./eventContext";
import type { EventContextValue } from "./eventContext";
import { EventScopedView } from "./EventScopedView";

/** Stands in for an event-scoped page, reporting only the event it was given. */
function ProbePage({ eventId }: { eventId: string }) {
  return <p>Showing {eventId}</p>;
}

function renderGate(context: Partial<EventContextValue>) {
  const value: EventContextValue = {
    status: "ready",
    activeEvent: null,
    activeEventId: null,
    events: [],
    source: "none",
    error: null,
    setActiveEvent: () => false,
    refresh: () => undefined,
    ...context,
  };

  render(
    <EventContext.Provider value={value}>
      <EventScopedView view={ProbePage} />
    </EventContext.Provider>,
  );
}

describe("EventScopedView", () => {
  it("holds the page back while the event lookup is in flight", () => {
    renderGate({ status: "loading" });

    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
    // The wait is announced, and it is a skeleton rather than a spinner
    // (requirement 13.1, design.md §12.2).
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  });

  it("hands the resolved event to the page", () => {
    renderGate({ status: "ready", activeEventId: "EVT-active" });

    expect(screen.getByText("Showing EVT-active")).toBeInTheDocument();
  });

  it("renders the standard failure with a retry that re-runs the lookup", async () => {
    const refresh = vi.fn();
    renderGate({ status: "failed", error: { category: "INTERNAL_ERROR" }, refresh });

    expect(screen.getByText("CommunityOps couldn't load this view.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    // Only the failed request is re-run; no page reload (requirement 13.3).
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("renders no page and no error when the organization has no events", () => {
    renderGate({ status: "empty" });

    // Requirement 3.10 puts the no-events state in the shell: one sentence for
    // the console, not the same sentence on six routes.
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
