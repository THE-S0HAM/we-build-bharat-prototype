/**
 * The session gate as the composed console wires it (design.md Property 2;
 * requirements 1.4, 1.5, 1.6, 3.7).
 *
 * `session/routeGuards.test.tsx` proves `RequireSession` behaves, over stub
 * routes. Property 2 is quantified over *protected routes*, not over one
 * component, so what is missing there and checked here is that the console's real
 * route table is actually behind the gate — every path `routes.ts` registers, the
 * capability-gated path, and an address that matches nothing.
 *
 * The proof that no page mounted is deliberately not "some page's text is
 * absent": pages are rebuilt phase by phase, and a test that reads their copy
 * would be asserting on work in progress. `EventProvider` sits immediately inside
 * the gate and calls `GET /events` on mount, so *that call not having happened*
 * is the structural evidence — nothing below the gate rendered, and nothing below
 * it fetched. It is also requirement 3.7 in its strongest form: the event lookup
 * is never issued without a session.
 *
 * Only two boundaries are replaced: the Cognito SDK, which jsdom cannot reach,
 * and `getEvents`. The rest of `api.ts` stays real so a page that does fetch
 * fails honestly rather than against a half-mocked module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";

import { App } from "./App";
import { CAPABILITIES } from "./capabilities";
import { navigableViewPaths } from "./routes";
import { readIntendedRoute, LOGIN_ROUTE } from "./session/intendedRoute";

/** Stand-in for the Cognito SDK's stored session. */
const cognito = vi.hoisted(() => ({ signedIn: true, signOutCalls: 0 }));

const api = vi.hoisted(() => ({ getEvents: vi.fn() }));

vi.mock("./auth", () => ({
  isAuthConfigured: true,
  isSignedIn: () => Promise.resolve(cognito.signedIn),
  signOut: () => {
    cognito.signOutCalls += 1;
    cognito.signedIn = false;
  },
  getIdToken: () => Promise.resolve(null),
  getSignedInEmail: () => null,
  getMemberOrganizations: () => Promise.resolve([]),
  signIn: () => Promise.resolve(),
  AuthError: class AuthError extends Error {},
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();

  return { ...actual, getEvents: api.getEvents };
});

/**
 * Every address a visitor can arrive at that is not `/login`: the registered
 * routes, the capability-gated one whose flag is off, and an unmatched address.
 * All three resolve inside `ProtectedLayout`, so all three are protected.
 */
const PROTECTED_PATHS: readonly string[] = [
  ...navigableViewPaths(CAPABILITIES),
  "/attendees",
  "/no-such-route",
];

/** An address that resolves to the not-found view: protected, and fetches nothing. */
const INERT_PROTECTED_PATH = "/no-such-route";

/** Where the router ended up, so a redirect can be read rather than inferred. */
function LocationProbe() {
  const location = useLocation();

  return (
    <p data-testid="intended">{readIntendedRoute(location.state) ?? "none"}</p>
  );
}

function renderConsole(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <App />
    </MemoryRouter>,
  );
}

/** The sign-in screen, identified by the form rather than by its prose. */
function loginForm(): HTMLElement | null {
  return screen.queryByLabelText("Email");
}

beforeEach(() => {
  cognito.signedIn = true;
  cognito.signOutCalls = 0;
  api.getEvents.mockResolvedValue({ events: [], count: 0 });
});

afterEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("a visitor with no session (Property 2, requirements 1.4, 1.5)", () => {
  it.each(PROTECTED_PATHS)(
    "resolves %s to the sign-in screen without mounting the route",
    async (path) => {
      cognito.signedIn = false;

      renderConsole(path);

      expect(await screen.findByLabelText("Email")).toBeInTheDocument();

      // The shell is the frame every protected route renders inside, so its
      // absence is the absence of all of them.
      expect(screen.queryByRole("navigation")).not.toBeInTheDocument();

      // Nothing below the gate mounted, so nothing below the gate fetched
      // (requirement 3.7).
      expect(api.getEvents).not.toHaveBeenCalled();
    },
  );

  it("retains the exact route asked for, search and hash included", async () => {
    cognito.signedIn = false;

    renderConsole("/speakers?status=confirmed#travel");

    await screen.findByLabelText("Email");

    // Requirement 1.5: a filtered, deep-linked view is the route they asked for,
    // not just its pathname.
    expect(screen.getByTestId("intended")).toHaveTextContent(
      "/speakers?status=confirmed#travel",
    );
  });

  it("keeps the login route public, so sign-in is reachable", async () => {
    cognito.signedIn = false;

    renderConsole(LOGIN_ROUTE);

    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByTestId("intended")).toHaveTextContent("none");
  });
});

describe("a session that has not resolved yet (requirement 1.4)", () => {
  it("renders the shell skeleton, never the login screen, and fetches nothing", async () => {
    renderConsole(INERT_PROTECTED_PATH);

    // Synchronous: the session probe has not settled. The frame is already
    // there — navigation does not move when the session lands — and the content
    // region is announced placeholders.
    expect(screen.getByRole("navigation")).toBeInTheDocument();

    const loading = screen.getByRole("status");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).toHaveTextContent("Restoring session…");
    expect(loginForm()).not.toBeInTheDocument();
    expect(api.getEvents).not.toHaveBeenCalled();

    // Once the session resolves, the event lookup happens — the ordering, rather
    // than the call, is the requirement.
    await waitFor(() => {
      expect(api.getEvents).toHaveBeenCalledTimes(1);
    });
  });
});

describe("signing out (requirement 1.6)", () => {
  it("returns to sign-in and tears the session's context down with it", async () => {
    renderConsole(INERT_PROTECTED_PATH);

    await waitFor(() => {
      expect(api.getEvents).toHaveBeenCalledTimes(1);
    });

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expect(cognito.signOutCalls).toBe(1);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();

    // The event context went with the shell rather than lingering behind the
    // login screen: no further lookup, and nothing of the ended session left to
    // hand to whoever signs in next.
    expect(api.getEvents).toHaveBeenCalledTimes(1);
  });
});
