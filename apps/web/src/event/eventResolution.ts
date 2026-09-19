/**
 * Which event the console is acting on.
 *
 * `App.tsx` used to answer this with `const EVENT_ID = "EVT-devcon-2026"` passed
 * to six pages (design.md A16): a build-time constant, identical for every user
 * of a deployment, and wrong for every organization that runs more than one
 * event. The answer now comes from `GET /events` — the organization's own event
 * list, already scoped by the token's `cognito:groups` claim on the way through
 * `tenancy.authorize_organization` (requirements 3.7, 3.8, 3.9).
 *
 * ## The event is never an input
 *
 * Two inputs are allowed to *express a preference* between events the response
 * already contains: an `event_id` URL parameter and a `localStorage` entry.
 * Neither can introduce one. Every candidate is matched against the fetched
 * list and discarded when it is absent, so editing a query string or storage
 * changes which of your own events you land on, and nothing else. This is what
 * keeps an unvalidated identifier out of `/events/{eventId}/…` request paths.
 *
 * It follows the same shape as `src/orgContext.ts`, deliberately: untrusted
 * input may only *choose among* values the backend already gave us, and the
 * precedence is a pure function so it can be read and tested on its own.
 *
 * ## Pure by design
 *
 * Every function takes the ID token as an argument rather than fetching one, so
 * the resolver runs in a test without a Cognito session, and the provider in
 * `EventProvider.tsx` holds no token in React state (requirement 16.9).
 *
 * Only an event identifier is persisted here — no attendee, speaker or personal
 * data, and never the token itself (requirements 16.8, 16.9).
 */

import { decodeTokenClaims } from "../lib/tokenClaims";
import type { Event } from "../types";

/**
 * URL parameter that may name an event.
 *
 * Spelled like the API's own identifiers and like `organization_id` in
 * `orgContext.ts`, which is the form anyone constructing such a link would
 * reach for — including someone testing whether the console trusts it.
 */
export const EVENT_URL_PARAM = "event_id";

/** Prefix for the stored preference; the Cognito `sub` completes the key. */
const EVENT_STORAGE_PREFIX = "communityops.event";

/**
 * Storage key for the preference, scoped to the token's Cognito `sub`
 * (requirement 3.8).
 *
 * Per-user keying follows design.md §5.4: a demo session and a real session in
 * the same browser must not inherit each other's event selection. Membership in
 * the fetched list is re-checked on read regardless, so a leaked key would still
 * select nothing.
 *
 * @returns the key, or `null` when the token carries no usable `sub` and the
 * preference therefore has nowhere unambiguous to live.
 */
function eventStorageKey(idToken: string | null): string | null {
  const subject = decodeTokenClaims(idToken)?.["sub"];

  return typeof subject === "string" && subject !== ""
    ? `${EVENT_STORAGE_PREFIX}.${subject}`
    : null;
}

/**
 * Read the stored event preference.
 *
 * The value is untrusted: it is whatever is in `localStorage`, which the user
 * and anything running in the page can write. Callers must match it against the
 * fetched events — `resolveEvent` does.
 *
 * @returns the stored identifier, or `null` when there is none or storage is
 * unavailable.
 */
export function readStoredEvent(idToken: string | null): string | null {
  const key = eventStorageKey(idToken);

  if (key === null) {
    return null;
  }

  try {
    return window.localStorage.getItem(key);
  } catch {
    // Storage can be disabled or full. A remembered event is a convenience, so
    // its absence resolves to the default event rather than failing a load.
    return null;
  }
}

/**
 * Persist an event preference for the next visit (requirement 3.8).
 *
 * Writes only when `events` contains `eventId`, so the stored value cannot be
 * poisoned through this path either. A rejected write is silent: the caller's
 * selection still applies to the current session, it just is not remembered.
 *
 * @returns whether the preference was stored.
 */
