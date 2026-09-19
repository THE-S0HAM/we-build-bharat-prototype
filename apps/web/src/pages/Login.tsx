/**
 * The sign-in screen (requirements 1.1, 1.2, 1.10, 1.11).
 *
 * ## Sign-in does not navigate
 *
 * A successful `signIn` calls `onSignedIn`, which re-reads the session. The
 * route change is then made by `RedirectWhenAuthenticated`, which knows the
 * route the visitor originally asked for (requirements 1.1, 1.5). This component
 * has no `navigate` call on purpose: two things competing to decide where a
 * fresh session lands is a race, and one of them would always be the loser that
 * looks like it works.
 *
 * ## The failure path says one thing
 *
 * Cognito's own message never reaches the screen. `PreventUserExistenceErrors`
 * is enabled on the pool, so the pool itself refuses to say whether the address
 * exists — repeating its wording would leak nothing useful and risk leaking
 * something else (requirement 16.7). Every rejection reads as the one reviewed
 * sentence in `SIGN_IN_FAILED`, the entered email is kept so the visitor is not
 * made to retype it, and the form is handed straight back (requirement 1.2).
 *
 * ## Providers are configuration, not decoration
 *
 * The provider block is rendered from `configuredAuthProviders()` and nothing
 * else. With no allowlist — the state today, because there is no hosted UI
 * domain, no OAuth flows and no identity provider resources (design.md A1) —
 * both the block and its divider are absent from the DOM, and email/password is
 * the whole form (requirement 1.11). See `src/lib/authProviders.ts` for why a
 * resolved provider always has a real destination.
 *
 * ## Deliberately absent
 *
 * - **Forgot password.** No password-reset path exists in `auth.ts` or in the
 *   pool's configuration, and a link that goes nowhere is worse than no link.
 * - **A demo action, unless it is configured.** `DemoAccountAction` renders
 *   nothing without `VITE_DEMO_USERNAME` and `VITE_DEMO_PASSWORD`, which is the
 *   state today (design.md A18) — so this screen is the form and nothing else.
 * - **A `<nav>` landmark and a skip link.** Requirement 15.1 names both, and
 *   this is the one screen in the product that has neither, because it has
 *   nothing to navigate to and nothing to skip: an unauthenticated visitor has
 *   exactly one destination, and it is this form. An empty landmark would
 *   advertise navigation that does not exist, and a skip link whose target is the
 *   whole page is a keyboard stop that moves focus nowhere. Everything else
 *   requirement 15.1 asks for is here — one `<main>`, one `<h1>`, and a single
 *   descending heading order into the panel's `<h2>`.
 *
 * No credential is logged, stored or put in a URL by this file. The password
 * lives in component state for the moment it takes to submit it, and tokens stay
 * where the Cognito SDK puts them (requirement 16.9).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import { signIn } from "../auth";
import { configuredAuthProviders } from "../lib/authProviders";
import { DemoAccountAction } from "./DemoAccountAction";
import "./Login.css";

/** The only failure sentence this screen has (requirement 1.2, design.md §12). */
const SIGN_IN_FAILED = "We couldn't sign you in. Check your email and password.";

/** In-flight copy, from the design.md §12 state table. */
const SIGNING_IN = "Signing you in…";

const EMAIL_FIELD_ID = "login-email";
const PASSWORD_FIELD_ID = "login-password";
const ERROR_ID = "login-error";

/**
 * A rejected attempt. An object rather than a string so that a second identical
 * rejection is still a new value: that is what re-runs the effect below and
 * returns focus to the field the visitor has to correct.
 */
interface SignInFailure {
  readonly message: string;
}

export interface LoginProps {
  /**
   * Called once Cognito has accepted the credentials. The caller re-reads the
   * session; it must not navigate (see the note above).
   */
  onSignedIn: () => void;
}

