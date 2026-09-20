/**
 * Event resolution.
 *
 * The behaviour under test is requirements 3.7 and 3.9: the four resolution
 * sources in order, and the rule that a URL parameter or a stored preference may
 * pick between events `GET /events` returned and can introduce nothing. Someone
 * editing a query string or `localStorage` must end up on one of their own
 * organization's events.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../types";
import { rememberEvent, resolveEvent, readStoredEvent } from "./eventResolution";

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

/**
 * Three events whose response order, status and start dates disagree on
 * purpose, so a test asserting one resolution source cannot pass by accident
 * through another.
 */
const PUBLISHED_EARLIEST = eventWith({
  event_id: "EVT-earliest",
  status: "PUBLISHED",
  start_date: "2026-01-05T09:00:00Z",
});
const ACTIVE_LATER = eventWith({
  event_id: "EVT-active",
  status: "ACTIVE",
  start_date: "2026-03-01T09:00:00Z",
});
const COMPLETED_LATEST = eventWith({
  event_id: "EVT-completed",
  status: "COMPLETED",
  start_date: "2026-06-01T09:00:00Z",
});

const EVENTS: readonly Event[] = [PUBLISHED_EARLIEST, ACTIVE_LATER, COMPLETED_LATEST];

function tokenFor(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `header.${payload}.signature`;
}

const TOKEN = tokenFor({ sub: "user-1" });
const STORAGE_KEY = "communityops.event.user-1";

afterEach(() => {
  window.localStorage.clear();
});

describe("resolveEvent", () => {
  it("uses the first ACTIVE event when nothing expresses a preference", () => {
    // Not the earliest by start date: an event the organization is running is
    // the one being operated on (requirement 3.7).
    expect(
      resolveEvent({ events: EVENTS, urlEventId: null, storedEventId: null }),
    ).toEqual({ event: ACTIVE_LATER, source: "active" });
  });

  it("uses the earliest event by start date when none is ACTIVE", () => {
    expect(
      resolveEvent({
        events: [COMPLETED_LATEST, PUBLISHED_EARLIEST],
        urlEventId: null,
        storedEventId: null,
      }),
    ).toEqual({ event: PUBLISHED_EARLIEST, source: "earliest" });
  });

  it("keeps response order when a start date is missing or unparseable", () => {
    const undated = eventWith({ event_id: "EVT-undated", status: "DRAFT", start_date: "" });

    // An unparseable date must not sort as 1970 and become the organization's
    // default event.
    expect(
      resolveEvent({
        events: [undated, COMPLETED_LATEST],
        urlEventId: null,
        storedEventId: null,
      }),
    ).toMatchObject({ event: COMPLETED_LATEST, source: "earliest" });
  });

  it("honours an event named in the URL", () => {
    expect(
      resolveEvent({ events: EVENTS, urlEventId: "EVT-completed", storedEventId: null }),
    ).toEqual({ event: COMPLETED_LATEST, source: "url" });
  });

  it("honours a stored preference when the URL names none", () => {
    expect(
      resolveEvent({ events: EVENTS, urlEventId: null, storedEventId: "EVT-earliest" }),
    ).toEqual({ event: PUBLISHED_EARLIEST, source: "storage" });
  });

  it("falls through to the stored preference when the URL names an absent event", () => {
    // Requirement 3.9: a copied link to a deleted event lands on a working view.
    expect(
      resolveEvent({
        events: EVENTS,
        urlEventId: "EVT-somewhere-else",
        storedEventId: "EVT-completed",
      }),
    ).toEqual({ event: COMPLETED_LATEST, source: "storage" });
  });

  it("falls through to the first ACTIVE event when the stored preference is absent", () => {
    expect(
      resolveEvent({
        events: EVENTS,
        urlEventId: "EVT-somewhere-else",
        storedEventId: "EVT-deleted",
      }),
    ).toEqual({ event: ACTIVE_LATER, source: "active" });
  });

  it("resolves no event when the response is empty", () => {
    expect(
      resolveEvent({ events: [], urlEventId: "EVT-active", storedEventId: "EVT-active" }),
    ).toEqual({ event: null, source: "none" });
  });
});

