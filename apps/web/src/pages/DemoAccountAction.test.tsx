/**
 * "Try Demo Account" (requirements 2.1–2.6).
 *
 * The four statements worth holding:
 *
 *   - absent from the DOM without both configuration values, and absent *as
 *     markup* rather than disabled or hidden (2.1, 2.2);
 *   - the same Cognito SRP call the form makes, with the configured credentials
 *     and nothing else (2.3);
 *   - "Preparing your demo workspace…" while it is in flight (2.4);
 *   - on failure, "Demo access is temporarily unavailable." and a working retry,
 *     with nothing of the rejection on screen (2.6, 16.7).
 *
 * Only the Cognito boundary is replaced: a user pool cannot be reached from
 * jsdom. The action is rendered without a router on purpose — success must call
 * `onSignedIn` and leave the routing to `RedirectWhenAuthenticated`, so a
 * `navigate` added here in future would throw for want of a router rather than
 * pass quietly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DemoAccountAction } from "./DemoAccountAction";

const DEMO_USERNAME = "demo@communityops.dev";
const DEMO_PASSWORD = "not-a-real-one";

const ACTION_LABEL = "Try Demo Account";
const PREPARING = "Preparing your demo workspace…";
const DEMO_UNAVAILABLE = "Demo access is temporarily unavailable.";

/** Stand-in for the Cognito SRP call in `src/auth.ts`. */
const cognito = vi.hoisted(() => ({
  calls: [] as { username: string; password: string }[],
  /** Cognito's own wording, which must never reach the screen. */
  rejectWith: null as string | null,
  /** Held open so the in-flight state can be observed. */
  hold: null as null | (() => void),
}));

vi.mock("../auth", () => ({
  isAuthConfigured: true,
  signIn: (username: string, password: string) => {
    cognito.calls.push({ username, password });

    if (cognito.rejectWith !== null) {
      return Promise.reject(new Error(cognito.rejectWith));
    }

    return new Promise<void>((resolve) => {
      if (cognito.hold === null) {
        resolve();
      } else {
        cognito.hold = () => resolve();
      }
    });
  },
}));

function configureDemo(): void {
  vi.stubEnv("VITE_DEMO_USERNAME", DEMO_USERNAME);
  vi.stubEnv("VITE_DEMO_PASSWORD", DEMO_PASSWORD);
}

beforeEach(() => {
  cognito.calls = [];
  cognito.rejectWith = null;
  cognito.hold = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("configuration gating", () => {
  it("renders nothing at all when no demo configuration exists", () => {
    const { container } = render(<DemoAccountAction onSignedIn={vi.fn()} />);

    // Requirement 2.2: absent from the DOM. Not a disabled button, not a hidden
    // one — there is no element to find by any means.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument();
  });

  it("renders nothing when only one half of the credential is configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("VITE_DEMO_USERNAME", DEMO_USERNAME);

    const { container } = render(<DemoAccountAction onSignedIn={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();

    warn.mockRestore();
  });

  it("renders a real button once both values are configured", () => {
    configureDemo();

    render(<DemoAccountAction onSignedIn={vi.fn()} />);

    const action = screen.getByRole("button", { name: ACTION_LABEL });
    expect(action).toBeEnabled();
    expect(action).toHaveAttribute("type", "button");
  });
});

describe("activation", () => {
  it("authenticates the configured identity through the same SRP call the form uses", async () => {
    configureDemo();
    const onSignedIn = vi.fn();

    render(<DemoAccountAction onSignedIn={onSignedIn} />);
    await userEvent.click(screen.getByRole("button", { name: ACTION_LABEL }));

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledTimes(1);
    });

    expect(cognito.calls).toEqual([{ username: DEMO_USERNAME, password: DEMO_PASSWORD }]);
  });

  it("reports the preparing state while authentication is in flight", async () => {
    configureDemo();
    // Any non-null value makes the mock hold the promise until it is released.
    cognito.hold = () => undefined;

    render(<DemoAccountAction onSignedIn={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: ACTION_LABEL }));

    const action = await screen.findByRole("button", { name: PREPARING });
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute("aria-busy", "true");

    cognito.hold?.();
  });

  it("says one thing on failure and offers a retry that works", async () => {
    configureDemo();
    cognito.rejectWith = "User does not exist.";

    render(<DemoAccountAction onSignedIn={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: ACTION_LABEL }));

    const failure = await screen.findByText(DEMO_UNAVAILABLE);

    // Nothing of the rejection reaches the screen: no message, no code, no
    // exception name (requirements 2.6, 16.7).
    expect(screen.queryByText(/User does not exist/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Error/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cognito/i)).not.toBeInTheDocument();

    // Announced politely: the visitor is waiting on a workspace, not on an
    // emergency (requirement 15.8).
    expect(failure.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");

    // The retry is the same action run again, and it succeeds this time.
    cognito.rejectWith = null;
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry).toBeEnabled();

    await userEvent.click(retry);

    await waitFor(() => {
      expect(cognito.calls).toHaveLength(2);
    });
    expect(cognito.calls[1]).toEqual({ username: DEMO_USERNAME, password: DEMO_PASSWORD });
  });

  it("never renders the configured credentials", async () => {
    configureDemo();
    cognito.rejectWith = "Incorrect username or password.";

    const { container } = render(<DemoAccountAction onSignedIn={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: ACTION_LABEL }));
    await screen.findByText(DEMO_UNAVAILABLE);

    // The credential is in the bundle by design (design.md A18); it is still
    // never drawn, and the password never leaves the SRP call.
    expect(container.innerHTML).not.toContain(DEMO_PASSWORD);
    expect(container.innerHTML).not.toContain(DEMO_USERNAME);
  });
});
