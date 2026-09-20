import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionContext } from "../session/sessionContext";
import type { SessionStatus, SessionValue } from "../session/sessionContext";
import type { SignedInUser } from "../types";
import { DemoWorkspaceChip } from "./DemoWorkspaceChip";

const user: SignedInUser = {
  userId: "demo-user",
  email: "demo@example.org",
  name: "Demo Volunteer",
  role: "TEAM_MEMBER",
  organizations: ["ORG-demo"],
  isDemo: true,
};

function renderChip(status: SessionStatus = "authenticated", isDemo = true) {
  const value: SessionValue = {
    status,
    user: { ...user, isDemo },
    activeOrganizationId: "ORG-demo",
    refresh: () => Promise.resolve(),
    signOut: () => undefined,
  };
  return render(<SessionContext.Provider value={value}><DemoWorkspaceChip /></SessionContext.Provider>);
}

describe("DemoWorkspaceChip", () => {
  it("renders only from the authenticated session identity", () => {
    expect(renderChip("authenticated", false).container).toBeEmptyDOMElement();
    renderChip();
    expect(screen.getByText("Demo workspace").parentElement).toHaveTextContent("live data");
  });

  it("stays absent while unresolved, anonymous, or misconfigured", () => {
    expect(renderChip("unresolved").container).toBeEmptyDOMElement();
    expect(renderChip("anonymous").container).toBeEmptyDOMElement();
    expect(renderChip("configuration_error").container).toBeEmptyDOMElement();
  });
});
