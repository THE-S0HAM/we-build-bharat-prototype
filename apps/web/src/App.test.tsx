/**
 * Checks on the composed console: capability gating (requirement 11.1) and the
 * agreement between the navigation list and the route table.
 *
 * `/attendees` is chosen deliberately — it is the one capability-gated entry, and
 * because no route is registered for it the render mounts the shell and the
 * not-found view only, with no page and therefore no request.
 */

import { describe, expect, it, vi } from "vitest";
import { CAPABILITIES } from "./capabilities";
import { visibleNavSections } from "./navConfig";
import { navigableViewPaths } from "./routes";

const authFixture = vi.hoisted(() => ({
  token: "header.eyJzdWIiOiJVU1ItMSIsImVtYWlsIjoiYXNoYUBleGFtcGxlLm9yZyIsImNvZ25pdG86Z3JvdXBzIjpbIkxFQURFUiIsIk9SRy13ZW1ha2VkZXYiXX0.signature",
  user: {
    userId: "USR-1",
    email: "asha@example.org",
    name: "Asha",
    role: "LEADER" as const,
    organizations: ["ORG-wemakedev"],
    isDemo: false,
  },
}));

vi.mock("./auth", () => ({
  isAuthConfigured: true,
  isSignedIn: () => Promise.resolve(true),
  getSignedInUser: () => Promise.resolve(authFixture.user),
  isDemoSession: () => false,
  signOut: () => undefined,
  getIdToken: () => Promise.resolve(authFixture.token),
  getSignedInEmail: () => authFixture.user.email,
  getMemberOrganizations: () => Promise.resolve(authFixture.user.organizations),
  signIn: () => Promise.resolve(),
  AuthError: class AuthError extends Error {},
}));

describe("capability routing", () => {
  it("keeps AttendeeOps reachable now that its backend contract exists", () => {
    expect(CAPABILITIES.attendeeOps).toBe(true);
    expect(navigableViewPaths(CAPABILITIES)).toContain("/attendees");
  });

  it("registers a route for every navigation entry the capabilities leave visible", () => {
    const navigated = visibleNavSections(CAPABILITIES)
      .flatMap((section) => section.items)
      .map((item) => item.path);

    // Equal lists, in order: a nav entry with no route would 404, and a route
    // with no nav entry would be unreachable.
    expect(navigableViewPaths(CAPABILITIES)).toEqual(navigated);
  });
});
