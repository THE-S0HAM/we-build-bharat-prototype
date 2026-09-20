/**
 * "Try Demo Account" — one press into a populated workspace (requirement 2,
 * design.md §5.3, A18).
 *
 * ## The same sign-in, different credentials
 *
 * This runs the *same* `signIn` from `src/auth.ts` the form above it runs: one
 * Cognito SRP call, one token, one session (requirement 2.3). The demo path
 * differs from normal sign-in in exactly one way — who supplies the credentials
 * — and everything downstream is identical, which is why a demo session gets the
 * same shell, the same navigation and the same pages (requirement 2.11) and can
 * never read another organization's data (requirement 2.7).
 *
 * There is no imperative navigation here, for the same reason there is none in
 * the form: success calls `onSignedIn`, the session is re-read, and
 * `RedirectWhenAuthenticated` decides where a fresh session lands
 * (requirements 1.1, 2.5). Two things racing to make that decision is a race one
 * of them always loses.
 *
 * ## Absent, not disabled
 *
 * The action calls the backend's anonymous `POST /demo/session`. The request
 * carries no identity or credential; the backend authenticates one fixed,
 * restricted demo account and returns its ID token.
 *
 * ## The failure says one thing
 *
 * "Demo access is temporarily unavailable." and a working retry, and nothing
 * else (requirement 2.6). The rejection is never read: no Cognito message, no
 * status, no exception name, no request detail (requirement 16.7). The retry is
 * the button itself relabelled, so there is one control and it always does the
 * one thing — run the demo sign-in again.
 *
 * No credential reaches the DOM, a URL, storage or a log line from this file.
 */

import { useState } from "react";

import { startDemoSession } from "../api";
import "./Login.css";

/** Idle label. The one wording requirement 2.1 names. */
const ACTION_LABEL = "Try Demo Account";

/** In-flight copy, from the design.md §12 state table (requirement 2.4). */
const PREPARING = "Preparing your demo workspace…";

/** The only failure sentence this action has (requirement 2.6). */
const DEMO_UNAVAILABLE = "Demo access is temporarily unavailable.";
const DEMO_NOT_CONFIGURED = "Demo access is not available for this deployment.";

function isPermanentlyUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; category?: unknown };
  return (
    candidate.status === 404 ||
    candidate.category === "NOT_FOUND" ||
    candidate.category === "CONFIGURATION_ERROR"
  );
}

/** The retry, which is this same action run again (requirement 2.6). */
const RETRY_LABEL = "Try again";

/**
 * What the action offers, in one sentence. Honest about both halves: a visitor
 * supplies nothing, and what they see afterwards is a real workspace rather than
 * a simulation — which is the same distinction the "Demo workspace" chip carries
 * in the top bar (requirement 2.8).
 */
const SUPPORTING_COPY = "See a populated CommunityOps workspace. No credentials needed.";

const FEEDBACK_ID = "login-demo-feedback";

/** Three states, and only one of them is a control the user can press twice. */
type DemoPhase = "idle" | "preparing" | "failed" | "unavailable";

export interface DemoAccountActionProps {
  /**
   * Called once Cognito has accepted the demo credentials. The caller re-reads
   * the session; it must not navigate (see the note above). This is the same
   * callback the sign-in form uses, so both paths end the same way.
   */
  onSignedIn: () => void;
}

export function DemoAccountAction({ onSignedIn }: DemoAccountActionProps) {
  const [phase, setPhase] = useState<DemoPhase>("idle");

  async function activate(): Promise<void> {
    if (phase === "preparing") {
      return;
    }

    setPhase("preparing");

    try {
      await startDemoSession();
      onSignedIn();
    } catch (error: unknown) {
      if (isPermanentlyUnavailable(error)) {
        setPhase("unavailable");
      } else {
        setPhase("failed");
      }
    }
  }

  const preparing = phase === "preparing";
  const label = preparing ? PREPARING : phase === "failed" ? RETRY_LABEL : ACTION_LABEL;

  return (
    <div className="login__demo">
      {/* Mounted whether or not there is anything to say, so a failure arriving
          later is announced rather than missed (requirement 15.8). Polite: the
          visitor is waiting on a workspace, not on an emergency. */}
      <div className="login__demo-feedback" aria-live="polite" id={FEEDBACK_ID}>
        {phase === "failed" ? (
          <p className="login__demo-error">{DEMO_UNAVAILABLE}</p>
        ) : phase === "unavailable" ? (
          <p className="login__demo-error">{DEMO_NOT_CONFIGURED}</p>
        ) : null}
      </div>

      {phase !== "unavailable" ? (
        <button
          type="button"
          className="btn login__demo-action"
          onClick={() => {
            void activate();
          }}
          disabled={preparing}
          aria-busy={preparing}
          aria-describedby={phase === "failed" ? FEEDBACK_ID : undefined}
        >
          {label}
        </button>
      ) : null}

      {/* Dropped once there is a failure to read instead: two sentences under one
          button is noise, and requirement 2.6 keeps the failure state to its own
          copy. */}
      {phase === "idle" ? <p className="login__demo-note">{SUPPORTING_COPY}</p> : null}
    </div>
  );
}
