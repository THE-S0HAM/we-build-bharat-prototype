/**
 * Tests for role and organization derivation.
 *
 * The property that matters: an unreadable, malformed or unexpected claim must yield
 * `TEAM_MEMBER`, never `LEADER`. This module decides what the console renders, so a bug here
 * shows a volunteer buttons they cannot use — and while the API would refuse the request, a UI
 * that offers authority it does not have is a UI nobody trusts.
 *
 * Both session sources are covered: a Cognito session, where the role is read from
 * `cognito:groups`, and a backend-issued demo session, where the backend already resolved it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Role } from "./types";

// Typed so that a role renamed in the domain types breaks these tests rather than leaving them
// asserting a string that no longer means anything.
const LEADER: Role = "LEADER";
const TEAM_MEMBER: Role = "TEAM_MEMBER";

/** Build an unsigned JWT with the given payload. Verification is the API's job, not this module's. */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

/** The token the stubbed Cognito session will hand back, or null for "not signed in". */
let cognitoToken: string | null = null;

async function loadAuth({ configured = true }: { configured?: boolean } = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_COGNITO_USER_POOL_ID", configured ? "ap-south-1_test" : "");
  vi.stubEnv("VITE_COGNITO_CLIENT_ID", configured ? "testclientid" : "");

  vi.doMock("amazon-cognito-identity-js", () => {
    class AuthenticationDetails {}
    class CognitoUser {}
    class CognitoUserPool {
      getCurrentUser() {
        if (cognitoToken === null) return null;
        return {
          getUsername: () => "someone@communityops.local",
          getSession: (
            cb: (err: Error | null, session: unknown) => void,
          ) =>
            cb(null, {
              isValid: () => true,
              getIdToken: () => ({ getJwtToken: () => cognitoToken }),
            }),
          signOut: () => undefined,
        };
      }
    }
    return { AuthenticationDetails, CognitoUser, CognitoUserPool };
  });

  return import("./auth");
}

