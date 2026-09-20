import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { useEventContext } from "../event/eventContext";
import type { Event } from "../types";
import "./EventSwitcher.css";

/**
 * Visually hidden prefix on the trigger, so the control announces what the name
 * beside it *is* rather than reading as a stray event name. `aria-haspopup` and
 * `aria-expanded` carry the rest: "Active event: DevCon Bengaluru 2026, button,
 * collapsed".
 */
const TRIGGER_CONTEXT = "Active event:";

/** Accessible name for the list itself, announced when it opens. */
const LIST_LABEL = "Switch the active event";

/**
 * The visible marker on the active option (requirement 15.10). `aria-selected`
 * alone would leave a sighted user reading weight and colour, and colour never
 * carries meaning on its own in this product (design.md §6.3).
 */
const CURRENT_MARKER = "Current";

/** While `GET /events` is in flight. Claims no event, because none is resolved. */
const LOADING_LABEL = "Loading events…";

/**
 * After a failed lookup. A statement, not a control: the retry belongs to the
 * content region, which renders `ErrorState` with "Try again" for the request
 * that actually failed (requirements 13.3, 13.8). A second retry in the top bar
 * would re-run the same request from two places.
 */
const UNAVAILABLE_LABEL = "Events unavailable";

/**
 * How one event reads in the switcher: name, and city when the response carried
 * one.
 *
 * Both values come straight from `GET /events`. The fall back to `event_id` is
 * deliberate — a record with no name renders its identifier rather than a
 * placeholder, because an invented label would be an invented event.
 */
function eventLabel(event: Event): string {
  const name = typeof event.name === "string" ? event.name.trim() : "";
  const city = typeof event.city === "string" ? event.city.trim() : "";
  const primary = name === "" ? event.event_id : name;

  return city === "" ? primary : `${primary} — ${city}`;
}

/**
 * EventSwitcher — the top bar's event context selector (requirement 3.11,
 * design.md §7).
 *
 * ## Sole writer
 *
 * Every change to event context from this component goes through the context's
 * `setActiveEvent`, which writes the URL, persists the preference and refuses an
 * identifier absent from `GET /events`. The switcher holds no event state of its
 * own: `activeEvent` and `events` are read from the context on every render, so
 * the trigger cannot show one event while the console operates on another, and
 * the list cannot offer an event the response did not contain.
 *
 * ## Deliberately quiet
 *
 * This is a context selector, not a feature. It renders as a line of text with a
 * dot and a chevron, borderless until hovered or opened, at `--fs-support` — the
 * top bar states which event you are acting for and then gets out of the way.
 *
 * ## Four context states, three of them without a menu
 *
 *   - `loading` — a muted placeholder. Rendering a name here would claim an
 *     event before one is resolved.
 *   - `failed` — a muted statement. See `UNAVAILABLE_LABEL`.
 *   - `empty` — nothing. The organization has no event, the shell says so once
 *     in the content region (requirement 3.10), and a switcher over an empty set
 *     would be a control that cannot act.
 *   - `ready` with one event — the name as plain text. A menu whose only option
 *     is already active is a control with nothing to do.
 *
 * ## Keyboard and ARIA
 *
 * A listbox behind a menu button, built here because the product adds no
 * dependency for it (design.md §6.3 has no chart or widget library):
 *
 *   - trigger: `aria-haspopup="listbox"`, `aria-expanded`, `aria-controls`
 *   - Down or Up on the trigger opens the list with focus on the active option
 *   - Down, Up, Home and End move focus between options; the list wraps
 *   - Enter or Space selects the focused option
 *   - Escape closes and returns focus to the trigger, as does selecting
 *   - Tab closes and lets focus move on naturally
 *   - a click outside closes without taking focus back, because the user has
 *     already chosen where focus should go
 *   - the active option carries `aria-selected` and a visible "Current" marker
 */
