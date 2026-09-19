import { useState } from "react";
import { AuthError, signIn } from "../auth";

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
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
      setLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-brand">
          CommunityOps
          <span>AI Operations Agent</span>
        </div>

        <p className="login-intro">Sign in to the Community Operations Command Center.</p>

        {error && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}

        <label className="login-label" htmlFor="login-email">
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
        />

        <label className="login-label" htmlFor="login-password">
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
        />

        <button
          className="btn btn-primary login-submit"
          type="submit"
          disabled={loading || !email.trim() || !password}
        >
          {loading ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </div>
  );
}
