/**
 * Behaviour checks on the top bar's event context selector (requirements 3.8,
 * 3.11, 15.5, 15.10).
 *
 * Two rules are worth protecting here, and neither is cosmetic:
 *
 *   - **The switcher writes event context and never holds it.** It reads
 *     `activeEventId` and `events` from the context on every render and applies a
 *     selection only through `setActiveEvent`, which refuses an identifier absent
 *     from `GET /events`. So the trigger cannot claim one event while the console
 *     operates on another, and the list cannot offer an event the response did not
 *     contain (requirement 3.11).
 *   - **It never claims an event it does not have.** Loading and failed states
 *     render a statement, an organization with no events renders nothing, and a
 *     single event renders text rather than a menu with one option.
 *
 * The context is supplied directly rather than through `EventProvider`: these are
 * statements about the switcher's response to each context state, and the
 * provider's own resolution is covered by `EventProvider.test.tsx`.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Event } from "../types";
import { EventContext } from "../event/eventContext";
import type { EventContextValue } from "../event/eventContext";
import { EventSwitcher } from "./EventSwitcher";

function event(overrides: Partial<Event> & { event_id: string }): Event {
  return {
    name: "",
    description: "",
    status: "ACTIVE",
    venue: "",
    city: "",
    start_date: "2026-10-15T09:00:00Z",
    end_date: "2026-10-15T18:00:00Z",
    expected_attendees: 0,
    registration_open: true,
    tags: [],
    ...overrides,
  };
}

const PUNE = event({ event_id: "EVT-pune", name: "AWS Community Day", city: "Pune" });
const DEVCON = event({
  event_id: "EVT-devcon-2026",
  name: "DevCon Bengaluru 2026",
  city: "Bengaluru",
});

function renderSwitcher(context: Partial<EventContextValue>) {
  const setActiveEvent = vi.fn(() => true);

  const value: EventContextValue = {
    status: "ready",
    activeEvent: null,
    activeEventId: null,
    events: [],
    source: "none",
    error: null,
    setActiveEvent,
    refresh: () => undefined,
    ...context,
  };

  render(
    <EventContext.Provider value={value}>
      <EventSwitcher />
    </EventContext.Provider>,
  );

  return { setActiveEvent };
}

function trigger(): HTMLElement {
  return screen.getByRole("button", { name: /Active event/ });
}

describe("EventSwitcher context states", () => {
  it("claims no event while the lookup is in flight", () => {
    renderSwitcher({ status: "loading" });

    expect(screen.getByText("Loading events…")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("states that the lookup failed, and leaves the retry to the content region", () => {
    renderSwitcher({ status: "failed", error: { category: "INTERNAL_ERROR" } });

    expect(screen.getByText("Events unavailable")).toBeInTheDocument();
    // A second "Try again" in the top bar would re-run the same request from two
    // places (requirements 13.3, 13.8).
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders nothing when the organization has no events", () => {
    const { container } = render(
      <EventContext.Provider
        value={{
          status: "empty",
          activeEvent: null,
          activeEventId: null,
          events: [],
          source: "none",
          error: null,
          setActiveEvent: () => false,
          refresh: () => undefined,
        }}
      >
        <EventSwitcher />
      </EventContext.Provider>,
    );

    // The no-events state belongs to the shell (requirement 3.10); a switcher
    // over an empty set would be a control that cannot act.
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a single event as text rather than as a menu with one option", () => {
    renderSwitcher({
      status: "ready",
      events: [DEVCON],
      activeEvent: DEVCON,
      activeEventId: DEVCON.event_id,
    });

    expect(screen.getByText(/DevCon Bengaluru 2026 — Bengaluru/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("EventSwitcher selection", () => {
  it("names the active event and announces what the name is", () => {
    renderSwitcher({
      status: "ready",
      events: [DEVCON, PUNE],
      activeEvent: PUNE,
      activeEventId: PUNE.event_id,
    });

    // "Active event: AWS Community Day — Pune", not a stray event name.
    expect(trigger()).toHaveAccessibleName("Active event: AWS Community Day — Pune");
    expect(trigger()).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("offers exactly the events the response contained, marking the active one", async () => {
    renderSwitcher({
      status: "ready",
      events: [DEVCON, PUNE],
      activeEvent: PUNE,
      activeEventId: PUNE.event_id,
    });

    await userEvent.click(trigger());

    expect(trigger()).toHaveAttribute("aria-expanded", "true");

    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "DevCon Bengaluru 2026 — Bengaluru",
      "AWS Community Day — PuneCurrent",
    ]);

    // The active option carries `aria-selected` and a visible marker, so it is
    // never identified by colour alone (requirement 15.10).
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("Current")).toBeInTheDocument();
  });

  it("applies a selection through the context and closes", async () => {
    const { setActiveEvent } = renderSwitcher({
      status: "ready",
      events: [DEVCON, PUNE],
      activeEvent: PUNE,
      activeEventId: PUNE.event_id,
    });

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("option", { name: /DevCon Bengaluru 2026/ }));

    // The one writer of event context, with an identifier from the response.
    expect(setActiveEvent).toHaveBeenCalledTimes(1);
    expect(setActiveEvent).toHaveBeenCalledWith(DEVCON.event_id);

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it("keeps showing the genuinely active event when a selection does not apply", async () => {
    const setActiveEvent = vi.fn(() => false);

    render(
      <EventContext.Provider
        value={{
          status: "ready",
          activeEvent: PUNE,
          activeEventId: PUNE.event_id,
          events: [DEVCON, PUNE],
          source: "url",
          error: null,
          setActiveEvent,
          refresh: () => undefined,
        }}
      >
        <EventSwitcher />
      </EventContext.Provider>,
    );

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("option", { name: /DevCon Bengaluru 2026/ }));

    // The events changed under the open list, so nothing here reports a switch
    // that did not happen: the trigger still names the active event.
    expect(trigger()).toHaveAccessibleName("Active event: AWS Community Day — Pune");
  });

  it("opens from the keyboard, moves between options and selects with Enter", async () => {
    const { setActiveEvent } = renderSwitcher({
      status: "ready",
      events: [DEVCON, PUNE],
      activeEvent: DEVCON,
      activeEventId: DEVCON.event_id,
    });

    trigger().focus();
    await userEvent.keyboard("{ArrowDown}");

    // Opens with focus on the event currently in use.
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /DevCon Bengaluru 2026/ })).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /AWS Community Day/ })).toHaveFocus();

    await userEvent.keyboard("{Enter}");
    expect(setActiveEvent).toHaveBeenCalledWith(PUNE.event_id);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    renderSwitcher({
      status: "ready",
      events: [DEVCON, PUNE],
      activeEvent: DEVCON,
      activeEventId: DEVCON.event_id,
    });

    await userEvent.click(trigger());
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });
});
