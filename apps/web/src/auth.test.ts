import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthError,
  clearDemoSession,
  getIdToken,
  getMemberOrganizations,
  getRole,
  getSignedInUser,
  isDemoSession,
  signOut,
  storeDemoSession,
} from "./auth";
import type { DemoSession } from "./types";

function tokenFor(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `header.${payload}.signature`;
}

const demo: DemoSession = {
  id_token: tokenFor({ sub: "demo-user", email: "demo@communityops.local", "cognito:groups": ["ORG-demo", "TEAM_MEMBER"], is_demo: true }),
  expires_in: 3600,
  email: "demo@communityops.local",
  organization_id: "ORG-demo",
  role: "TEAM_MEMBER",
  is_demo: true,
  message: "ready",
};

beforeEach(() => {
  sessionStorage.clear();
  clearDemoSession();
});
afterEach(() => {
  sessionStorage.clear();
  clearDemoSession();
});

describe("restricted demo session", () => {
  it("derives only the token-consistent restricted tenant and role", async () => {
    storeDemoSession(demo);
    expect(isDemoSession()).toBe(true);
    expect(await getIdToken()).toBe(demo.id_token);
    expect(await getMemberOrganizations()).toEqual(["ORG-demo"]);
    expect(await getRole()).toBe("TEAM_MEMBER");
    expect(await getSignedInUser()).toMatchObject({ email: demo.email, role: "TEAM_MEMBER", isDemo: true });
  });

  it.each([
    { organization_id: "ORG-foreign" },
    { id_token: tokenFor({ "cognito:groups": ["ORG-demo", "LEADER"], is_demo: true }) },
    { id_token: tokenFor({ sub: "demo-user", "cognito:groups": ["ORG-demo"], is_demo: true }) },
    { id_token: tokenFor({ sub: "demo-user", is_demo: true }) },
    { is_demo: false },
  ])("rejects response metadata that could widen token authority", (override) => {
    expect(() => storeDemoSession({ ...demo, ...override } as DemoSession)).toThrow(AuthError);
    expect(isDemoSession()).toBe(false);
  });

  it("clears the restricted token on normal sign-out", async () => {
    storeDemoSession(demo);
    signOut();
    expect(isDemoSession()).toBe(false);
    expect(await getIdToken()).toBeNull();
  });
});
