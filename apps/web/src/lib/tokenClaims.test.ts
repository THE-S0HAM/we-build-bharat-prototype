/**
 * Reading the `cognito:groups` claim out of an ID token.
 *
 * The claim is the only thing that says which organizations a session may act
 * for, so every shape it can arrive in has to read the same as
 * `get_caller_organizations` in `services/shared/tenancy.py`, and every shape it
 * cannot be read from has to resolve to "no organizations" rather than throwing.
 */

import { describe, expect, it } from "vitest";

import { decodeTokenClaims, readMemberOrganizations } from "./tokenClaims";

/** Build a token with a real base64url payload, as Cognito issues them. */
function tokenFor(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `header.${payload}.signature`;
}

describe("decodeTokenClaims", () => {
  it("decodes a base64url payload, including its unpadded and substituted forms", () => {
    // "ORG-a/b+c" forces both substituted characters into the encoding, and the
    // claim length leaves the payload unpadded.
    const claims = decodeTokenClaims(tokenFor({ sub: "user-1", name: "ORG-a/b+c??" }));

    expect(claims?.["sub"]).toBe("user-1");
    expect(claims?.["name"]).toBe("ORG-a/b+c??");
  });

  it("returns null for anything that is not a readable token", () => {
    expect(decodeTokenClaims(null)).toBeNull();
    expect(decodeTokenClaims("")).toBeNull();
    expect(decodeTokenClaims("fake.jwt.token")).toBeNull();
    expect(decodeTokenClaims("no-segments-at-all")).toBeNull();
  });
});

describe("readMemberOrganizations", () => {
  it("reads the array form an ID token carries", () => {
    const token = tokenFor({ "cognito:groups": ["ORG-wemakedev", "ORG-tenant-b"] });

    expect(readMemberOrganizations(token)).toEqual(["ORG-wemakedev", "ORG-tenant-b"]);
  });

  it("reads the flattened comma-separated and bracketed forms tenancy.py also parses", () => {
    expect(readMemberOrganizations(tokenFor({ "cognito:groups": "ORG-a, ORG-b" }))).toEqual([
      "ORG-a",
      "ORG-b",
    ]);
    expect(readMemberOrganizations(tokenFor({ "cognito:groups": "[ORG-a ORG-b]" }))).toEqual([
      "ORG-a",
      "ORG-b",
    ]);
  });

  it("reports no organizations when the claim is absent, empty or unreadable", () => {
    expect(readMemberOrganizations(tokenFor({ sub: "user-1" }))).toEqual([]);
    expect(readMemberOrganizations(tokenFor({ "cognito:groups": "" }))).toEqual([]);
    expect(readMemberOrganizations(tokenFor({ "cognito:groups": 7 }))).toEqual([]);
    expect(readMemberOrganizations("fake.jwt.token")).toEqual([]);
    expect(readMemberOrganizations(null)).toEqual([]);
  });
});
