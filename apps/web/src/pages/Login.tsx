/**
 * Sign in.
 *
 * Email and password through the existing Cognito SRP flow, which means the password never leaves the
 * browser in clear text.
 *
 * No social sign-in buttons. `SupportedIdentityProviders` on the user-pool client is `[COGNITO]`, and
 * there is no user-pool domain, no callback URLs and no identity-provider resource — so a
 * "Continue with Google" button could not work. Rendering one and having it fail would be worse than
 * not offering it, so the page says plainly which method is configured.
 *
 * The demo action is hidden when the backend reports demo access is unconfigured, rather than shown
 * and allowed to fail.
 */

import { useState } from "react";
import { Link } from "react-router-dom";

import { AuthError, isAuthConfigured, signIn } from "../auth";
import { Notice } from "../components/primitives";

export function Login({
  onSignedIn,
  onTryDemo,
  demoBusy,
  demoUnavailableReason,
}: {
  onSignedIn: () => void;
  onTryDemo: () => void;
  demoBusy: boolean;
  demoUnavailableReason?: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      onSignedIn();
    } catch (err) {
      setError(
        err instanceof AuthError || err instanceof Error
          ? err.message
          : "Sign-in failed. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <Link to="/" className="auth-brand" style={{ color: "var(--text)" }}>
          <span className="sidebar-mark" aria-hidden="true">
            C
          </span>
          CommunityOps
        </Link>

        <div className="auth-panel">
          <div className="auth-lede">
            <h1>Your community is moving.</h1>
            <p>Let the operations move with it.</p>
          </div>

          {!isAuthConfigured && (
            <div style={{ marginBottom: "var(--s4)" }}>
              <Notice tone="warn">
                Sign-in is not configured in this build. Set{" "}
                <code>VITE_COGNITO_USER_POOL_ID</code> and <code>VITE_COGNITO_CLIENT_ID</code>.
              </Notice>
            </div>
          )}

          {error && (
            <div style={{ marginBottom: "var(--s4)" }}>
              <Notice tone="error">{error}</Notice>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="field">
              <label className="field-label" htmlFor="login-email">
                Email
              </label>
              <input
                id="login-email"
                className="input"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy || !isAuthConfigured}
              />
            </div>

            <div className="field">
              <label className="field-label" htmlFor="login-password">
                Password
              </label>
              <input
                id="login-password"
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy || !isAuthConfigured}
              />
            </div>

            <button
              className="btn btn-primary btn-block"
              type="submit"
              disabled={busy || !isAuthConfigured || !email.trim() || !password}
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>

          {/* Only rendered when the backend has demo credentials. */}
          {!demoUnavailableReason && (
            <>
              <div className="auth-divider">or</div>
              <button
                className="btn btn-block"
                onClick={onTryDemo}
                type="button"
                disabled={demoBusy}
              >
                {demoBusy ? "Opening the demo…" : "Try the demo workspace"}
              </button>
              <p className="auth-foot">
                Opens a real, restricted workspace with a seeded event. No signup.
              </p>
            </>
          )}

          {demoUnavailableReason && (
            <div style={{ marginTop: "var(--s4)" }}>
              <Notice tone="info">{demoUnavailableReason}</Notice>
            </div>
          )}
        </div>

        <p className="auth-foot">
          Email sign-in is the configured method for this deployment. Google, Amazon and Apple
          sign-in are not enabled on this user pool.
        </p>
      </div>
    </div>
  );
}
