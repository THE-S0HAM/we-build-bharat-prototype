/**
 * Behaviour checks on the sign-in screen (requirements 1.1, 1.2, 1.10, 1.11).
 *
 * Only the Cognito SDK boundary is replaced: a user pool cannot be reached from
 * jsdom, so `signIn` is a stub that records what it was given and resolves or
 * rejects. Everything else — the form, the live region, the allowlist — is real.
 *
 * The screen is rendered without a router on purpose. Sign-in must not navigate
 * (`RedirectWhenAuthenticated` owns that, per requirement 1.1), and a `navigate`
 * call added here in future would throw for want of a router rather than pass
 * quietly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Login } from "./Login";

const SIGN_IN_FAILED = "We couldn't sign you in. Check your email and password.";

/** Stand-in for the Cognito SRP call in `src/auth.ts`. */
const cognito = vi.hoisted(() => ({
  calls: [] as { username: string; password: string }[],
  /** What the next attempt does. Cognito's own wording, which must never show. */
  rejectWith: null as string | null,
}));

vi.mock("../auth", () => ({
  isAuthConfigured: true,
  signIn: (username: string, password: string) => {
    cognito.calls.push({ username, password });

    return cognito.rejectWith === null
      ? Promise.resolve()
      : Promise.reject(new Error(cognito.rejectWith));
  },
}));

beforeEach(() => {
  cognito.calls = [];
  cognito.rejectWith = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function emailField(): HTMLElement {
  return screen.getByLabelText("Email");
}

function passwordField(): HTMLElement {
  return screen.getByLabelText("Password");
}

function submitButton(): HTMLElement {
  return screen.getByRole("button", { name: "Sign in" });
}

describe("email and password sign-in", () => {
  it("authenticates through the SRP path and hands the session back to the caller", async () => {
    const onSignedIn = vi.fn();

    render(<Login onSignedIn={onSignedIn} />);

    await userEvent.type(emailField(), "  lead@wemakedev.org  ");
    await userEvent.type(passwordField(), "correct horse ");
    await userEvent.click(submitButton());

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledTimes(1);
    });

    // The address is trimmed because surrounding whitespace is never part of it.
    // The password is passed exactly as typed, trailing space included.
    expect(cognito.calls).toEqual([
      { username: "lead@wemakedev.org", password: "correct horse " },
    ]);
  });

  it("reports a rejection in reviewed copy, keeps the email and re-enables the form", async () => {
    cognito.rejectWith = "Incorrect username or password.";

    render(<Login onSignedIn={vi.fn()} />);

    await userEvent.type(emailField(), "lead@wemakedev.org");
    await userEvent.type(passwordField(), "wrong-password");
    await userEvent.click(submitButton());

    const error = await screen.findByText(SIGN_IN_FAILED);

    // Nothing Cognito said reaches the screen: no message, no code, no
    // exception name (requirement 16.7).
    expect(screen.queryByText(/Incorrect username or password/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Error/)).not.toBeInTheDocument();

    // The entered email survives and the form is usable again (requirement 1.2).
    expect(emailField()).toHaveValue("lead@wemakedev.org");
    expect(emailField()).toBeEnabled();
    expect(passwordField()).toBeEnabled();
    expect(submitButton()).toBeEnabled();

    // The failure is announced politely and is associated with both controls,
    // because the pool does not say which half was wrong (requirement 15.7).
    const feedback = error.closest("[aria-live]");
    expect(feedback).toHaveAttribute("aria-live", "polite");
    expect(emailField()).toHaveAttribute("aria-describedby", error.id);
    expect(passwordField()).toHaveAttribute("aria-describedby", error.id);
    expect(emailField()).toHaveAttribute("aria-invalid", "true");

    // A second attempt is possible without retyping the address.
    cognito.rejectWith = null;
    await userEvent.type(passwordField(), "right-password");
    await userEvent.click(submitButton());

    await waitFor(() => {
      expect(cognito.calls).toHaveLength(2);
    });
    expect(cognito.calls[1]).toEqual({
      username: "lead@wemakedev.org",
      password: "right-password",
    });
  });

  it("gives both fields a label and the autocomplete a password manager needs", () => {
    render(<Login onSignedIn={vi.fn()} />);

    expect(emailField()).toHaveAttribute("autocomplete", "email");
    expect(emailField()).toHaveAttribute("type", "email");
    expect(passwordField()).toHaveAttribute("autocomplete", "current-password");
    expect(passwordField()).toHaveAttribute("type", "password");
  });
});

describe("federated provider allowlist", () => {
  it("omits the provider block and its divider when no provider is configured", () => {
    render(<Login onSignedIn={vi.fn()} />);

    // The state of the product today (design.md A1): nothing provider-shaped
    // exists in the DOM, disabled or otherwise (requirement 1.11).
    expect(screen.queryByText("or")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue with/ })).not.toBeInTheDocument();

    // Email sign-in remains primary; the restricted demo-session action is secondary.
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(submitButton()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try Demo Account" })).toBeInTheDocument();
  });

  it("keeps provider controls absent even when stray hosted-UI variables are set", () => {
    vi.stubEnv("VITE_AUTH_PROVIDERS", "google, apple");
    vi.stubEnv("VITE_COGNITO_DOMAIN", "communityops.auth.ap-south-1.amazoncognito.com");
    vi.stubEnv("VITE_COGNITO_CLIENT_ID", "1example23client45id");

    render(<Login onSignedIn={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /Continue with/ })).not.toBeInTheDocument();
    expect(screen.queryByText("or")).not.toBeInTheDocument();
    expect(submitButton()).toBeInTheDocument();
  });

  it("omits the block when a provider is named but nothing can honour it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // A named provider with no hosted UI domain, which is what A1 describes.
    vi.stubEnv("VITE_AUTH_PROVIDERS", "google");
    vi.stubEnv("VITE_COGNITO_DOMAIN", "");

    render(<Login onSignedIn={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /Continue with/ })).not.toBeInTheDocument();
    expect(screen.queryByText("or")).not.toBeInTheDocument();

    warn.mockRestore();
  });
});

describe("screen structure", () => {
  it("names the product once, in a single top-level heading", () => {
    render(<Login onSignedIn={vi.fn()} />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("CommunityOps");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Welcome back");
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("offers nothing that is not backed by something real", () => {
    render(<Login onSignedIn={vi.fn()} />);

    // No password-reset path exists, so no affordance claims one.
    expect(screen.queryByText(/forgot/i)).not.toBeInTheDocument();
    // Demo access is backed by the anonymous restricted backend session endpoint.
    expect(screen.getByRole("button", { name: "Try Demo Account" })).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
