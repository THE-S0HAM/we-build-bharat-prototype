/**
 * The event context as the console sees it (requirements 3.7, 3.8, 3.9, 3.10).
 *
 * `GET /events` and the ID token are the only two things stubbed: the resolution,
 * the URL reflection and the stored preference are the real implementations, so
 * these checks fail if any of the three drifts apart from the others.
 *
 * What they pin down, from design.md Property 13: the active event is always a
 * member of the fetched response, and the same event comes back on reload for the
 * same user.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";

import type { Event } from "../types";
import { EventProvider } from "./EventProvider";
import { useEventContext } from "./eventContext";

const mocks = vi.hoisted(() => ({
  getEvents: vi.fn(),
  getIdToken: vi.fn(),
}));

vi.mock("../api", () => ({ getEvents: mocks.getEvents }));
vi.mock("../auth", () => ({ getIdToken: mocks.getIdToken }));

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

const PUBLISHED = eventWith({ event_id: "EVT-published", start_date: "2026-01-05T09:00:00Z" });
const ACTIVE = eventWith({
  event_id: "EVT-active",
  status: "ACTIVE",
  start_date: "2026-03-01T09:00:00Z",
});
const EVENTS = [PUBLISHED, ACTIVE];

function tokenFor(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `header.${payload}.signature`;
}

const STORAGE_KEY = "communityops.event.user-1";

/**
 * Reports the published context and offers the two writes a caller has: an
 * allowed selection and one the response never contained.
 */
function EventProbe() {
  const { status, activeEventId, events, source, setActiveEvent } = useEventContext();
  const { search } = useLocation();

  return (
    <div>
      <p data-testid="status">{status}</p>
      <p data-testid="active">{activeEventId ?? "none"}</p>
      <p data-testid="source">{source}</p>
      <p data-testid="selectable">{events.map((event) => event.event_id).join(",")}</p>
      <p data-testid="search">{search}</p>
      {EVENTS.map((event) => (
        <button key={event.event_id} type="button" onClick={() => setActiveEvent(event.event_id)}>
          Switch to {event.event_id}
        </button>
      ))}
      <button type="button" onClick={() => setActiveEvent("EVT-somewhere-else")}>
        Switch to a foreign event
      </button>
    </div>
  );
}

/** Renders the provider and waits for `GET /events` to have been answered. */
async function renderProvider(initialEntry = "/speakers") {
  const view = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <EventProvider>
        <EventProbe />
      </EventProvider>
    </MemoryRouter>,
  );

  await waitFor(() => {
    expect(screen.getByTestId("status")).not.toHaveTextContent("loading");
  });

  return view;
}

beforeEach(() => {
  mocks.getIdToken.mockResolvedValue(tokenFor({ sub: "user-1" }));
  mocks.getEvents.mockResolvedValue({ events: EVENTS, count: EVENTS.length });
});

afterEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("event context resolution", () => {
  it("defaults to the first ACTIVE event, writes it to storage and reflects it in the URL", async () => {
    await renderProvider("/speakers?tab=travel");

    expect(screen.getByTestId("active")).toHaveTextContent("EVT-active");
    expect(screen.getByTestId("selectable")).toHaveTextContent("EVT-published,EVT-active");

    // Requirement 3.8: the URL carries the event so the view is shareable and
    // reloadable, and the parameter it already had is still there.
    await waitFor(() => {
      expect(screen.getByTestId("search")).toHaveTextContent("event_id=EVT-active");
    });
    expect(screen.getByTestId("search")).toHaveTextContent("tab=travel");

    await waitFor(() => {
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("EVT-active");
    });
  });

  it("restores the stored preference for the same user", async () => {
    window.localStorage.setItem(STORAGE_KEY, "EVT-published");

    await renderProvider();

    // Design.md Property 13's second half: the same event comes back for the
    // same user, which is what makes the preference worth storing at all.
    expect(screen.getByTestId("active")).toHaveTextContent("EVT-published");
  });

  it("honours an event named in the URL", async () => {
    await renderProvider("/speakers?event_id=EVT-published");

    expect(screen.getByTestId("active")).toHaveTextContent("EVT-published");
    expect(screen.getByTestId("source")).toHaveTextContent("url");
  });

  it("falls through and rewrites the URL when it names an event the response does not contain", async () => {
    window.localStorage.setItem(STORAGE_KEY, "EVT-published");

    await renderProvider("/speakers?event_id=EVT-somewhere-else");

    // Requirement 3.9: fall through to the stored preference, and replace the
    // identifier in the address bar rather than leave a fiction in it.
    expect(screen.getByTestId("active")).toHaveTextContent("EVT-published");
    await waitFor(() => {
      expect(screen.getByTestId("search")).toHaveTextContent("event_id=EVT-published");
    });
    expect(screen.getByTestId("search")).not.toHaveTextContent("EVT-somewhere-else");
  });

  it("falls through when the stored preference names an event the response does not contain", async () => {
    window.localStorage.setItem(STORAGE_KEY, "EVT-deleted");

    await renderProvider();

    expect(screen.getByTestId("active")).toHaveTextContent("EVT-active");

    // The stale preference is replaced by the event actually in use, so the next
    // load does not repeat the fall-through.
    await waitFor(() => {
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("EVT-active");
    });
  });

  it("returns to the same event after a reload, through its own write", async () => {
    // Property 13's second half, end to end rather than from a preloaded key: the
    // first visit resolves and persists, the reload reads back what the provider
    // itself wrote. The URL names the event that is *not* the default, which is
    // the only way a restored preference can be told apart from a fresh
    // resolution landing on EVT-active by coincidence.
    const first = await renderProvider("/speakers?event_id=EVT-published");

    expect(screen.getByTestId("active")).toHaveTextContent("EVT-published");
    await waitFor(() => {
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("EVT-published");
    });

    first.unmount();

    // The reload: a new tree, a URL naming no event, the same user.
    await renderProvider("/speakers");

    expect(screen.getByTestId("active")).toHaveTextContent("EVT-published");
    expect(screen.getByTestId("source")).toHaveTextContent("storage");
  });

  it("does not read another session's stored preference", async () => {
    window.localStorage.setItem("communityops.event.user-2", "EVT-published");

    await renderProvider();

    expect(screen.getByTestId("active")).toHaveTextContent("EVT-active");
  });

  it("reports the empty response without an active event", async () => {
    mocks.getEvents.mockResolvedValue({ events: [], count: 0 });

    await renderProvider();

    // Requirement 3.10's no-events state is the shell's to render; the context's
    // job is to say so honestly and name no event.
    expect(screen.getByTestId("status")).toHaveTextContent("empty");
    expect(screen.getByTestId("active")).toHaveTextContent("none");
  });

  it("reports a failed lookup instead of falling back to fabricated events", async () => {
    mocks.getEvents.mockRejectedValue(new Error("network down"));

    await renderProvider();

    expect(screen.getByTestId("status")).toHaveTextContent("failed");
    expect(screen.getByTestId("active")).toHaveTextContent("none");
    expect(screen.getByTestId("selectable")).toBeEmptyDOMElement();
  });
});

describe("changing the active event", () => {
  it("switches to another event from the response, in the URL and in storage", async () => {
    await renderProvider();

    await userEvent.click(screen.getByRole("button", { name: "Switch to EVT-published" }));

    expect(screen.getByTestId("active")).toHaveTextContent("EVT-published");
    expect(screen.getByTestId("search")).toHaveTextContent("event_id=EVT-published");

    await waitFor(() => {
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("EVT-published");
    });
  });

  it("ignores a selection the response did not contain", async () => {
    await renderProvider();

    await userEvent.click(screen.getByRole("button", { name: "Switch to a foreign event" }));

    expect(screen.getByTestId("active")).toHaveTextContent("EVT-active");
    expect(screen.getByTestId("search")).not.toHaveTextContent("EVT-somewhere-else");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("EVT-active");
  });
});
