import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { isMockMode } from "../api";
import { isAuthConfigured, isSignedIn, signOut as endCognitoSession } from "../auth";
import { SessionContext } from "./sessionContext";
import type { SessionStatus, SessionValue } from "./sessionContext";

/**
 * Two build configurations have no session to resolve, and treating them as
 * unresolved would hang the console on a skeleton forever.
 *
 *   - **Mock mode** (`VITE_USE_MOCK=true`, read through `api.ts` so mock mode has
 *     one source — requirement 13.9): the console serves local fixtures and
 *     never calls the API, so there is no token to hold and nothing to protect.
 *   - **No user pool configured**: `auth.ts` cannot produce a session at all. The
 *     honest outcome is the shell with failing requests behind it, not a login
 *     form that throws on submit.
 *
 * Neither grants access to anything. Every request still needs a token that only
 * Cognito can mint, and API Gateway still rejects requests without one
 * (requirement 16.2).
 */
const SESSION_NOT_REQUIRED = isMockMode || !isAuthConfigured;

export interface SessionProviderProps {
  children: ReactNode;
}

/**
 * Resolves the session once on mount and publishes it to the tree
 * (design.md §5.2, requirement 1.3).
 */
export function SessionProvider({ children }: SessionProviderProps) {
  const [status, setStatus] = useState<SessionStatus>(
    SESSION_NOT_REQUIRED ? "authenticated" : "unresolved",
  );

  /**
   * Generation counter for session probes. Only the newest probe may publish:
   * a sign-in completing while the mount probe is still awaiting a token
   * refresh would otherwise be overwritten by that older, staler answer.
   */
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (SESSION_NOT_REQUIRED) {
      setStatus("authenticated");
      return;
    }

    const probe = (generation.current += 1);

    // `isSignedIn` refreshes an expired ID token inside `auth.ts` before
    // answering, so "signed in" here means "a valid token is obtainable" —
    // the same thing `api.ts` needs per request.
    const signedIn = await isSignedIn();

    if (probe !== generation.current) return;

    setStatus(signedIn ? "authenticated" : "anonymous");
  }, []);

  useEffect(() => {
    void refresh();

    // Retiring the generation on unmount drops any answer still in flight.
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  /**
   * Clearing the session is all this does, and the navigation to `/login`
   * follows from it: the visitor is on a protected route, so `RequireSession`
   * resolves it to `/login` the moment the status turns anonymous
   * (requirement 1.6).
   *
   * Navigating from here as well was tried and removed. Two redirects competing
   * for the same transition is a race, and the guard wins it — leaving the
   * imperative one to look like it worked while contributing nothing. One
   * component decides where a session-less visitor goes.
   */
  const signOut = useCallback(() => {
    // Clears the SDK's stored tokens. Nothing of the session lives in React
    // state, so there is nothing else to wipe here (requirement 16.9).
    endCognitoSession();

    setStatus("anonymous");
  }, []);

  const session = useMemo<SessionValue>(
    () => ({ status, refresh, signOut }),
    [status, refresh, signOut],
  );

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
