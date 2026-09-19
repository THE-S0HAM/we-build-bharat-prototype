/**
 * The composed console once event context reaches the frame (requirements 3.10,
 * 3.11).
 *
 * `App.test.tsx` covers capability gating; this file covers the other half of the
 * shell's honesty about events, which only exists when the real `EventProvider`,
 * `Topbar`, `EventSwitcher` and `Sidebar` are composed the way `App` composes
 * them:
 *
 *   - **zero events** — the content region carries the no-events state and every
 *     event-scoped navigation entry is disabled rather than removed, which is the
 *     difference between "this organization has no event yet" and the capability
 *     gate's "this area does not exist" (requirement 3.10 versus 3.5);
 *   - **events resolved** — the top bar carries the switcher naming the active
 *     event, and the navigation is ordinary links again (requirement 3.11).
 *
 * `GET /events` is the only thing replaced, and only that one function: the rest
 * of `api.ts` stays real so a page that does fetch still fails honestly rather
 * than against a half-mocked module. Both cases are rendered on a route that
 * requests nothing of its own, so what is asserted is the frame and never a
 * page's data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import type { Event } from "./types";
import { App } from "./App";

const api = vi.hoisted(() => ({ events: [] as Event[] }));

vi.mock("./auth", () => ({
  isAuthConfigured: true,
  isSignedIn: () => Promise.resolve(true),
  signOut: () => undefined,
  getIdToken: () => Promise.resolve(null),
  getSignedInEmail: () => null,
  getMemberOrganizations: () => Promise.resolve([]),
  signIn: () => Promise.resolve(),
  AuthError: class AuthError extends Error {},
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();

  return {
    ...actual,
    getEvents: () => Promise.resolve({ events: api.events, count: api.events.length }),
  };
});

function eventWith(fields: Partial<Event> & { event_id: string }): Event {
  return {
    name: fields.event_id,
    description: "",
    status: "PUBLISHED",
    venue: "",
    city: "",
    start_date: "2026-01-01T09:00:00Z",
    end_date: "2026-01-01T18:00:00Z",
    expected_attendees: 0,
    registration_open: false,
    tags: [],
    ...fields,
  };
}

const DEVCON = eventWith({
  event_id: "EVT-devcon-2026",
  name: "DevCon Bengaluru 2026",
  city: "Bengaluru",
  status: "ACTIVE",
});
const PUNE = eventWith({ event_id: "EVT-pune", name: "AWS Community Day", city: "Pune" });

/** Event-scoped entries, per the nav config's own `eventScoped` marks. */
const EVENT_SCOPED_LABELS = [
  "SpeakerOps",
  "TeamOps",
  "IncidentOps",
  "Check-In",
  "Approvals",
  "Audit Log",
];

function renderConsole(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.events = [];
});

afterEach(() => {
  window.localStorage.clear();
});

describe("an organization with no events (requirement 3.10)", () => {
  it("renders the no-events state in the content region instead of the page", async () => {
    // `/speakers` is event-scoped, so with no event there is nothing for the page
    // to be scoped to — and the page never mounts, so it never fetches.
    renderConsole("/speakers");

    expect(await screen.findByRole("heading", { level: 1, name: "No events yet" })).toBeInTheDocument();
    expect(screen.getByText("This organization has no events.")).toBeInTheDocument();

    // A state, not a failure: no error treatment and no retry.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("disables every event-scoped navigation entry and keeps it visible", async () => {
    renderConsole("/speakers");
    await screen.findByRole("heading", { level: 1, name: "No events yet" });

    for (const label of EVENT_SCOPED_LABELS) {
      // Still present — the area is real and will work the moment an event exists
      // — but no longer a destination.
      const entry = screen.getByText(label).closest("[aria-disabled]");

      expect(entry, label).not.toBeNull();
      expect(entry).toHaveAttribute("aria-disabled", "true");
      expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
    }

    // The reason is in text beside the label, never in the colour alone
    // (requirement 15.10).
    expect(screen.getAllByText("Needs an event")).toHaveLength(EVENT_SCOPED_LABELS.length);

    // The Command Center is organization-level, so it stays a link.
    expect(screen.getByRole("link", { name: "Command Center" })).toBeInTheDocument();
  });

  it("renders no event switcher, because there is no event to name", async () => {
    renderConsole("/speakers");
    await screen.findByRole("heading", { level: 1, name: "No events yet" });

    expect(screen.queryByRole("button", { name: /Active event/ })).not.toBeInTheDocument();
    // And no demo-workspace chip either: no demo identity is configured.
    expect(screen.queryByText("Demo workspace")).not.toBeInTheDocument();
  });
});

describe("an organization with events (requirement 3.11)", () => {
  it("names the active event in the top bar and restores the navigation", async () => {
    api.events = [PUNE, DEVCON];

    // An unmatched address resolves to the not-found view inside the shell, which
    // is a protected route that requests nothing — so the frame is all that
    // renders.
    renderConsole("/no-such-route");

    // The first ACTIVE event, resolved by the provider from the response.
    const switcher = await screen.findByRole("button", { name: /Active event/ });
    expect(switcher).toHaveAccessibleName("Active event: DevCon Bengaluru 2026 — Bengaluru");

    for (const label of EVENT_SCOPED_LABELS) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }

    expect(screen.queryByText("Needs an event")).not.toBeInTheDocument();
    expect(screen.queryByText("This organization has no events.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
  });
});
