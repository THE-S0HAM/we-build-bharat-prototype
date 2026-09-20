/**
 * Event context for the console (design.md §5.4, "State Model",
 * requirements 3.7–3.10).
 *
 * There is exactly one active event in the product and it lives here. The
 * provider in `EventProvider.tsx` owns the conversation with `GET /events`, the
 * stored preference and the URL; this context owns the answers the rest of the
 * console needs from it: *which event is active, which events may be chosen, and
 * is there an answer yet?*
 *
 * What this context deliberately does NOT hold:
 *
 *   - **No token.** The Cognito `sub` is needed to key the stored preference, so
 *     the provider reads a token when it persists and discards it immediately.
 *     Tokens stay in the Cognito SDK's storage (requirement 16.9).
 *   - **No event data beyond `GET /events`.** Speakers, tasks, approvals and
 *     audit entries stay local to the page that requests them ("State Model"):
 *     this context publishes an identifier, not a cache.
 *   - **No personal data.** Only an event identifier is persisted
 *     (requirement 16.8).
 *
 * Reading an event id here grants nothing. Every request naming it is still
 * authorized by API Gateway and `tenancy.authorize_organization`, which refuse
 * an event outside the caller's organization whatever this resolves
 * (requirement 16.2).
 */

import { createContext, useContext } from "react";

import type { Event } from "../types";
import type { EventResolutionSource } from "./eventResolution";

/**
 * Four states, and the first and last are the reason this is not just an
 * identifier.
 *
 *   - `loading` — `GET /events` is in flight. Not "no events": an event-scoped
 *     page must not fetch with a guessed identifier, so it renders a skeleton
 *     until this resolves (requirement 13.1).
 *   - `ready` — at least one event came back and one of them is active.
 *   - `empty` — the response was empty. The shell renders the no-events state
 *     and disables the event-scoped navigation entries (requirement 3.10).
 *   - `failed` — the request failed. Distinct from `empty` on purpose: "this
 *     organization has no events" and "we could not find out" are different
 *     sentences, and only one of them offers a retry (design.md §12).
 */
export type EventContextStatus = "loading" | "ready" | "empty" | "failed";

export interface EventContextValue {
  readonly status: EventContextStatus;

  /** The active event, or `null` unless `status` is `ready`. */
  readonly activeEvent: Event | null;

  /**
   * The active event's identifier, the value event-scoped pages send.
   *
   * Always one of `events`, never a caller-supplied string (requirement 3.9,
   * design.md Property 13).
   */
  readonly activeEventId: string | null;

  /**
   * Events `GET /events` returned, in response order.
   *
   * This is the selectable set: any surface offering a choice of event offers
   * exactly these, so the selection is a member of the response by construction.
   */
  readonly events: readonly Event[];

  /**
   * Where the active event is being read from, for diagnostics.
   *
   * This is the answer for the *current* inputs, not a record of how the event
   * was first chosen: the provider writes its resolution back to the URL
   * (requirement 3.8), so a default that started as `active` reads as `url` once
   * it has been reflected. `resolveEvent` is the place to observe the precedence
   * itself — it is a pure function over the three inputs.
   */
  readonly source: EventResolutionSource;

  /**
   * The failure from `GET /events`, for `ErrorState` to categorise. `null`
   * unless `status` is `failed`. Typed `unknown` because a rejected promise can
   * carry anything, and nothing here may read it as a message.
   */
  readonly error: unknown;

  /**
   * Make another event active (requirement 3.8).
   *
   * Writes the URL and the stored preference. An identifier absent from `events`
   * is ignored rather than applied, so the switcher cannot introduce an event
   * the response did not contain.
   *
   * @returns whether the selection applied.
   */
  setActiveEvent(eventId: string): boolean;

  /**
   * Re-run `GET /events` only (requirement 13.3).
   *
   * Never a page reload, and never a fall back to mock data: a failed event
   * lookup surfaces as a failure, because fabricated events would be fabricated
   * operational state (requirement 13.10).
   */
  refresh(): void;
}

/**
 * `null` marks "no provider above me", which `useEventContext` turns into a
 * thrown error rather than a silent default. A default value here would let a
 * page render as though an event were resolved — with no event, or with someone
 * else's — and neither is a truth this module can know.
 */
export const EventContext = createContext<EventContextValue | null>(null);

export function useEventContext(): EventContextValue {
  const context = useContext(EventContext);

  if (context === null) {
    throw new Error("useEventContext must be called inside an EventProvider.");
  }

  return context;
}
