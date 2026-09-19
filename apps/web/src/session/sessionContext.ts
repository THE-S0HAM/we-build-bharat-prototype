/**
 * Session state for the console (design.md §5.2, "State Model", requirement 1.3).
 *
 * There is exactly one session in the product and it lives here. `auth.ts` owns
 * the Cognito conversation — SRP sign-in, token retrieval and refresh, sign-out
 * — and this context owns the single answer the rest of the console needs from
 * it: *has the session resolved, and is there one?*
 *
 * What this context deliberately does NOT hold:
 *
 *   - **No token.** Tokens stay in the Cognito SDK's own storage, which is what
 *     keeps them out of application state, URLs and logs (requirement 16.9).
 *     `api.ts` asks `auth.ts` for a fresh one per request.
 *   - **No permissions.** The status below gates *routing and affordances*, never
 *     access: API Gateway's authorizer and `tenancy.authorize_organization`
 *     remain the only access decision in the system (requirement 16.2). A
 *     visitor who forges `authenticated` in devtools gains a rendered shell and
 *     a wall of 401s.
 *   - **No personal data.** Nothing here is written to `localStorage` or logged
 *     (requirement 16.8). Claim-derived identity (`name`, `email`, the
 *     organization set from `cognito:groups`) arrives with task 2.2, which owns
 *     organization context.
 */

import { createContext, useContext } from "react";

/**
 * Three states, and the first one is the reason this context exists.
 *
 * `unresolved` is not a loading spinner — it is the honest statement that the
 * console does not yet know whether a session exists, because answering needs a
 * read of the Cognito SDK's storage and possibly a token refresh. Collapsing it
 * into `anonymous` is what makes a login screen flash on reload for a signed-in
 * user (requirement 1.4).
 */
export type SessionStatus = "unresolved" | "authenticated" | "anonymous";

export interface SessionValue {
  readonly status: SessionStatus;

  /**
   * Re-read the session from the Cognito SDK and publish the result.
   *
   * Called after a successful sign-in: the provider never takes a caller's word
   * that a session now exists, it goes and looks. Safe to call at any time —
   * a later probe always wins over an earlier one still in flight.
   */
  refresh(): Promise<void>;

  /**
   * Clear the session (requirement 1.6).
   *
   * Reaching `/login` is the route guard's job: with no session, every protected
   * route resolves there. One sign-out path serves every session, demo included
   * (requirement 2.9).
   */
  signOut(): void;
}

/**
 * `null` marks "no provider above me", which `useSession` turns into a thrown
 * error rather than a silent default. A default session value here would let a
 * component render as though it were signed out — or in — depending on which
 * default we picked, and neither is a truth this module can know.
 */
export const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const session = useContext(SessionContext);

  if (session === null) {
    throw new Error("useSession must be called inside a SessionProvider.");
  }

  return session;
}
