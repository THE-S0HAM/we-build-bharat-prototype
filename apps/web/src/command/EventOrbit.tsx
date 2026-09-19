import { useId } from "react";

import { StatusBadge } from "../components/StatusBadge";
import { ORBIT_EMPTY, ORBIT_HEADING, orbitAlternative, type WatchedEventView } from "./commandView";

import "./EventOrbit.css";

/**
 * The Command Center's one contextual visual (requirements 4.4, 4.5, 12.10).
 *
 * An orbit: the organization at the centre, one node per **watched** event on the
 * ring — `events[]` from `GET /command-center`, which is ACTIVE and PUBLISHED
 * events only, so a draft is never drawn as something CommunityOps is watching
 * (A13). Node treatment comes from that event's real `pending_approvals`,
 * `critical_incidents`, `overdue_tasks` and `blocked_tasks` and from nothing
 * else; selecting a node sets the active event (requirement 4.5).
 *
 * ## How it stays honest
 *
 *   - **No colour is mapped here.** Each node's operational state is rendered by
 *     `StatusBadge`, the only component permitted to turn a state into a colour
 *     (requirement 12.5), and it always carries the words. This component's own
 *     stylesheet distinguishes nodes by ring weight through `data-state`, never
 *     by hue, so the picture survives without colour perception
 *     (requirement 15.10).
 *   - **Every node is a real button.** Keyboard reachable and operable, with the
 *     platform's focus ring, `aria-current` on the active event, and its
 *     accessible name taken from the text it displays (requirements 15.1, 15.3).
 *   - **The same counts are stated in text** below the ring, so the visual is
 *     never the only way to read them (requirement 15.12).
 *   - **No autonomous animation under reduced motion** — the one movement in the
 *     stylesheet is declared inside a `prefers-reduced-motion: no-preference`
 *     block, so it is structurally absent rather than overridden
 *     (requirement 15.11).
 *
 * ## Geometry without an inline style
 *
 * Node positions are CSS, not JavaScript: the container carries `data-count` and
 * each node its `data-slot`, and the stylesheet turns the pair into an angle on
 * the ring with `calc`. That keeps the page free of style literals
 * (requirement 12.2) while the layout still comes from the real number of
 * watched events. Beyond `ORBIT_SLOTS` events the slots repeat, which crowds the
 * ring rather than breaking it — and the text alternative is unaffected.
 */

/** Positions on the ring. Beyond this, slots repeat (see the note above). */
export const ORBIT_SLOTS = 12;

export interface EventOrbitProps {
  readonly events: readonly WatchedEventView[];

  /** The event the console is currently scoped to, marked with `aria-current`. */
  readonly activeEventId: string | null;

  /**
   * Sets the active event (requirement 4.5). The orbit is a caller of event
   * context, never a second owner of it: it reports the selection and renders
   * whatever the context then publishes.
   */
  readonly onSelect: (eventId: string) => void;
}

export function EventOrbit({ events, activeEventId, onSelect }: EventOrbitProps) {
  const headingId = useId();

  return (
    <section className="event-orbit" aria-labelledby={headingId}>
      <h2 className="event-orbit__heading" id={headingId}>
        {ORBIT_HEADING}
      </h2>

      {events.length === 0 ? (
        <p className="event-orbit__empty">{ORBIT_EMPTY}</p>
      ) : (
        <>
          <div className="event-orbit__stage" data-count={Math.min(events.length, ORBIT_SLOTS)}>
            {/* Decorative: the rings carry no information the text below does
                not state, so they are hidden from assistive technology. */}
            <svg
              className="event-orbit__rings"
              viewBox="0 0 100 100"
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
              focusable="false"
            >
              <circle className="event-orbit__ring" cx="50" cy="50" r="46" />
              <circle className="event-orbit__ring" cx="50" cy="50" r="30" />
            </svg>

            <p className="event-orbit__hub" aria-hidden="true">
              <span className="event-orbit__hub-count">{events.length}</span>
              <span className="event-orbit__hub-label">watched</span>
            </p>

            <ul className="event-orbit__slots">
              {events.map((event, index) => (
                <li
                  className="event-orbit__slot"
                  data-slot={index % ORBIT_SLOTS}
                  key={event.eventId}
                >
                  <button
                    type="button"
                    className="event-orbit__node"
                    data-state={event.state}
                    aria-current={event.eventId === activeEventId ? "true" : undefined}
                    onClick={() => {
                      onSelect(event.eventId);
                    }}
                  >
                    {/* `title` because a long event name is truncated on the
                        ring; the accessible name is the full text either way. */}
                    <span className="event-orbit__node-name" title={event.name}>
                      {event.name}
                    </span>
                    <StatusBadge domain="operational" status={event.state} />
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* The text alternative: the same counts, in the same order as the
              ring (requirement 15.12). */}
          <p className="event-orbit__alternative">{orbitAlternative(events)}</p>

          <ul className="event-orbit__readout">
            {events.map((event) => (
              <li className="event-orbit__readout-item" key={event.eventId}>
                <span className="event-orbit__readout-name">{event.name}</span>
                <span className="event-orbit__readout-counts">{event.summary}.</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
