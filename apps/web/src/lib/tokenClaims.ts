/**
 * Reading claims out of a Cognito ID token.
 *
 * These are **pure functions over a token string**, deliberately not session
 * accessors. Two callers need the same claim from the same token at different
 * moments:
 *
 *   - `src/auth.ts` exposes `getMemberOrganizations()` for UI surfaces, which
 *     must fetch a token before it can read one.
 *   - `src/api.ts` already holds the token it is about to send, so re-entering
 *     the session just to re-read the same claim would be wasted work.
 *
 * Keeping the parsing here gives both a single implementation, and keeps the
 * organization resolver in `src/orgContext.ts` testable without a Cognito
 * session or a mocked auth module.
 *
 * Nothing here verifies the token's signature, and nothing here may be used as
 * an access decision. The ID token is validated by the API Gateway Cognito
 * authorizer, and `services/shared/tenancy.py` re-derives group membership from
 * its own copy of the claims on every request. A claim read on this side is for
 * scoping a request and labelling the UI, never for granting anything
 * (requirements 16.2, 16.4).
 *
 * No token or claim value is logged or persisted by this module (requirement 16.9).
 */

/** A decoded ID token payload. Values are unverified and must be narrowed. */
export type TokenClaims = Readonly<Record<string, unknown>>;

/**
 * Decode the payload segment of a JWT.
 *
 * JWT segments are base64url, which `atob` does not accept: `-` and `_` stand
 * in for `+` and `/`, and the trailing `=` padding is dropped. Both are
 * restored before decoding, so a real Cognito token whose payload happens to
 * contain either character still reads correctly.
 *
 * @returns the claims, or `null` for anything that is not a decodable JWT
 * payload — no session, a malformed token, or a non-object payload. Callers
 * treat `null` as "this token tells us nothing" rather than as an error, so a
 * bad token can never be mistaken for authority.
 */
export function decodeTokenClaims(token: string | null): TokenClaims | null {
  if (!token) {
    return null;
  }

  const payloadSegment = token.split(".")[1];

  if (!payloadSegment) {
    return null;
  }

  const base64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");

  try {
    const payload: unknown = JSON.parse(atob(padded));

    // A JWT payload is a JSON object; `atob` of arbitrary text can decode to a
    // string, a number or null, none of which carry claims.
    return typeof payload === "object" && payload !== null
      ? (payload as TokenClaims)
      : null;
  } catch {
    return null;
  }
}

/**
 * Read the organization identifiers from a token's `cognito:groups` claim.
 *
 * Every organization in this system has a Cognito group whose name *is* the
 * organization identifier (`services/shared/tenancy.py`), so the group list is
 * the membership list — there is no prefix convention to filter on, and adding
 * one here would silently hide an organization the backend would have allowed.
 *
 * The claim arrives as a JSON array in an ID token, but API Gateway flattens it
 * to a bare value, a comma-separated list, or a bracketed space-separated list
 * depending on the integration. `get_caller_organizations` in `tenancy.py`
 * parses all three; this reads the same three so the two sides can never
 * disagree about what a token says.
 *
 * @returns the identifiers in claim order, de-duplicated, with blanks dropped.
 * An empty array means the token names no organization.
 */
export function readMemberOrganizations(token: string | null): string[] {
  const claims = decodeTokenClaims(token);

  if (claims === null) {
    return [];
  }

  const raw = claims["cognito:groups"];
  const names = Array.isArray(raw)
    ? raw.map((group) => String(group))
    : typeof raw === "string"
      ? raw.trim().replace(/^\[|\]$/g, "").split(/[,\s]+/)
      : [];

  const organizations = names.map((name) => name.trim()).filter((name) => name !== "");

  return [...new Set(organizations)];
}