export function rememberEvent(
  idToken: string | null,
  eventId: string,
  events: readonly Event[],
): boolean {
  if (findEvent(events, eventId) === null) {
    return false;
  }

  const key = eventStorageKey(idToken);

  if (key === null) {
    return false;
  }

  try {
    window.localStorage.setItem(key, eventId);
    return true;
  } catch {
    return false;
  }
}

/** Where a resolved event came from, for diagnostics and for tests. */
export type EventResolutionSource = "url" | "storage" | "active" | "earliest" | "none";

export interface ResolvedEvent {
  /** The active event, or `null` when the response contained none. */
  readonly event: Event | null;
  readonly source: EventResolutionSource;
}

export interface ResolveEventOptions {
  /** Events `GET /events` returned, in response order. */
  readonly events: readonly Event[];
  /** The `event_id` URL parameter, or `null` when the URL names none. */
  readonly urlEventId: string | null;
  /** The stored preference, or `null` when there is none. */
  readonly storedEventId: string | null;
}

/**
 * The event with this identifier, or `null` when the list does not contain it.
 *
 * This is the membership test both untrusted candidates go through, and the
 * reason a forged identifier can only ever select one of the caller's own
 * events.
 */
export function findEvent(events: readonly Event[], eventId: string | null): Event | null {
  if (eventId === null || eventId === "") {
    return null;
  }

  return events.find((event) => event.event_id === eventId) ?? null;
}

/**
 * When an event starts, as a comparable number.
 *
 * An absent or unparseable date sorts last rather than sorting as 1970: a
 * malformed record must not win "earliest" and become the default event for the
 * whole organization.
 */
function startTime(event: Event): number {
  const parsed = typeof event.start_date === "string" ? Date.parse(event.start_date) : Number.NaN;

  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * The event that starts first.
 *
 * A strict comparison keeps response order for ties, so two events on the same
 * day resolve the same way on every load.
 */
function earliestByStartDate(events: readonly Event[]): Event | null {
  return events.reduce<Event | null>(
    (earliest, candidate) =>
      earliest === null || startTime(candidate) < startTime(earliest) ? candidate : earliest,
    null,
  );
}

/**
 * Resolve the active event (requirements 3.7, 3.9, design.md §5.4).
 *
 * Precedence, highest first:
 *
 *   1. the `event_id` URL parameter, **if `events` contains it**
 *   2. the stored preference, **if `events` contains it**
 *   3. the first ACTIVE event, in response order
 *   4. the first event by start date
 *
 * Steps 1 and 2 can only ever pick between values steps 3 and 4 would also
 * accept, so the resolved event is always a member of the fetched list
 * (design.md Property 13). A candidate that is absent from the response is not
 * an error and is not reported: resolution simply continues to the next source,
 * which is requirement 3.9 — a stale bookmark or a copied link to a deleted
 * event lands you on a working view rather than on a failure.
 *
 * Steps 3 and 4 differ on purpose. Requirement 3.7 words them as "first ACTIVE
 * event, first event by start date": the ACTIVE step takes the response's own
 * order, and only the last resort sorts. An event the organization is currently
 * running is the one being operated on, whatever its start date says.
 *
 * With an empty list there is nothing to resolve and the source is `none`; the
 * shell renders the no-events state (requirement 3.10).
 */
export function resolveEvent(options: ResolveEventOptions): ResolvedEvent {
  const { events, urlEventId, storedEventId } = options;

  const fromUrl = findEvent(events, urlEventId);

  if (fromUrl !== null) {
    return { event: fromUrl, source: "url" };
  }

  const fromStorage = findEvent(events, storedEventId);

  if (fromStorage !== null) {
    return { event: fromStorage, source: "storage" };
  }

  const firstActive = events.find((event) => event.status === "ACTIVE");

  if (firstActive !== undefined) {
    return { event: firstActive, source: "active" };
  }

  const earliest = earliestByStartDate(events);

  return earliest === null ? { event: null, source: "none" } : { event: earliest, source: "earliest" };
}