export function EventSwitcher() {
  const { status, activeEventId, events, setActiveEvent } = useEventContext();

  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);

  const listId = useId();

  const activeIndex = events.findIndex((event) => event.event_id === activeEventId);
  const activeEvent = activeIndex === -1 ? undefined : events[activeIndex];

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);

    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  /** Open with focus on the event currently in use, or on the first one. */
  const openList = useCallback(() => {
    setFocusedIndex(activeIndex === -1 ? 0 : activeIndex);
    setOpen(true);
  }, [activeIndex]);

  // Roving focus: the focused option holds the tab stop and real DOM focus, so
  // the platform announces each option as the user moves through the list.
  useEffect(() => {
    if (!open) return;

    optionRefs.current[focusedIndex]?.focus();
  }, [open, focusedIndex]);

  // A click anywhere else dismisses the list. `mousedown` rather than `click`,
  // so the list is gone before the click lands on whatever was underneath it.
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      const root = rootRef.current;

      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        // No focus return: the user is on their way somewhere else.
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [open]);

  /**
   * Apply a selection (requirement 3.8).
   *
   * `setActiveEvent` is the only writer of event context, and it answers whether
   * the selection applied. A `false` answer means the events changed under the
   * open list — a refresh landing mid-interaction — so the list closes and the
   * trigger keeps showing whatever is genuinely active. Nothing here reports a
   * switch that did not happen.
   */
  const choose = useCallback(
    (index: number) => {
      const event = events[index];

      if (event !== undefined) {
        setActiveEvent(event.event_id);
      }

      close(true);
    },
    [events, setActiveEvent, close],
  );

  /**
   * One handler on the wrapper, so Escape closes whether focus sits on the
   * trigger or on an option.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (!open) return;

      event.preventDefault();
      close(true);
      return;
    }

    if (event.key === "Tab") {
      // The browser owns Tab. The list closes rather than trapping focus: this
      // is a context selector, not a modal layer (design.md §7.1).
      setOpen(false);
      return;
    }

    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openList();
      }
      return;
    }

    const count = events.length;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setFocusedIndex((index) => (index + 1) % count);
        return;
      case "ArrowUp":
        event.preventDefault();
        setFocusedIndex((index) => (index - 1 + count) % count);
        return;
      case "Home":
        event.preventDefault();
        setFocusedIndex(0);
        return;
      case "End":
        event.preventDefault();
        setFocusedIndex(count - 1);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(focusedIndex);
        return;
      default:
        return;
    }
  };

  if (status === "loading" || status === "failed") {
    return (
      <p className="event-switcher event-switcher--pending">
        {/* Muted rather than brand: the dot marks the switcher's place in the
            row, and there is no event behind it yet. */}
        <span className="event-switcher__dot event-switcher__dot--pending" aria-hidden="true" />
        <span className="event-switcher__label">
          {status === "loading" ? LOADING_LABEL : UNAVAILABLE_LABEL}
        </span>
      </p>
    );
  }

  // `empty`, and the unreachable case of a resolved status with no active event.
  // Either way there is nothing true to render here.
  if (activeEvent === undefined) {
    return null;
  }

  if (events.length === 1) {
    return (
      <p className="event-switcher event-switcher--static">
        <span className="event-switcher__dot" aria-hidden="true" />
        <span className="event-switcher__label">
          <span className="event-switcher__assistive">{TRIGGER_CONTEXT} </span>
          {eventLabel(activeEvent)}
        </span>
      </p>
    );
  }

  return (
    <div className="event-switcher" ref={rootRef} onKeyDown={handleKeyDown}>
      <button
        type="button"
        className="event-switcher__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        ref={triggerRef}
        onClick={() => {
          if (open) {
            close(true);
          } else {
            openList();
          }
        }}
      >
        {/* Decorative. It marks the switcher, and says nothing about the event's
            status — status is `StatusBadge`'s alone (requirement 12.5). */}
        <span className="event-switcher__dot" aria-hidden="true" />
        <span className="event-switcher__label">
          <span className="event-switcher__assistive">{TRIGGER_CONTEXT} </span>
          {eventLabel(activeEvent)}
        </span>
        <span className="event-switcher__chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <ul className="event-switcher__list" id={listId} role="listbox" aria-label={LIST_LABEL}>
          {events.map((event, index) => {
            const selected = event.event_id === activeEventId;

            return (
              <li
                key={event.event_id}
                className={
                  selected
                    ? "event-switcher__option event-switcher__option--selected"
                    : "event-switcher__option"
                }
                role="option"
                aria-selected={selected}
                tabIndex={index === focusedIndex ? 0 : -1}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                onClick={() => {
                  choose(index);
                }}
              >
                <span className="event-switcher__option-name">{eventLabel(event)}</span>
                {selected ? (
                  <span className="event-switcher__option-marker">{CURRENT_MARKER}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
