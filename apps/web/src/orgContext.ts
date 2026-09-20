/**
 * Which organization the console is acting for.
 *
 * `VITE_ORG_ID` used to answer this on its own: a build-time constant, the same
 * for every user of a deployment, and wrong for anyone who belongs to more than
 * one organization. The answer now comes from the ID token's `cognito:groups`
 * claim — the same claim `services/shared/tenancy.py` authorizes against — so
 * the value the client sends and the value the backend checks are derived from
 * one source (requirements 1.12, 16.3).
 *
 * ## The organization is never an input
 *
 * Two inputs are allowed to *express a preference* between organizations the
 * token already names: a `localStorage` entry and an `organization_id` URL
 * parameter. Neither can introduce one. Every candidate is checked for
 * membership in the token's groups and discarded when it is absent, so editing
 * storage or a query string changes which of your own organizations you land
 * in, and nothing else (requirement 16.4).
 *
 * This is scoping, not authorization. API Gateway and
 * `tenancy.authorize_organization` remain the access decision, and they reject
 * any `organization_id` outside the caller's groups regardless of what this
 * module resolves (requirement 16.2).
 *
 * ## Pure by design
 *
 * Every function takes the ID token as an argument rather than fetching one.
 * `src/api.ts` already holds the token it is about to send and resolves the
 * organization from exactly that token, which is what makes the sent
 * `organization_id` and the sent `Authorization` header impossible to
 * disagree. The session provider can call the same functions with the token it
 * resolved, for display.
 *
 * Only an organization identifier is persisted here — a tenant name, no
 * personal data, and never the token itself (requirements 16.8, 16.9).
 */

import { decodeTokenClaims, readMemberOrganizations } from "./lib/tokenClaims";

/**
 * URL parameter that may name an organization. It matches the API's own
 * parameter name, which is the form anyone constructing such a link would
 * reach for — including someone testing whether the console trusts it.
 */
const ORGANIZATION_URL_PARAM = "organization_id";

/** Prefix for the stored preference; the Cognito `sub` completes the key. */
const ORGANIZATION_STORAGE_PREFIX = "communityops.organization";

/**
 * Organizations the signed-in user may act for, in claim order.
 *
 * This is the selectable set: any surface offering a choice of organization
 * offers exactly these, so the set is a subset of the token's groups by
 * construction (requirement 1.12, design.md Property 5).
 */
export function selectableOrganizations(idToken: string | null): string[] {
  return readMemberOrganizations(idToken).filter((group) => group.startsWith("ORG-"));
}

/**
 * Storage key for the preference, scoped to the token's Cognito `sub`.
 *
 * Per-user keying follows design.md §5.4: a demo session and a real session in
 * the same browser must not inherit each other's selection. Membership is
 * re-checked on read regardless, so a leaked key would still grant nothing.
 *
 * @returns the key, or `null` when the token carries no usable `sub` and the
 * preference therefore has nowhere unambiguous to live.
 */
function organizationStorageKey(idToken: string | null): string | null {
  const subject = decodeTokenClaims(idToken)?.["sub"];

  return typeof subject === "string" && subject !== ""
    ? `${ORGANIZATION_STORAGE_PREFIX}.${subject}`
    : null;
}

/**
 * Read the stored organization preference.
 *
 * The value is untrusted: it is whatever is in `localStorage`, which the user
 * and anything running in the page can write. Callers must filter it against
 * the token's groups — `resolveOrganizationId` does.
 *
 * @returns the stored identifier, or `null` when there is none or storage is
 * unavailable.
 */
function readStoredOrganizationPreference(idToken: string | null): string | null {
  const key = organizationStorageKey(idToken);

  if (key === null) {
    return null;
  }

  try {
    return window.localStorage.getItem(key);
  } catch {
    // Storage can be disabled or full. A preference is a convenience, so its
    // absence resolves to the default organization rather than failing a load.
    return null;
  }
}

/**
 * Read the organization named in a URL query string.
 *
 * As untrusted as the stored preference, and filtered the same way.
 *
 * @param search a query string, e.g. `window.location.search`.
 */
function readUrlOrganization(search: string): string | null {
  try {
    return new URLSearchParams(search).get(ORGANIZATION_URL_PARAM);
  } catch {
    return null;
  }
}

/** Where a resolved organization came from, for diagnostics and for tests. */
export type OrganizationSource = "url" | "storage" | "token" | "fallback";

export type ResolvedOrganization = {
  /** The identifier to send as `organization_id`. */
  readonly organizationId: string;
  /** Organizations the token names; empty when no session is resolved. */
  readonly selectable: readonly string[];
  readonly source: OrganizationSource;
};

export type ResolveOrganizationOptions = {
  /** The session's ID token, or `null` when no session is resolved. */
  readonly idToken: string | null;
  /**
   * Used only when the token names no organization at all. Live API and session
   * callers reject that authenticated state before this fallback can be used;
   * the value remains for pre-session and explicit mock resolution.
   */
  readonly fallbackOrganizationId: string;
  /** Query string to read a preference from. Defaults to the current URL. */
  readonly search?: string;
};

/**
 * Resolve the organization to scope requests to.
 *
 * Precedence, highest first:
 *
 *   1. the `organization_id` URL parameter, **if the token's groups contain it**
 *   2. the stored preference, **if the token's groups contain it**
 *   3. the first organization the token names
 *   4. `fallbackOrganizationId`
 *
 * Steps 1 and 2 can only ever pick between values step 3 would also accept, so
 * the resolved identifier is always one of the token's groups whenever the
 * token names any (requirement 16.4).
 *
 * Step 4 is reached only when the token names none: before sign-in, or with a
 * token carrying no group claim. There is no such thing as an authenticated
 * user with an organization in this system — a token with no group is a
 * misconfigured account, and every request made under it is refused by
 * `tenancy.authorize_organization` whatever this returns. The fallback exists
 * so an unconfigured or pre-session client still has a well-formed value to
 * name, not as a second source of truth: whenever a session resolves an
 * organization, the token wins.
 */
export function resolveOrganization(options: ResolveOrganizationOptions): ResolvedOrganization {
  const { idToken, fallbackOrganizationId, search } = options;
  const selectable = selectableOrganizations(idToken);
  const [firstFromToken] = selectable;

  if (firstFromToken === undefined) {
    return { organizationId: fallbackOrganizationId, selectable, source: "fallback" };
  }

  const isMember = (candidate: string | null): candidate is string =>
    candidate !== null && selectable.includes(candidate);

  const fromUrl = readUrlOrganization(search ?? window.location.search);

  if (isMember(fromUrl)) {
    return { organizationId: fromUrl, selectable, source: "url" };
  }

  const fromStorage = readStoredOrganizationPreference(idToken);

  if (isMember(fromStorage)) {
    return { organizationId: fromStorage, selectable, source: "storage" };
  }

  return { organizationId: firstFromToken, selectable, source: "token" };
}

/**
 * Persist an organization preference for the next visit.
 *
 * Writes only when the token's groups contain `organizationId`, so the stored
 * value can never be poisoned through this path either. A rejected write is
 * silent: the caller's selection still applies to the current session, it just
 * is not remembered.
 *
 * @returns whether the preference was stored.
 */
export function rememberOrganization(idToken: string | null, organizationId: string): boolean {
  if (!selectableOrganizations(idToken).includes(organizationId)) {
    return false;
  }

  const key = organizationStorageKey(idToken);

  if (key === null) {
    return false;
  }

  try {
    window.localStorage.setItem(key, organizationId);
    return true;
  } catch {
    return false;
  }
}