describe("Property 13 — the resolved event is always one the response contained", () => {
  /**
   * The cases above each pin one resolution source. This one states the
   * invariant the four sources exist to preserve, over the whole input space
   * that reaches them: a URL parameter and a stored preference, both untrusted,
   * against event lists that resolve differently from one another.
   *
   * It is the guarantee that keeps an unvalidated identifier out of an
   * `/events/{eventId}/…` request path, so it is worth checking as a property
   * rather than as six examples.
   */
  const RESPONSES: readonly { readonly name: string; readonly events: readonly Event[] }[] = [
    { name: "an empty response", events: [] },
    { name: "a single event", events: [PUBLISHED_EARLIEST] },
    { name: "no ACTIVE event", events: [COMPLETED_LATEST, PUBLISHED_EARLIEST] },
    {
      name: "two ACTIVE events",
      events: [ACTIVE_LATER, eventWith({ event_id: "EVT-active-2", status: "ACTIVE" })],
    },
    {
      name: "an undated record",
      events: [eventWith({ event_id: "EVT-undated", status: "DRAFT", start_date: "" }), COMPLETED_LATEST],
    },
    { name: "the full response", events: EVENTS },
  ];

  /**
   * What can arrive in a URL or in `localStorage`. Two of these are real
   * identifiers and are allowed to win; the rest are absences, near misses and
   * inherited object properties, none of which may select anything.
   */
  const CANDIDATES: readonly (string | null)[] = [
    null,
    "",
    " ",
    "EVT-somewhere-else",
    "EVT-active ",
    "evt-active",
    "__proto__",
    "constructor",
    "toString",
    "EVT-earliest",
    "EVT-active",
  ];

  for (const { name, events } of RESPONSES) {
    it(`resolves within ${name}, whatever the URL and storage say`, () => {
      const identifiers = events.map((event) => event.event_id);

      for (const urlEventId of CANDIDATES) {
        for (const storedEventId of CANDIDATES) {
          const inputs = `url=${String(urlEventId)} stored=${String(storedEventId)}`;
          const { event, source } = resolveEvent({ events, urlEventId, storedEventId });

          if (events.length === 0) {
            // Nothing to resolve, and nothing invented to fill the gap.
            expect(event, inputs).toBeNull();
            expect(source, inputs).toBe("none");
            continue;
          }

          // Referential membership: the active event is one of the objects the
          // response returned, not a lookalike built from an input.
          expect(event, inputs).not.toBeNull();
          expect(events, inputs).toContain(event);

          // And an input is only ever credited when it named an event exactly.
          if (source === "url") {
            expect(event?.event_id, inputs).toBe(urlEventId);
          } else {
            expect(identifiers, inputs).not.toContain(urlEventId);
          }

          if (source === "storage") {
            expect(event?.event_id, inputs).toBe(storedEventId);
          }
        }
      }
    });
  }
});

describe("readStoredEvent", () => {
  it("reads the preference keyed by the token's Cognito sub", () => {
    window.localStorage.setItem(STORAGE_KEY, "EVT-completed");

    expect(readStoredEvent(TOKEN)).toBe("EVT-completed");
  });

  it("does not read another session's preference", () => {
    window.localStorage.setItem("communityops.event.user-2", "EVT-completed");

    expect(readStoredEvent(TOKEN)).toBeNull();
  });

  it("reads nothing when the token carries no usable sub", () => {
    window.localStorage.setItem(STORAGE_KEY, "EVT-completed");

    expect(readStoredEvent(null)).toBeNull();
    expect(readStoredEvent(tokenFor({ name: "Demo Lead" }))).toBeNull();
  });
});

describe("rememberEvent", () => {
  it("stores an event the response contained", () => {
    expect(rememberEvent(TOKEN, "EVT-completed", EVENTS)).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("EVT-completed");
  });

  it("refuses to store an event the response did not contain", () => {
    expect(rememberEvent(TOKEN, "EVT-somewhere-else", EVENTS)).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
