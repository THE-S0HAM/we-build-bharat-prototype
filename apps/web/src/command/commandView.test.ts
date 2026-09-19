/**
 * The Command Center's derivations (requirement 4, design.md §8.1).
 *
 * These are the rules the page is built on, asserted without rendering: which
 * number the headline is allowed to use (A13), which approval is "the oldest",
 * which of the three operational states an event is in, and what "no drama"
 * actually means.
 */

import { describe, expect, it } from "vitest";

import type { Approval, EventSummary } from "../types";
import {
  greeting,
  noteFor,
  nothingNeedsYou,
  oldestPendingApproval,
  orbitAlternative,
  PAGE_NAME,
  toWatchedEventViews,
  watchedEventState,
  watchedEventLine,
} from "./commandView";

function event(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    event_id: "EVT-devcon-2026",
    name: "DevCon Bengaluru 2026",
    status: "ACTIVE",
    pending_approvals: 0,
    critical_incidents: 0,
    overdue_tasks: 0,
    blocked_tasks: 0,
    total_tasks: 9,
    ...overrides,
  };
}

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    approval_id: "APR-001",
    event_id: "EVT-devcon-2026",
    title: "Send 3rd follow-up",
    description: "",
    status: "PENDING",
    risk_level: "MEDIUM",
    requested_action: "SEND_SPEAKER_FOLLOWUP",
    reason: "",
    evidence: {},
    affected_resource_type: "Speaker",
    affected_resource_id: "SPK-002",
    agent_name: "SpeakerOps",
    requested_at: "2026-10-02T09:00:00Z",
    ...overrides,
  };
}

describe("the greeting", () => {
  it("carries the name claim", () => {
    expect(greeting("Priya Sharma")).toBe("Hello, Priya Sharma");
  });

  it("falls back to the page name rather than inventing one", () => {
    expect(greeting(null)).toBe(PAGE_NAME);
  });
});

describe("the watched-event count (A13, requirement 4.2)", () => {
  it("takes the headline from active_events and labels the total", () => {
    const line = watchedEventLine({
      active_events: 2,
      total_events: 5,
      pending_approvals: 1,
      critical_incidents: 0,
      overdue_tasks: 0,
    });

    expect(line).toBe("CommunityOps is watching 2 events, of 5 total.");
    // The drafts total is never the headline.
    expect(line).not.toMatch(/watching 5/);
  });

  it("omits the total when it says nothing the headline does not", () => {
    expect(
      watchedEventLine({
        active_events: 1,
        total_events: 1,
        pending_approvals: 0,
        critical_incidents: 0,
        overdue_tasks: 0,
      }),
    ).toBe("CommunityOps is watching 1 event.");
  });
});

describe("operational state (requirements 4.4, 12.9)", () => {
  it("reads a pending approval as a decision waiting on the user", () => {
    expect(watchedEventState(event({ pending_approvals: 2, critical_incidents: 3 }))).toBe(
      "NEEDS_DECISION",
    );
  });

  it("reads incidents, overdue and blocked work as something a person must do", () => {
    expect(watchedEventState(event({ critical_incidents: 1 }))).toBe("CANNOT_BE_AUTOMATED");
    expect(watchedEventState(event({ overdue_tasks: 1 }))).toBe("CANNOT_BE_AUTOMATED");
    expect(watchedEventState(event({ blocked_tasks: 1 }))).toBe("CANNOT_BE_AUTOMATED");
  });

  it("reads an event with none of the four as handled", () => {
    expect(watchedEventState(event())).toBe("HANDLED");
  });
});

describe("the visual's text alternative (requirement 15.12)", () => {
  it("states the same counts the nodes are drawn from", () => {
    const [view] = toWatchedEventViews([
      event({ pending_approvals: 2, critical_incidents: 1, overdue_tasks: 1, blocked_tasks: 1 }),
    ]);

    expect(view?.summary).toBe(
      "2 decisions waiting, 1 critical incident, 1 overdue task, 1 blocked task",
    );
    expect(view?.attentionCount).toBe(5);
  });

  it("says nothing is waiting when nothing is", () => {
    expect(toWatchedEventViews([event()])[0]?.summary).toBe("nothing waiting");
  });

  it("counts the nodes it drew, not the organization's events", () => {
    expect(orbitAlternative(toWatchedEventViews([event(), event({ event_id: "EVT-2" })]))).toBe(
      "2 active and published events in this view.",
    );
  });
});

describe("the calm state (requirement 4.8)", () => {
  it("is calm when no approval, incident or overdue task is open", () => {
    expect(nothingNeedsYou(toWatchedEventViews([event(), event({ blocked_tasks: 2 })]))).toBe(true);
  });

  it("is not calm when any of the three named counts is open", () => {
    expect(nothingNeedsYou(toWatchedEventViews([event({ overdue_tasks: 1 })]))).toBe(false);
    expect(nothingNeedsYou(toWatchedEventViews([event({ pending_approvals: 1 })]))).toBe(false);
    expect(nothingNeedsYou(toWatchedEventViews([event({ critical_incidents: 1 })]))).toBe(false);
  });
});

describe("the one decision (requirement 4.3)", () => {
  it("takes the oldest pending approval by requested_at, not by response order", () => {
    const oldest = oldestPendingApproval([
      approval({ approval_id: "APR-new", requested_at: "2026-10-05T09:00:00Z" }),
      approval({ approval_id: "APR-old", requested_at: "2026-10-01T09:00:00Z" }),
    ]);

    expect(oldest?.approval_id).toBe("APR-old");
  });

  it("ignores approvals that are no longer pending", () => {
    expect(
      oldestPendingApproval([
        approval({ approval_id: "APR-decided", status: "APPROVED", requested_at: "2020-01-01T00:00:00Z" }),
        approval({ approval_id: "APR-pending" }),
      ])?.approval_id,
    ).toBe("APR-pending");
  });

  it("sinks an unusable timestamp instead of treating it as the oldest", () => {
    expect(
      oldestPendingApproval([
        approval({ approval_id: "APR-unusable", requested_at: "not a time" }),
        approval({ approval_id: "APR-dated" }),
      ])?.approval_id,
    ).toBe("APR-dated");
  });

  it("returns nothing when nothing is pending", () => {
    expect(oldestPendingApproval([])).toBeNull();
    expect(oldestPendingApproval([approval({ status: "DECLINED" })])).toBeNull();
  });
});

describe("the note sent with a decision", () => {
  it("records an adjusted wording, since the request carries no edited_action", () => {
    expect(noteFor({ notes: "", editedAction: "Send a shorter note instead" })).toBe(
      "Send a shorter note instead",
    );
  });

  it("keeps the user's note when there is no edit", () => {
    expect(noteFor({ notes: "Not this week" })).toBe("Not this week");
  });
});
