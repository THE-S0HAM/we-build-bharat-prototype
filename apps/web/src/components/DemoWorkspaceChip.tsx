/**
 * The "Demo workspace" chip (requirement 2.8, design.md A18 §6).
 *
 * ## Two demo signals, two different claims
 *
 * The top bar can carry two things with "demo" in the name, and conflating them
 * would be the most misleading thing in the product:
 *
 *   - **Demo Mode badge** (`Topbar`, driven by `VITE_USE_MOCK`) — the frontend is
 *     serving *fabricated* local records instead of calling the API. It is a
 *     local-development warning about the data, so it takes the amber attention
 *     treatment and sits in the session group.
 *   - **This chip** — you are signed into the real demo organization and every
 *     record on screen is a real API response. It is a statement about *which
 *     workspace you are acting for*, so it is neutral, sits in the context group
 *     beside the event switcher, and carries no warning colour, because nothing
 *     is being faked.
 *
 * Let the first read as "you are in the demo org" and a developer trusts
 * fabricated numbers. Let the second read as "none of this is real" and an
 * operator distrusts their own data.
 *
 * ## How a demo session is recognised
 *
 * The demo-session marker is held by `auth.ts` with the restricted token in
 * session storage and expires with that token.
 */

import { useSession } from "../session/sessionContext";
import "./DemoWorkspaceChip.css";

const CHIP_LABEL = "Demo workspace";

/**
 * What the chip means, spelled out for assistive technology. It states the one
 * thing that separates this chip from the Demo Mode badge: the data is real.
 */
const CHIP_DESCRIPTION = "You are signed in to the CommunityOps demo organization with live data";

export function DemoWorkspaceChip() {
  const { status, user } = useSession();

  const isDemo = status === "authenticated" && user?.isDemo === true;

  if (!isDemo) {
    return null;
  }

  // Not `role="status"`: this is persistent context that is true for the whole
  // session, not a change worth announcing. The Demo Mode badge owns that role,
  // which is part of what keeps the two semantically distinct (requirement 2.8).
  return (
    <p className="demo-chip">
      <span className="demo-chip__label">{CHIP_LABEL}</span>
      {/* Announced, not drawn. The visible label is two words on purpose — the
          top bar states context and gets out of the way. */}
      <span className="demo-chip__assistive"> — {CHIP_DESCRIPTION}</span>
    </p>
  );
}
