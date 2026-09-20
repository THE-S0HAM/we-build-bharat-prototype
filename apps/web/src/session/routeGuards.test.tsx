/**
 * Behaviour checks for the session gate (requirements 1.3, 1.4, 1.5, 1.6).
 *
 * The router, the provider and the guards are all real; only the Cognito SDK
 * boundary is replaced, because a user pool cannot be reached from jsdom. The
 * stub answers the one question `auth.ts` answers — is a valid token obtainable?
 * — and the protected and public routes are plain stubs so that what is under
 * test is the gate, not a page.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { readIntendedRoute } from "./intendedRoute";
import { RedirectWhenAuthenticated, RequireSession } from "./routeGuards";
import { SessionProvider } from "./SessionProvider";
import { useSession } from "./sessionContext";

/** Stand-in for the Cognito SDK's stored session. */
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
  signOut: () => {
    cognito.signOutCalls += 1;
    cognito.signedIn = false;
  },
  getSignedInEmail: () => (cognito.signedIn ? cognito.user.email : null),
  getMemberOrganizations: () => Promise.resolve(cognito.signedIn ? cognito.user.organizations : []),
  signIn: () => Promise.resolve(),
  AuthError: class AuthError extends Error {},
}));

function ProtectedStub() {
  const { signOut } = useSession();

  return (
    <>
      <p>Speaker operations</p>
      <button type="button" onClick={signOut}>
        Sign out
      </button>
    </>
  );
}

function LoginStub() {
  const { state } = useLocation();
  const { refresh } = useSession();

  return (
    <>
      <p>Sign-in screen</p>
      <p>{`Retained: ${readIntendedRoute(state) ?? "none"}`}</p>
      <button
        type="button"
        onClick={() => {
          cognito.signedIn = true;
          void refresh();
        }}
      >
        Finish sign-in
      </button>
    </>
  );
}

function renderConsole(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <SessionProvider>
        <Routes>
          <Route
            path="/login"
            element={
              <RedirectWhenAuthenticated pending={<p>Restoring session</p>}>
                <LoginStub />
              </RedirectWhenAuthenticated>
            }
          />
          <Route
            element={
              <RequireSession skeleton={<p>Shell skeleton</p>}>
                <Outlet />
              </RequireSession>
            }
          >
            <Route path="/" element={<p>Command center</p>} />
            <Route path="/speakers" element={<ProtectedStub />} />
          </Route>
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cognito.signedIn = true;
  cognito.signOutCalls = 0;
});

describe("RequireSession", () => {
  it("renders the shell skeleton while the session is unresolved, never the login screen", async () => {
    renderConsole("/speakers");

    // Synchronous: the session probe has not settled yet. This is the reload
    // flash the gate exists to prevent (requirement 1.4).
    expect(screen.getByText("Shell skeleton")).toBeInTheDocument();
    expect(screen.queryByText("Sign-in screen")).not.toBeInTheDocument();
    expect(screen.queryByText("Speaker operations")).not.toBeInTheDocument();

    expect(await screen.findByText("Speaker operations")).toBeInTheDocument();
  });

  it("restores a valid session and renders the requested protected route", async () => {
    renderConsole("/speakers");

    expect(await screen.findByText("Speaker operations")).toBeInTheDocument();
    expect(screen.queryByText("Shell skeleton")).not.toBeInTheDocument();
  });

  it("sends an unauthenticated visitor to the login screen, retaining the route", async () => {
    cognito.signedIn = false;

    renderConsole("/speakers?status=confirmed");

    expect(await screen.findByText("Sign-in screen")).toBeInTheDocument();
    expect(screen.getByText("Retained: /speakers?status=confirmed")).toBeInTheDocument();
    expect(screen.queryByText("Speaker operations")).not.toBeInTheDocument();
  });

  it("returns the visitor to the retained route once the session resolves", async () => {
    cognito.signedIn = false;

    renderConsole("/speakers?status=confirmed");
    await screen.findByText("Sign-in screen");

    await userEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));

    expect(await screen.findByText("Speaker operations")).toBeInTheDocument();
  });

  it("clears the session and lands on the login screen when sign-out is activated", async () => {
    renderConsole("/speakers");
    await screen.findByText("Speaker operations");

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    // The SDK's stored tokens are cleared, and the gate takes it from there:
    // a protected route with no session resolves to the login screen.
    expect(await screen.findByText("Sign-in screen")).toBeInTheDocument();
    expect(cognito.signOutCalls).toBe(1);
    expect(screen.queryByText("Speaker operations")).not.toBeInTheDocument();
    // Signing back in returns to the route they left, the same way any other
    // interrupted visit does.
    expect(screen.getByText("Retained: /speakers")).toBeInTheDocument();
  });
});

describe("RedirectWhenAuthenticated", () => {
  it("does not render the login screen while the session is unresolved", async () => {
    renderConsole("/login");

    expect(screen.getByText("Restoring session")).toBeInTheDocument();
    expect(screen.queryByText("Sign-in screen")).not.toBeInTheDocument();

    // A session exists, so the visitor is sent to the default route rather than
    // being shown a form they do not need.
    expect(await screen.findByText("Command center")).toBeInTheDocument();
    expect(screen.queryByText("Sign-in screen")).not.toBeInTheDocument();
  });

  it("renders the login screen for a visitor with no session", async () => {
    cognito.signedIn = false;

    renderConsole("/login");

    expect(await screen.findByText("Sign-in screen")).toBeInTheDocument();
  });
});
