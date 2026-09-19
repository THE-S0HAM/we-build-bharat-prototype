/**
 * Public landing page.
 *
 * Reachable while signed out, which previously was not possible: the session gate returned `<Login/>`
 * before the router rendered, so every path led to the sign-in form.
 *
 * States the product promise in the leader's own terms rather than listing features. The loop is
 * shown because it is the actual product — an operations teammate that observes, decides what it may
 * act on, and stops where a human has to choose.
 */

import { Link } from "react-router-dom";

export function Landing({ onTryDemo, demoBusy }: { onTryDemo: () => void; demoBusy: boolean }) {
  return (
    <div className="landing">
      <nav className="landing-nav">
        <span className="cluster" style={{ gap: "var(--s2)", fontWeight: 600, fontSize: 15 }}>
          <span className="sidebar-mark" aria-hidden="true">
            C
          </span>
          CommunityOps
        </span>
        <div className="landing-nav-actions">
          <Link className="btn btn-sm" to="/login">
            Sign in
          </Link>
          <button
            className="btn btn-sm btn-primary"
            onClick={onTryDemo}
            type="button"
            disabled={demoBusy}
          >
            {demoBusy ? "Opening…" : "Try the demo"}
          </button>
        </div>
      </nav>

      <header className="landing-hero">
        <span className="landing-eyebrow">AI community operations</span>
        <h1>I don&rsquo;t need to chase everyone anymore.</h1>
        <p>
          CommunityOps watches the operation behind your event — speakers, teams, tasks, attendees,
          incidents and budget — handles the repetitive coordination itself, and brings you only the
          decisions that actually need a person.
        </p>
        <div className="landing-cta">
          <button
            className="btn btn-primary"
            onClick={onTryDemo}
            type="button"
            disabled={demoBusy}
          >
            {demoBusy ? "Opening the demo…" : "Try the demo"}
          </button>
          <Link className="btn" to="/login">
            Sign in
          </Link>
        </div>
        <p className="t-meta" style={{ marginTop: "var(--s4)" }}>
          The demo opens a real, restricted workspace with a fully seeded event. No signup.
        </p>
      </header>

      <section className="landing-loop">
        <h2 className="t-section" style={{ marginBottom: "var(--s3)" }}>
          How it works
        </h2>
        <div className="loop-grid">
          <article className="loop-step">
            <div className="loop-step-n">01</div>
            <h3>It watches</h3>
            <p>
              Overdue work, silent speakers, unresolved incidents, budget pressure and gaps in
              attendee data — read continuously from operational state.
            </p>
          </article>
          <article className="loop-step">
            <div className="loop-step-n">02</div>
            <h3>It handles what it may</h3>
            <p>
              Creating tasks, assigning unowned work, drafting follow-ups, recording analysis.
              Internal, reversible, and logged.
            </p>
          </article>
          <article className="loop-step">
            <div className="loop-step-n">03</div>
            <h3>It stops where you decide</h3>
            <p>
              Anything financial, irreversible or outbound is prepared with its evidence and cost,
              then waits for you. It never acts and tells you afterwards.
            </p>
          </article>
          <article className="loop-step">
            <div className="loop-step-n">04</div>
            <h3>It re-evaluates</h3>
            <p>
              Your decision changes the operational state, and event health is recomputed from that
              state — not from an opinion about it.
            </p>
          </article>
        </div>

        <div className="notice notice-ok" style={{ marginTop: "var(--s5)" }}>
          <div>
            <strong>Human authority is structural, not a setting.</strong> Financial commitments,
            speaker confirmations and outbound messages cannot be performed by the agent at all —
            they exist only as requests awaiting a community leader.
          </div>
        </div>
      </section>
    </div>
  );
}
