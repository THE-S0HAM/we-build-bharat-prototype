import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";

import { getEvents } from "../api";
import { getIdToken } from "../auth";
import type { Event } from "../types";
import { EventContext } from "./eventContext";
import type { EventContextStatus, EventContextValue } from "./eventContext";
import {
  EVENT_URL_PARAM,
  findEvent,
  readStoredEvent,
  rememberEvent,
  resolveEvent,
} from "./eventResolution";

/**
 * Stable identity for "no events", so the memoised resolution and the context
 * value do not change on every render while loading or after a failure.
 */
const NO_EVENTS: readonly Event[] = [];

/** What `GET /events` has told us so far. */
type EventLoad =
  | { readonly phase: "loading" }
  | {
      readonly phase: "loaded";
      readonly events: readonly Event[];
      /** Read once, with the load, so no token is held while the page lives. */
      readonly storedEventId: string | null;
    }
  | { readonly phase: "failed"; readonly error: unknown };

/**
 * Events usable as context.
 *
 * The response is JSON from the network, so its shape is a claim rather than a
 * guarantee whatever `types.ts` says. An entry without a usable identifier is
 * dropped here, at the one place the response is read, so nothing downstream can
 * put an empty segment into `/events/{eventId}/…`.
 */
function usableEvents(response: { readonly events?: readonly Event[] }): readonly Event[] {
  const { events } = response;

  if (!Array.isArray(events)) {
    return NO_EVENTS;
  }

  return events.filter((event) => typeof event?.event_id === "string" && event.event_id !== "");
}

/** Which of the four published states the load and the resolution add up to. */
function statusOf(load: EventLoad, events: readonly Event[]): EventContextStatus {
  if (load.phase === "loading") return "loading";
  if (load.phase === "failed") return "failed";

  return events.length === 0 ? "empty" : "ready";
}

export interface EventProviderProps {
  children: ReactNode;
}

/**
 * Resolves the active event once the console is authenticated and publishes it
 * to the tree (design.md §5.4, requirements 3.7, 3.8, 3.9).
 *
 * ## The URL is the active event
 *
 * The resolved event is derived from the `event_id` URL parameter rather than
 * held in state beside it, and that single decision is what makes requirement
 * 3.8's "reflect the event in the URL" more than a cosmetic mirror:
 *
 *   - a link is shareable and a reload lands on the same event, because the URL
 *     *is* the selection rather than a copy of it that can drift;
 *   - Back and Forward move between events without any history bookkeeping here;
 *   - there is one source of truth, so "the URL says A, the state says B" is not
 *     a state this component can reach.
 *
 * The parameter is still untrusted input. It only ever selects among the events
 * `GET /events` returned, and an identifier absent from that response falls
 * through to the stored preference, then to the first ACTIVE event, then to the
 * earliest by start date (requirement 3.9). Whatever resolves is written back to
 * the URL, so a stale or forged identifier is replaced by the real one instead
 * of lingering in the address bar.
 *
 * Mounted inside `RequireSession`, so `GET /events` is never issued without a
 * session, and a sign-out followed by a different sign-in remounts the provider
 * and re-resolves from scratch.
 */
export function EventProvider({ children }: EventProviderProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [load, setLoad] = useState<EventLoad>({ phase: "loading" });

  /**
   * Generation counter for event loads. Only the newest may publish: a retry
   * resolving while the mount load is still in flight would otherwise be
   * overwritten by that older, staler answer. Same pattern as `SessionProvider`.
   */
  const generation = useRef(0);

  const loadEvents = useCallback(async () => {
    const probe = (generation.current += 1);

    setLoad({ phase: "loading" });

    try {
      // The token is read for the `sub` that keys the stored preference and is
      // then discarded — it is never placed in state (requirement 16.9).
      const storedEventId = readStoredEvent(await getIdToken());
      const response = await getEvents();

      if (probe !== generation.current) return;

      setLoad({ phase: "loaded", events: usableEvents(response), storedEventId });
    } catch (error) {
      if (probe !== generation.current) return;

      // No fall back to mock events. A failed lookup is reported as a failure,
      // because fabricated events would be fabricated operational state
      // (requirement 13.10, design.md §12.1).
      setLoad({ phase: "failed", error });
    }
  }, []);

  useEffect(() => {
    void loadEvents();

    // Retiring the generation on unmount drops any answer still in flight.
    return () => {
      generation.current += 1;
    };
  }, [loadEvents]);

  const events = load.phase === "loaded" ? load.events : NO_EVENTS;
  const storedEventId = load.phase === "loaded" ? load.storedEventId : null;
  const urlEventId = searchParams.get(EVENT_URL_PARAM);

  const resolved = useMemo(
    () => resolveEvent({ events, urlEventId, storedEventId }),
    [events, urlEventId, storedEventId],
  );

  const activeEventId = resolved.event?.event_id ?? null;

  /**
   * Reflect the active event in the URL (requirement 3.8).
   *
   * `replace` because resolving context is not a navigation the user made: it
   * must not add a history entry that Back would have to step over. It also runs
   * after a route change, where a sidebar link carried no parameter of its own,
   * and after a fall-through, where it overwrites an identifier the response did
   * not contain.
   *
   * This converges: once the parameter equals the resolved event the effect does
   * nothing, and the resolution derives from that same parameter.
   */
  useEffect(() => {
    if (activeEventId === null || urlEventId === activeEventId) return;

    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set(EVENT_URL_PARAM, activeEventId);
        return next;
      },
      { replace: true },
    );
  }, [activeEventId, urlEventId, setSearchParams]);

  /**
   * Persist the selection, keyed by the Cognito `sub` (requirement 3.8).
   *
   * Runs for the first resolution as well as for every later change, which is
   * design.md §5.4: every path through the resolution flow ends in "write to
   * `localStorage`, reflect in the URL". Only the identifier is written, never
   * anything about the event or the user (requirement 16.8).
   */
  useEffect(() => {
    if (activeEventId === null) return;

    let cancelled = false;

    void (async () => {
      const idToken = await getIdToken();

      // A newer selection must not be overwritten by this one landing late.
      if (!cancelled) {
        rememberEvent(idToken, activeEventId, events);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeEventId, events]);

  /**
   * Sole writer of event context from the UI (design.md §7): the top-bar
   * `EventSwitcher` and the Command Center's contextual visual both come through
   * here, and both are limited to the events the response contained.
   */
  const setActiveEvent = useCallback(
    (eventId: string): boolean => {
      if (findEvent(events, eventId) === null) {
        return false;
      }

      // Writing the URL is the selection; the effects above persist it and the
      // resolution above re-derives from it. This one pushes rather than
      // replaces: a switch is something the user did, so Back returns to the
      // event they were on.
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.set(EVENT_URL_PARAM, eventId);
        return next;
      });

      return true;
    },
    [events, setSearchParams],
  );

  const refresh = useCallback(() => {
    void loadEvents();
  }, [loadEvents]);

  const value = useMemo<EventContextValue>(
    () => ({
      status: statusOf(load, events),
      activeEvent: resolved.event,
      activeEventId,
      events,
      source: resolved.source,
      error: load.phase === "failed" ? load.error : null,
      setActiveEvent,
      refresh,
    }),
    [resolved, activeEventId, events, load, setActiveEvent, refresh],
  );

  return <EventContext.Provider value={value}>{children}</EventContext.Provider>;
}
