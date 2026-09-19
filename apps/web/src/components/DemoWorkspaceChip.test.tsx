/**
 * The "Demo workspace" chip (requirement 2.8).
 *
 * The chip makes one claim — *you are acting for the demo organization* — and the
 * test that matters is that it makes it only when that is true, and that it never
 * blurs into the Demo Mode badge, which claims something else entirely: that the
 * data on screen is fabricated.
 *
 * A demo session is recognised by comparing who is signed in to the identity the
 * build configured, so the Cognito boundary is the only thing replaced here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { SessionContext } from "../session/sessionContext";
import type { SessionStatus } from "../session/sessionContext";
import { DemoWorkspaceChip } from "./DemoWorkspaceChip";

const DEMO_USERNAME = "demo@communityops.dev";

const auth = vi.hoisted(() => ({ signedInAs: null as string | null }));

vi.mock("../auth", () => ({
  isAuthConfigured: true,
  getSignedInEmail: () => auth.signedInAs,
}));

function renderChip(status: SessionStatus = "authenticated") {
  return render(
    <SessionContext.Provider
      value={{ status, refresh: () => Promise.resolve(), signOut: () => undefined }}
    >
      <DemoWorkspaceChip />
    </SessionContext.Provider>,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  auth.signedInAs = null;
});

function configureDemo(): void {
  vi.stubEnv("VITE_DEMO_USERNAME", DEMO_USERNAME);
  vi.stubEnv("VITE_DEMO_PASSWORD", "not-a-real-one");
}

describe("DemoWorkspaceChip", () => {
  it("renders nothing when no demo identity is configured", () => {
    auth.signedInAs = DEMO_USERNAME;

    // Today's state (design.md A18): the demo organization does not exist, so no
    // session can be a demo session.
    expect(renderChip().container).toBeEmptyDOMElement();
  });

  it("renders nothing for a real operator's session", () => {
    configureDemo();
    auth.signedInAs = "lead@wemakedev.org";

    expect(renderChip().container).toBeEmptyDOMElement();
  });

  it("reports the demo workspace while the demo identity is signed in", () => {
    configureDemo();
    auth.signedInAs = DEMO_USERNAME;

    renderChip();

    const chip = screen.getByText("Demo workspace");

    // Two visible words in the top bar; the meaning is announced in full, and it
    // is about the workspace, never about the data being fake.
    expect(chip.parentElement).toHaveTextContent(
      "Demo workspace — You are signed in to the CommunityOps demo organization with live data",
    );
    expect(chip.parentElement?.textContent).not.toContain("simulated");

    // `role="status"` belongs to the Demo Mode badge. This is persistent context
    // for the whole session, not a change worth interrupting for — which is half
    // of what keeps the two semantically distinct (requirement 2.8).
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders nothing until the session has resolved", () => {
    configureDemo();
    auth.signedInAs = DEMO_USERNAME;

    expect(renderChip("unresolved").container).toBeEmptyDOMElement();
    expect(renderChip("anonymous").container).toBeEmptyDOMElement();
  });
});
