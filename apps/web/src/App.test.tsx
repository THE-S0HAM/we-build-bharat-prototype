/**
 * Tests for routing and the session gate.
 *
 * The bug these exist to prevent has already happened once: the session gate returned `<Login/>`
 * *before* `<Routes>`, so every public path was unreachable and the product had no landing page at
 * all. The structural fix was to render the router unconditionally and guard only `/app`, and these
 * tests pin that shape down.
 *
 * The guard is convenience, not control. Authorization belongs to the API, which resolves team scope
 * from DynamoDB and refuses out-of-scope requests whatever this component believed. So the assertions
 * here are about what a visitor can reach, not about what they are permitted to do.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_ACTIVITY, APPROVAL_DETAIL, COMMAND_CENTER, EVENT_ID } from "./test/fixtures";

const getSignedInUser = vi.fn();
const signOut = vi.fn();
const startDemoSession = vi.fn();
const getCommandCenter = vi.fn();
const getEvents = vi.fn();

vi.mock("./auth", () => ({
  getSignedInUser: (...args: unknown[]) => getSignedInUser(...args),
  signOut: (...args: unknown[]) => signOut(...args),
  isAuthConfigured: true,
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    isMockMode: false,
    startDemoSession: (...args: unknown[]) => startDemoSession(...args),
    getCommandCenter: (...args: unknown[]) => getCommandCenter(...args),
    getEvents: (...args: unknown[]) => getEvents(...args),
    getAgentActivity: vi.fn(async () => AGENT_ACTIVITY),
    getApproval: vi.fn(async () => APPROVAL_DETAIL),
  };
});

const { App } = await import("./App");

const LEADER = {
  email: "priya@wemakedev.org",
  name: "Priya Sharma",
  role: "LEADER" as const,
  organizations: ["ORG-wemakedev"],
  isDemo: false,
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getSignedInUser.mockResolvedValue(null);
  getCommandCenter.mockResolvedValue(COMMAND_CENTER);
  getEvents.mockResolvedValue({
    events: [{ event_id: EVENT_ID, name: "AWS Community Day — Maharashtra 2026" }],
    count: 1,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("public routes", () => {
  it("serves the landing page at the root when nobody is signed in", async () => {
    renderAt("/");
    expect(
      await screen.findByText(/I don’t need to chase everyone anymore/i),
    ).toBeInTheDocument();
  });

  it("serves the sign-in page at /login", async () => {
    renderAt("/login");
    expect(await screen.findByLabelText(/Email/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Sign in$/ })).toBeInTheDocument();
  });

  it("offers no social sign-in, because none is configured", async () => {
    // The user-pool client lists COGNITO only. A "Continue with Google" button could not work, and
    // one that fails is worse than one that is absent.
    renderAt("/login");
    await screen.findByLabelText(/Email/i);

    expect(
      screen.queryByRole("button", { name: /Continue with (Google|Apple|Amazon)/i }),
    ).not.toBeInTheDocument();
    // It is stated rather than silently omitted, so nobody hunts for a button that is not there.
    expect(
      screen.getByText(/Google, Amazon and Apple sign-in are not enabled on this user pool/i),
    ).toBeInTheDocument();
  });
});

describe("the guard on /app", () => {
  it("sends an unauthenticated visitor to sign in", async () => {
    renderAt("/app");
    expect(await screen.findByRole("button", { name: /^Sign in$/ })).toBeInTheDocument();
    // No operational data is requested for somebody who is not signed in.
    expect(getCommandCenter).not.toHaveBeenCalled();
  });

  it("guards the deeper operational routes too", async () => {
    renderAt("/app/budget");
    expect(await screen.findByRole("button", { name: /^Sign in$/ })).toBeInTheDocument();
  });

  it("admits a signed-in leader to the command centre", async () => {
    getSignedInUser.mockResolvedValue(LEADER);
    renderAt("/app");
    expect(await screen.findByText(/decision needs you/i)).toBeInTheDocument();
  });

  it("sends a signed-in visitor away from the landing page", async () => {
    getSignedInUser.mockResolvedValue(LEADER);
    renderAt("/");
    expect(await screen.findByText(/decision needs you/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/I don’t need to chase everyone anymore/i),
    ).not.toBeInTheDocument();
  });

  it("sends an unknown path somewhere real", async () => {
    renderAt("/nowhere");
    expect(
      await screen.findByText(/I don’t need to chase everyone anymore/i),
    ).toBeInTheDocument();
  });
});

describe("demo access", () => {
  it("opens a session through the backend, with no credential in the browser", async () => {
    startDemoSession.mockImplementation(async () => {
      getSignedInUser.mockResolvedValue({
        email: "demo@communityops.local",
        name: "Demo Volunteer",
        role: "TEAM_MEMBER" as const,
        organizations: ["ORG-wemakedev"],
        isDemo: true,
      });
      return {};
    });

    renderAt("/");
    // The landing page offers the demo twice, in the nav and in the hero. Either will do.
    const buttons = await screen.findAllByRole("button", { name: /^Try the demo$/i });
    await userEvent.click(buttons[0]!);

    await waitFor(() => expect(startDemoSession).toHaveBeenCalled());
    // Called with nothing: the backend holds the password and picks the identity.
    expect(startDemoSession).toHaveBeenCalledWith();
  });

  it("hides the option when the deployment has no demo configured", async () => {
    const { ApiError } = await import("./api");
    startDemoSession.mockRejectedValue(new ApiError("Not found", 404));

    renderAt("/login");
    await userEvent.click(await screen.findByRole("button", { name: /Try the demo workspace/i }));

    expect(
      await screen.findByText(/Demo access is not configured on this deployment/i),
    ).toBeInTheDocument();
  });
});

describe("session loss during use", () => {
  it("returns the user to sign-in rather than showing an error", async () => {
    getSignedInUser.mockResolvedValue(LEADER);
    const { ApiError } = await import("./api");
    getCommandCenter.mockRejectedValue(new ApiError("Session expired", 401, "UNAUTHORIZED"));

    renderAt("/app");

    expect(await screen.findByRole("button", { name: /^Sign in$/ })).toBeInTheDocument();
  });

  it("shows a refusal as an error, because signing in again would not help", async () => {
    getSignedInUser.mockResolvedValue(LEADER);
    const { ApiError } = await import("./api");
    getCommandCenter.mockRejectedValue(
      new ApiError("You are not authorized to access this organization's data.", 403, "FORBIDDEN"),
    );

    renderAt("/app");

    expect(await screen.findByRole("alert")).toHaveTextContent(/not authorized/i);
  });
});
