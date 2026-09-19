/**
 * The signed-in person's name, from the ID token's `name` claim.
 *
 * The Command Center greeting is specified to carry the `name` claim
 * (requirement 4.1). `name` is one of the two attributes the deployed user pool
 * actually holds (`template.yaml`; the other is `email`), so it is real data —
 * unlike a role, which no token or API carries and which the console therefore
 * never prints (A2).
 *
 * A pure function over a token string, for the same reason as
 * `src/lib/tokenClaims.ts`: the caller already has, or can get, a token, and
 * this stays testable without a Cognito session. Nothing here is an access
 * decision, and nothing here is logged or persisted (requirement 16.9).
 */

import { decodeTokenClaims } from "./tokenClaims";

/**
 * Longest name the greeting will render. A name is a display string from a token
 * this side does not verify, so it is bounded before it reaches a heading.
 * Beyond the bound the greeting falls back to the page name rather than
 * truncating someone's name into something wrong.
 */
const MAX_NAME_LENGTH = 60;

/**
 * @returns the `name` claim, or `null` when the token carries no usable name —
 * no session, no claim, a non-string claim, or a value too long to be one. The
 * caller renders the page name instead; it never invents a name.
 */
export function readDisplayName(token: string | null): string | null {
  const claims = decodeTokenClaims(token);

  if (claims === null) {
    return null;
  }

  const name = claims["name"];

  if (typeof name !== "string") {
    return null;
  }

  const trimmed = name.trim();

  return trimmed === "" || trimmed.length > MAX_NAME_LENGTH ? null : trimmed;
}
