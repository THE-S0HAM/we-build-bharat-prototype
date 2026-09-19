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
 * The action exists only when `VITE_DEMO_USERNAME` and `VITE_DEMO_PASSWORD` are
 * both configured (requirements 2.1, 2.2). `configuredDemoAccess` returns a
 * credential or `null`, so a rendered button has something real to authenticate
 * with by construction. With the A18 infrastructure still missing, `null` is
 * today's answer and this component renders nothing at all.
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

import { signIn } from "../auth";
import { configuredDemoAccess } from "../lib/demoAccess";
import "./Login.css";

/** Idle label. The one wording requirement 2.1 names. */
const ACTION_LABEL = "Try Demo Account";

/** In-flight copy, from the design.md §12 state table (requirement 2.4). */
const PREPARING = "Preparing your demo workspace…";

/** The only failure sentence this action has (requirement 2.6). */
const DEMO_UNAVAILABLE = "Demo access is temporarily unavailable.";

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
type DemoPhase = "idle" | "preparing" | "failed";

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

  /**
   * Resolved on every render rather than memoised: it is two environment reads
   * and a pair of comparisons, and reading it here keeps the answer honest about
   * the configuration this render is running under.
   */
  const credentials = configuredDemoAccess();

  // Requirement 2.2: nothing in the DOM, not a disabled button.
  if (credentials === null) {
    return null;
  }

  // Bound after the guard above, so the type says what the code already knows:
  // this action only exists when there is something real to authenticate with.
  const { username, password } = credentials;

  async function activate(): Promise<void> {
    if (phase === "preparing") {
      return;
    }

    setPhase("preparing");

    try {
      // The same call the form makes. The password is passed exactly as
      // configured and is never trimmed, logged or copied anywhere else.
      await signIn(username, password);
      onSignedIn();
      // `phase` is deliberately left at "preparing": the session has resolved and
      // this screen is about to be replaced by the Command Center, so returning
      // the button to its idle label would flash an action that is no longer
      // available (requirement 2.5).
    } catch {
      // The thrown value is deliberately not read. Whatever Cognito said stays
      // inside Cognito (requirements 2.6, 16.7).
      setPhase("failed");
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
          // Exactly the specified sentence, and nothing beside it
          // (requirement 2.6).
          <p className="login__demo-error">{DEMO_UNAVAILABLE}</p>
        ) : null}
      </div>

      <button
        type="button"
        className="btn login__demo-action"
        // Secondary to the form's primary action: the product has one primary
        // action per screen (requirement 12.11), and it is "Sign in".
        onClick={() => {
          void activate();
        }}
        disabled={preparing}
        aria-busy={preparing}
        aria-describedby={phase === "failed" ? FEEDBACK_ID : undefined}
      >
        {label}
      </button>

      {/* Dropped once there is a failure to read instead: two sentences under one
          button is noise, and requirement 2.6 keeps the failure state to its own
          copy. */}
      {phase === "idle" ? <p className="login__demo-note">{SUPPORTING_COPY}</p> : null}
    </div>
  );
}
