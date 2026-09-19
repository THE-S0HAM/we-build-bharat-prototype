import type { ReactNode } from "react";
import { isMockMode } from "../api";
import "./Topbar.css";

/**
 * Accessible name for the mock-data badge.
 *
 * The words matter: this badge says the *frontend build* is serving fabricated
 * records. It never claims anything about who is signed in. Keeping that
 * sentence in one constant stops the copy drifting toward the "Demo workspace"
 * chip's meaning (requirement 2.8, design.md A18).
 */
const MOCK_BADGE_LABEL =
  "Demo Mode — this console is showing simulated data, not live operational data";

export interface TopbarProps {
  /**
   * The event switcher (`EventSwitcher`, task 2.4). A slot rather than a direct
   * dependency, so event context can arrive without this component changing.
   *
   * Omit it and no context group renders, which is the Phase A state: there is
   * no event context to switch yet.
   */
  eventSwitcher?: ReactNode;

  /**
   * The "Demo workspace" chip (task 2.6), rendered only while a demo session is
   * active. It states that the signed-in identity belongs to the real demo
   * organization — a fact about the *session*, not about the data layer.
   *
   * This slot is named for its single permitted occupant on purpose: the top bar
   * is not a chip rail, and requirement 3.11 makes it the only surface allowed
   * to render this chip.
   */
  demoWorkspaceChip?: ReactNode;

  /**
   * Invoked when sign-out is activated.
   *
   * The handler must clear session state and navigate to `/login`
   * (requirement 1.6). Both belong to the session provider (task 2.1), not here:
   * one handler means one sign-out path, so a demo session signs out through
   * exactly the route every other session uses (requirement 2.9).
   */
  onSignOut: () => void;
}

/**
 * Topbar — the only surface in the product that renders global context
 * (requirement 3.11, design.md §7).
 *
 * Three things live here and nothing else: the event switcher, the demo-workspace
 * chip and sign-out. No navigation (the `Sidebar` owns that), no page actions
 * (`PageHeader` owns the one primary action), no notification centre.
 *
 * Renders the *contents* of `AppShell`'s `topbar` slot. The shell already
 * supplies the sticky `<header>` banner, the `--header-h` minimum height and the
 * inner wrapper that shares its left edge with the content column, so this
 * component deliberately renders no `<header>` of its own — a second one would
 * duplicate the banner landmark (requirement 15.1). It renders no wordmark
 * either: the product name is rendered once, in the navigation (requirement 3.1).
 *
 * Two demo signals exist and they are not the same claim (requirement 2.8,
 * design.md A18):
 *
 *   - **Demo Mode badge** — driven by `VITE_USE_MOCK` through `isMockMode`, the
 *     single mock-mode source in `api.ts` (requirement 13.9). It means the
 *     frontend is serving fabricated local records instead of calling the API,
 *     so it is a local-development warning: amber attention treatment, in the
 *     session group beside sign-out, describing the *data*.
 *   - **"Demo workspace" chip** — supplied by the caller while a demo session is
 *     active. It means you are signed into the real `ORG-demo` organization and
 *     looking at real API responses. It sits in the context group beside the
 *     event switcher, describing *which workspace you are acting for*, and it
 *     carries no warning colour because nothing is being faked.
 *
 * Conflating them would let "you are in the demo org" read as "none of this is
 * real", or worse, the reverse.
 *
 * There is no Slack indicator, and there must not be one: no Slack integration
 * exists anywhere in the repository, so a "Slack connected" chip would be a
 * false claim about system state (design.md A7).
 */
export function Topbar({ eventSwitcher, demoWorkspaceChip, onSignOut }: TopbarProps) {
  // Phase A has neither slot filled, and an empty group would still consume the
  // row's gap. Render the group only when it has something to hold.
  const hasContext = Boolean(eventSwitcher) || Boolean(demoWorkspaceChip);

  return (
    <div className="topbar">
      {hasContext ? (
        <div className="topbar__context">
          {eventSwitcher}
          {demoWorkspaceChip}
        </div>
      ) : null}

      <div className="topbar__session">
        {isMockMode ? (
          // `role="status"` matches the pattern the console already uses for
          // this badge, and `aria-live="polite"` is stated alongside it rather
          // than left to the role's implicit value: requirement 15.8 names a
          // mock-mode change as one of the three things that must be announced
          // through a polite region, and this badge is that region. The glyph is
          // decorative, so it is hidden from assistive technology and the full
          // sentence is carried by the label.
          <p
            className="topbar__mock-badge"
            role="status"
            aria-live="polite"
            aria-label={MOCK_BADGE_LABEL}
          >
            <span className="topbar__mock-badge-glyph" aria-hidden="true">
              ⚡
            </span>
            <span className="topbar__mock-badge-name">Demo Mode</span>
            {/* Spelled out for sighted users too, so the badge cannot be read as
                the "Demo workspace" chip. Hidden below --bp-sm, where the label
                still carries it. */}
            <span className="topbar__mock-badge-detail">· simulated data</span>
          </p>
        ) : null}

        <button type="button" className="btn btn-sm topbar__signout" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
