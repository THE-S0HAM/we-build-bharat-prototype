/**
 * The demo-access configuration gate (requirements 2.1, 2.2, 2.8, 2.10).
 *
 * One rule decides whether the console offers a demo at all: both credential
 * halves are present, or there is no demo action in the DOM. Everything here is a
 * statement about that rule and about the honest way a demo session is
 * recognised afterwards.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configuredDemoAccess,
  isDemoIdentity,
  resolveDemoAccess,
  type DemoCredentials,
} from "./demoAccess";

const DEMO: DemoCredentials = { username: "demo@communityops.dev", password: "not-a-real-one" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveDemoAccess", () => {
  it("resolves a credential only when both halves are configured", () => {
    expect(resolveDemoAccess({ username: DEMO.username, password: DEMO.password })).toEqual(DEMO);
  });

  it("resolves nothing when the configuration is absent", () => {
    expect(resolveDemoAccess({})).toBeNull();
  });

  it("resolves nothing from half a credential, and says so in the console only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(resolveDemoAccess({ username: DEMO.username })).toBeNull();
    expect(resolveDemoAccess({ password: DEMO.password })).toBeNull();

    // Whether the gap is reported at all depends on the build being a dev build;
    // what matters is that no password is ever named when it is.
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(DEMO.password);
    }
  });

  it("treats a blank value as absent and reports nothing for a wholly unset build", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // The shape an unset variable takes in a CI template.
    expect(resolveDemoAccess({ username: "  ", password: "" })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("trims the username and never the password", () => {
    const resolved = resolveDemoAccess({ username: "  demo@communityops.dev ", password: " pw " });

    // Surrounding whitespace is never part of an address. It can be part of a
    // password, so the password is passed exactly as configured.
    expect(resolved).toEqual({ username: "demo@communityops.dev", password: " pw " });
  });
});

describe("configuredDemoAccess", () => {
  it("resolves nothing for this build, which is the state today", () => {
    // No ORG-demo group, no demo identity, no seeded demo organization
    // (design.md A18), so there is nothing for the variables to name.
    expect(configuredDemoAccess()).toBeNull();
  });

  it("reads the configuration at call time", () => {
    vi.stubEnv("VITE_DEMO_USERNAME", DEMO.username);
    vi.stubEnv("VITE_DEMO_PASSWORD", DEMO.password);

    expect(configuredDemoAccess()).toEqual(DEMO);
  });
});

describe("isDemoIdentity", () => {
  it("recognises the configured demo identity, case-insensitively", () => {
    expect(isDemoIdentity("demo@communityops.dev", DEMO)).toBe(true);
    expect(isDemoIdentity("  DEMO@CommunityOps.dev  ", DEMO)).toBe(true);
  });

  it("does not label another signed-in user a demo session", () => {
    expect(isDemoIdentity("lead@wemakedev.org", DEMO)).toBe(false);
  });

  it("is false with no session and with no configured demo identity", () => {
    // Which is also what makes the chip disappear on sign-out rather than
    // outliving the session that earned it (requirement 2.8).
    expect(isDemoIdentity(null, DEMO)).toBe(false);
    expect(isDemoIdentity(DEMO.username, null)).toBe(false);
  });
});
