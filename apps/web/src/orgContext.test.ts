/**
 * Organization resolution.
 *
 * The behaviour under test is requirement 16.4: a stored preference or a URL
 * parameter may pick between organizations the token already names, and can
 * introduce nothing. Someone editing `localStorage` or a query string must end
 * up exactly where they started.
 */

import { afterEach, describe, expect, it } from "vitest";

import { rememberOrganization, resolveOrganization, selectableOrganizations } from "./orgContext";

const FALLBACK = "ORG-configured";

function tokenFor(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `header.${payload}.signature`;
}

/** A session for a user who belongs to two organizations. */
const TWO_ORG_TOKEN = tokenFor({
  sub: "user-1",
  "cognito:groups": ["ORG-wemakedev", "ORG-tenant-b"],
});

const STORAGE_KEY = "communityops.organization.user-1";

afterEach(() => {
  window.localStorage.clear();
});

describe("selectableOrganizations", () => {
  it("is exactly what the token's groups claim names", () => {
    expect(selectableOrganizations(TWO_ORG_TOKEN)).toEqual(["ORG-wemakedev", "ORG-tenant-b"]);
  });

  it("is empty with no session, so no organization is selectable", () => {
    expect(selectableOrganizations(null)).toEqual([]);
  });
});

describe("resolveOrganization", () => {
  it("uses the token's first organization when nothing expresses a preference", () => {
    const resolved = resolveOrganization({
      idToken: TWO_ORG_TOKEN,
      fallbackOrganizationId: FALLBACK,
      search: "",
    });

    expect(resolved).toMatchObject({ organizationId: "ORG-wemakedev", source: "token" });
  });

  it("honours a URL parameter naming another of the token's organizations", () => {
    const resolved = resolveOrganization({
      idToken: TWO_ORG_TOKEN,
      fallbackOrganizationId: FALLBACK,
      search: "?organization_id=ORG-tenant-b",
    });

    expect(resolved).toMatchObject({ organizationId: "ORG-tenant-b", source: "url" });
  });

  it("disregards a URL parameter naming an organization outside the token's groups", () => {
    const resolved = resolveOrganization({
      idToken: TWO_ORG_TOKEN,
      fallbackOrganizationId: FALLBACK,
      search: "?organization_id=ORG-someone-else",
    });

    expect(resolved).toMatchObject({ organizationId: "ORG-wemakedev", source: "token" });
  });

  it("honours a stored preference naming another of the token's organizations", () => {
    window.localStorage.setItem(STORAGE_KEY, "ORG-tenant-b");

    const resolved = resolveOrganization({
      idToken: TWO_ORG_TOKEN,
      fallbackOrganizationId: FALLBACK,
      search: "",
    });

    expect(resolved).toMatchObject({ organizationId: "ORG-tenant-b", source: "storage" });
  });

  it("disregards a stored preference naming an organization outside the token's groups", () => {
    window.localStorage.setItem(STORAGE_KEY, "ORG-someone-else");

    const resolved = resolveOrganization({
      idToken: TWO_ORG_TOKEN,
      fallbackOrganizationId: FALLBACK,
      search: "",
    });

    expect(resolved).toMatchObject({ organizationId: "ORG-wemakedev", source: "token" });
  });

  it("keys the stored preference per user, so another session's entry is not read", () => {
    window.localStorage.setItem("communityops.organization.user-2", "ORG-tenant-b");

    const resolved = resolveOrganization({
      idToken: TWO_ORG_TOKEN,
      fallbackOrganizationId: FALLBACK,
      search: "",
    });

    expect(resolved).toMatchObject({ organizationId: "ORG-wemakedev", source: "token" });
  });

  it("falls back to the configured organization only when the token names none", () => {
    const noSession = resolveOrganization({
      idToken: null,
      fallbackOrganizationId: FALLBACK,
      search: "?organization_id=ORG-someone-else",
    });
    const noGroupClaim = resolveOrganization({
      idToken: tokenFor({ sub: "user-1" }),
      fallbackOrganizationId: FALLBACK,
      search: "",
    });

    expect(noSession).toMatchObject({ organizationId: FALLBACK, source: "fallback" });
    expect(noGroupClaim).toMatchObject({ organizationId: FALLBACK, source: "fallback" });
  });
});

describe("rememberOrganization", () => {
  it("stores an organization the token names", () => {
    expect(rememberOrganization(TWO_ORG_TOKEN, "ORG-tenant-b")).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("ORG-tenant-b");
  });

  it("refuses to store an organization outside the token's groups", () => {
    expect(rememberOrganization(TWO_ORG_TOKEN, "ORG-someone-else")).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
