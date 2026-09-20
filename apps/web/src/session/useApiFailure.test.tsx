/**
 * Session-level error handling — the behaviour column of design.md §12
 * (requirements 1.8, 13.4, 13.7).
 *
 * `ErrorState` says the right sentence; these are the three responses a
 * presentational component cannot carry out, and the first one is the reason the
 * hook exists at all.
 *
 * The 401 case is checked end to end rather than by asserting that `signOut` was
 * called: requirement 1.8 is a statement about where the visitor ends up and what
 * they are told on the way, so the test composes the real `SessionProvider`, the
 * real `RequireSession` guard and the real `ApiErrorState` and then reads the
 * resulting location. Only the Cognito boundary is stubbed.
 */

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { ApiError } from "../api";
import { ApiErrorState } from "../components/ApiErrorState";
import { LOGIN_ROUTE, readIntendedRoute } from "./intendedRoute";
import { RequireSession } from "./routeGuards";
import { SessionProvider } from "./SessionProvider";
import { useApiFailure } from "./useApiFailure";

const cognito = vi.hoisted(() => ({
  token: "header.eyJzdWIiOiJVU1ItMSIsImVtYWlsIjoiYXNoYUBleGFtcGxlLm9yZyIsImNvZ25pdG86Z3JvdXBzIjpbIkxFQURFUiIsIk9SRy13ZW1ha2VkZXYiXX0.signature",
  signedIn: true,
  signOutCalls: 0,
  user: {
    userId: "USR-1",
    email: "asha@example.org",
    name: "Asha",
    role: "LEADER" as const,
    organizations: ["ORG-wemakedev"],
    isDemo: false,
  },
}));

vi.mock("../auth", () => ({
  isAuthConfigured: true,
  isSignedIn: () => Promise.resolve(cognito.signedIn),
  getSignedInUser: () => Promise.resolve(cognito.signedIn ? cognito.user : null),
  getIdToken: () => Promise.resolve(cognito.signedIn ? cognito.token : null),
  isDemoSession: () => false,
  getSignedInEmail: () => (cognito.signedIn ? cognito.user.email : null),
  getMemberOrganizations: () => Promise.resolve(cognito.signedIn ? cognito.user.organizations : []),
  signIn: () => Promise.resolve(),
  AuthError: class AuthError extends Error {},
  signOut: () => {
    cognito.signOutCalls += 1;
    cognito.signedIn = false;
  },
}));

beforeEach(() => {
  cognito.signedIn = true;
  cognito.signOutCalls = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The protected route: a page that reports one failure when asked to. */
function ProbePage({ error, refresh }: { error: unknown; refresh?: () => void }) {
  const report = useApiFailure();
  const [failure, setFailure] = useState<unknown>(null);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setFailure(report(error, { refresh }));
        }}
      >
        Load
      </button>
      <p data-testid="rendered">{failure === null ? "nothing to render" : "failure held"}</p>
      {failure === null ? null : <ApiErrorState error={failure} />}
    </div>
  );
}

/** Where the router ended up, so the redirect can be read rather than inferred. */
function LocationProbe() {
  const location = useLocation();

  return (
    <div>
      <p data-testid="path">{location.pathname}</p>
      <p data-testid="intended">{readIntendedRoute(location.state) ?? "none"}</p>
    </div>
  );
}

function renderConsole(error: unknown, refresh?: () => void) {
  return render(
    <MemoryRouter initialEntries={["/speakers?event_id=EVT-1"]}>
      <SessionProvider>
        <LocationProbe />
        <Routes>
          <Route
            path="/speakers"
            element={
              <RequireSession skeleton={<p>Restoring session…</p>}>
                <ProbePage error={error} refresh={refresh} />
              </RequireSession>
            }
          />
          <Route path={LOGIN_ROUTE} element={<p>Sign in to CommunityOps</p>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe("a 401 mid-session (requirement 1.8)", () => {
  it("returns the visitor to sign-in with the intended route retained, and says nothing", async () => {
    renderConsole(new ApiError("token expired", 401, "UNAUTHORIZED"));

    await userEvent.click(await screen.findByRole("button", { name: "Load" }));

    // The guard, not the hook, performs the navigation — one place decides where
    // a session-less visitor goes.
    expect(await screen.findByText("Sign in to CommunityOps")).toBeInTheDocument();
    expect(screen.getByTestId("path")).toHaveTextContent(LOGIN_ROUTE);

    // The route they were on, search included, so sign-in can return them to it
    // (requirement 1.5).
    expect(screen.getByTestId("intended")).toHaveTextContent("/speakers?event_id=EVT-1");

    // No error notification anywhere on the way (requirement 1.8).
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/session/i)).not.toBeInTheDocument();
    expect(cognito.signOutCalls).toBe(1);
  });

  it("gives the page nothing to render, whatever the page does with it", async () => {
    // The hook returns `null` for an ended session, so `setFailure(report(e))`
    // leaves the page with nothing — the guarantee holds even for a page that
    // would have rendered the failure.
    renderConsole(new ApiError("token expired", 401, "UNAUTHORIZED"));

    await userEvent.click(await screen.findByRole("button", { name: "Load" }));
    await screen.findByText("Sign in to CommunityOps");

    expect(screen.queryByText("failure held")).not.toBeInTheDocument();
  });
});

describe("the remaining session-level responses", () => {
  it("refreshes the affected list for a missing record (requirement 13.4)", async () => {
    const refresh = vi.fn();
    renderConsole(new ApiError("gone", 404, "NOT_FOUND"), refresh);

    await userEvent.click(await screen.findByRole("button", { name: "Load" }));

    // The list around the failure is re-fetched, and the copy is still shown.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText("We couldn't find that record. It may have been removed."),
    ).toBeInTheDocument();
    expect(cognito.signOutCalls).toBe(0);
  });

  it("does not refresh a list for a failure that is not stale data", async () => {
    const refresh = vi.fn();
    renderConsole(new ApiError("boom", 500, "INTERNAL_ERROR"), refresh);

    await userEvent.click(await screen.findByRole("button", { name: "Load" }));

    await screen.findByText("CommunityOps couldn't load this view.");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("writes configuration detail to the browser console only (requirement 13.7)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new ApiError(
      "No API URL is configured. Set VITE_API_URL to the deployed API.",
      0,
      "CONFIGURATION_ERROR",
    );

    const { container } = renderConsole(failure);

    await userEvent.click(await screen.findByRole("button", { name: "Load" }));

    expect(await screen.findByText("This console isn't configured yet.")).toBeInTheDocument();

    // The specific detail went to the console, and nowhere near the DOM.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[1]).toBe(failure);
    expect(container.innerHTML).not.toContain("VITE_API_URL");

    // Nothing a second attempt would change, so no retry is offered.
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
});