export function Login({ onSignedIn }: LoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [failure, setFailure] = useState<SignInFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const passwordField = useRef<HTMLInputElement>(null);

  /**
   * Resolved once per mount. Configuration cannot change while the screen is
   * open, and resolving it here rather than at module load keeps the answer
   * honest about the configuration this render is actually running under.
   */
  const providers = useMemo(() => configuredAuthProviders(), []);

  /**
   * After a rejection, focus lands on the password field — the one thing the
   * visitor has to supply again. It happens in an effect rather than in the
   * catch block because the fieldset is still disabled at that point, and a
   * disabled field cannot take focus.
   */
  useEffect(() => {
    if (failure !== null) {
      passwordField.current?.focus();
    }
  }, [failure]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const submittedEmail = email.trim();

    // Both fields are `required`, so the browser blocks an empty submission and
    // says so itself. This guard is what holds when that native validation is
    // not in play, and it never reports anything the form has not already said.
    if (submitting || submittedEmail === "" || password === "") {
      return;
    }

    setFailure(null);
    setSubmitting(true);

    try {
      // The password is passed exactly as typed — trailing whitespace can be
      // part of it — and is never trimmed, logged or copied anywhere else.
      await signIn(submittedEmail, password);
      onSignedIn();
    } catch {
      // The thrown value is deliberately not read. Whatever Cognito said stays
      // inside Cognito: no message, no error code, no exception name
      // (requirement 16.7).
      setFailure({ message: SIGN_IN_FAILED });
      // The email survives (requirement 1.2). The password does not: it is
      // masked, so a wrong value left in place is easy to resubmit unchanged.
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  const errorDescription = failure === null ? undefined : ERROR_ID;

  return (
    <main className="login">
      <div className="login__masthead">
        <h1 className="login__wordmark">
          {/* Part of the wordmark, not a contextual visual: it carries no data,
              so it states nothing that would need a text alternative. */}
          <svg
            className="login__mark"
            viewBox="0 0 32 32"
            aria-hidden="true"
            focusable="false"
          >
            <circle className="login__mark-orbit" cx="16" cy="16" r="13" />
            <circle className="login__mark-core" cx="16" cy="16" r="4" />
            <circle className="login__mark-node" cx="16" cy="3" r="2.5" />
            <circle className="login__mark-node" cx="27.3" cy="22.5" r="2.5" />
            <circle className="login__mark-node" cx="4.7" cy="22.5" r="2.5" />
          </svg>
          CommunityOps
        </h1>

        <p className="login__promise">
          Your community is moving. Let the operations move with it.
        </p>
      </div>

      <section className="login__panel" aria-labelledby="login-heading">
        <div className="login__panel-head">
          <h2 className="login__title" id="login-heading">
            Welcome back
          </h2>
          <p className="login__subtitle">Continue to CommunityOps.</p>
        </div>

        {/* Rendered only from the allowlist (requirement 1.10). Today the list
            is empty, so neither this block nor the divider exists in the DOM and
            the form below stands on its own (requirement 1.11). */}
        {providers.length > 0 ? (
          <>
            <div className="login__providers">
              {providers.map((provider) => (
                <button
                  key={provider.key}
                  type="button"
                  className="btn login__provider"
                  onClick={() => {
                    // Leaves the console for the hosted UI, which returns the
                    // visitor to the registered callback with an authorization
                    // code. The URL is built by `authProviders`; a provider that
                    // resolved has one by construction.
                    window.location.assign(provider.authorizeUrl);
                  }}
                >
                  {provider.label}
                </button>
              ))}
            </div>

            <div className="login__divider" aria-hidden="true">
              <span>or</span>
            </div>
          </>
        ) : null}

        <form className="login__form" onSubmit={handleSubmit} aria-busy={submitting}>
          {/* Mounted whether or not there is anything to say, so that a
              rejection arriving later is announced rather than missed
              (requirement 15.8). Polite: the visitor is still reading their own
              typing when it lands. */}
          <div className="login__feedback" aria-live="polite">
            {failure === null ? null : (
              <p className="login__error" id={ERROR_ID}>
                <svg
                  className="login__error-mark"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M8 1.5 15 14.5H1z" />
                  <rect x="7.1" y="6" width="1.8" height="4.4" rx="0.9" />
                  <circle cx="8" cy="12.2" r="1" />
                </svg>
                {failure.message}
              </p>
            )}
          </div>

          {/* One `disabled` for the whole form, which is also what re-enables it
              in one move when an attempt is rejected (requirement 1.2). */}
          <fieldset className="login__fields" disabled={submitting}>
            <div className="login__field">
              <label className="login__label" htmlFor={EMAIL_FIELD_ID}>
                Email
              </label>
              <input
                id={EMAIL_FIELD_ID}
                className="input"
                type="email"
                name="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                /* The pool rejects the pair without saying which half was
                   wrong, so both fields carry the invalid state and point at
                   the same message (requirement 15.7). */
                aria-invalid={failure !== null}
                aria-describedby={errorDescription}
              />
            </div>

            <div className="login__field">
              <label className="login__label" htmlFor={PASSWORD_FIELD_ID}>
                Password
              </label>
              <input
                id={PASSWORD_FIELD_ID}
                ref={passwordField}
                className="input"
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={failure !== null}
                aria-describedby={errorDescription}
              />
            </div>

            <button type="submit" className="btn btn-primary login__submit">
              {submitting ? SIGNING_IN : "Sign in"}
            </button>
          </fieldset>
        </form>

        {/* "Try Demo Account": inside the panel, directly below the form, so it
            sits in the initial viewport without scrolling (requirement 2.1) and
            is absent from the DOM when the demo configuration is missing
            (requirement 2.2). It authenticates through the same `signIn` this
            form uses and ends the same way — `onSignedIn`, no navigation
            (requirements 2.3, 2.5). */}
        <DemoAccountAction onSignedIn={onSignedIn} />
      </section>
    </main>
  );
}