beforeEach(() => {
  cognitoToken = null;
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("role derivation from a Cognito session", () => {
  it("reads LEADER from the groups claim", async () => {
    cognitoToken = jwt({
      email: "priya@wemakedev.org",
      "cognito:groups": ["ORG-wemakedev", "LEADER"],
    });
    const auth = await loadAuth();
    await expect(auth.getRole()).resolves.toBe(LEADER);
  });

  it("defaults to TEAM_MEMBER when no role group is present", async () => {
    cognitoToken = jwt({ email: "rahul@wemakedev.org", "cognito:groups": ["ORG-wemakedev"] });
    const auth = await loadAuth();
    await expect(auth.getRole()).resolves.toBe(TEAM_MEMBER);
  });

  it("handles the claim flattened into a string", async () => {
    // API Gateway sometimes delivers the claim as "[ORG-wemakedev LEADER]" rather than an array.
    cognitoToken = jwt({ "cognito:groups": "[ORG-wemakedev LEADER]" });
    const auth = await loadAuth();
    await expect(auth.getRole()).resolves.toBe(LEADER);
  });

  it("handles a comma-separated claim", async () => {
    cognitoToken = jwt({ "cognito:groups": "ORG-wemakedev,TEAM_MEMBER" });
    const auth = await loadAuth();
    await expect(auth.getRole()).resolves.toBe(TEAM_MEMBER);
  });

  it("falls back to TEAM_MEMBER on a malformed token", async () => {
    cognitoToken = "this.is.not.a.jwt";
    const auth = await loadAuth();
    await expect(auth.getRole()).resolves.toBe(TEAM_MEMBER);
  });

  it("does not grant LEADER from a group that merely contains the word", async () => {
    cognitoToken = jwt({ "cognito:groups": ["ORG-wemakedev", "TEAM_LEADERSHIP"] });
    const auth = await loadAuth();
    await expect(auth.getRole()).resolves.toBe(TEAM_MEMBER);
  });

  it("returns only ORG-prefixed groups as organizations", async () => {
    cognitoToken = jwt({
      "cognito:groups": ["ORG-wemakedev", "ORG-other", "LEADER", "TEAM_MEMBER"],
    });
    const auth = await loadAuth();
    await expect(auth.getMemberOrganizations()).resolves.toEqual(["ORG-wemakedev", "ORG-other"]);
  });

  it("reports nobody signed in when there is no Cognito user", async () => {
    const auth = await loadAuth();
    await expect(auth.getIdToken()).resolves.toBeNull();
    await expect(auth.getSignedInUser()).resolves.toBeNull();
  });

  it("reports nobody signed in when auth is not configured", async () => {
    cognitoToken = jwt({ "cognito:groups": ["LEADER"] });
    const auth = await loadAuth({ configured: false });
    expect(auth.isAuthConfigured).toBe(false);
    await expect(auth.getIdToken()).resolves.toBeNull();
  });

  it("exposes the display name and email from the claims", async () => {
    cognitoToken = jwt({
      email: "priya@wemakedev.org",
      name: "Priya Sharma",
      "cognito:groups": ["ORG-wemakedev", "LEADER"],
    });
    const auth = await loadAuth();
    const user = await auth.getSignedInUser();
    expect(user).toMatchObject({
      email: "priya@wemakedev.org",
      name: "Priya Sharma",
      role: "LEADER",
      isDemo: false,
    });
  });
});

describe("demo sessions", () => {
  it("uses the token and role the backend resolved", async () => {
    const auth = await loadAuth();
    auth.storeDemoSession(
      "demo.id.token",
      { email: "demo@communityops.local", organization_id: "ORG-wemakedev", role: "TEAM_MEMBER" },
      3600,
    );

    await expect(auth.getIdToken()).resolves.toBe("demo.id.token");
    await expect(auth.getRole()).resolves.toBe(TEAM_MEMBER);
    expect(auth.isDemoSession()).toBe(true);
    await expect(auth.getSignedInUser()).resolves.toMatchObject({
      email: "demo@communityops.local",
      isDemo: true,
    });
  });

  it("takes precedence over a Cognito session while it is active", async () => {
    // getIdToken checks the demo token first, so a stale demo session must not shadow a real
    // sign-in. signIn clears it; here we assert the precedence that makes that necessary.
    cognitoToken = jwt({ "cognito:groups": ["ORG-wemakedev", "LEADER"] });
    const auth = await loadAuth();
    auth.storeDemoSession(
      "demo.id.token",
      { email: "demo@communityops.local", organization_id: "ORG-wemakedev", role: "TEAM_MEMBER" },
      3600,
    );

    await expect(auth.getIdToken()).resolves.toBe("demo.id.token");

    auth.clearDemoSession();
    await expect(auth.getRole()).resolves.toBe(LEADER);
  });

  it("drops an expired demo session rather than sending a token the API would reject", async () => {
    const auth = await loadAuth();
    auth.storeDemoSession(
      "demo.id.token",
      { email: "demo@communityops.local", organization_id: "ORG-wemakedev", role: "TEAM_MEMBER" },
      -1,
    );

    expect(auth.isDemoSession()).toBe(false);
    await expect(auth.getIdToken()).resolves.toBeNull();
  });

  it("never persists anything resembling a password", async () => {
    const auth = await loadAuth();
    auth.storeDemoSession(
      "demo.id.token",
      { email: "demo@communityops.local", organization_id: "ORG-wemakedev", role: "TEAM_MEMBER" },
      3600,
    );

    const stored = Object.keys(sessionStorage)
      .map((key) => `${key}=${sessionStorage.getItem(key)}`)
      .join("|")
      .toLowerCase();
    expect(stored).not.toContain("password");
    expect(stored).not.toContain("secret");
  });

  it("is cleared by signing out", async () => {
    const auth = await loadAuth();
    auth.storeDemoSession(
      "demo.id.token",
      { email: "demo@communityops.local", organization_id: "ORG-wemakedev", role: "TEAM_MEMBER" },
      3600,
    );
    auth.signOut();
    expect(auth.isDemoSession()).toBe(false);
  });
});
