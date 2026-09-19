import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import type { Location } from "react-router-dom";
import {
  DEFAULT_ROUTE,
  LOGIN_ROUTE,
  intendedRouteState,
  readIntendedRoute,
} from "./intendedRoute";
import { useSession } from "./sessionContext";

/**
 * The route the visitor is on, as a value that can be navigated back to. Search
 * and hash are kept: a filtered or deep-linked view is the route they asked for,
 * not just its pathname.
 */
function currentRoute(location: Location): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

export interface RequireSessionProps {
  /** Protected content. Rendered only once a session is known to exist. */
  children: ReactNode;

  /**
   * What renders while the session is unresolved. This must be the application
   * shell with a skeleton in the content region (requirement 1.4) — it is the
   * caller's job because the session module knows nothing about the shell.
   */
  skeleton: ReactNode;
}

/**
 * The session gate for protected routes (design.md §5.5, requirements 1.3–1.5).
 *
 * One wrapper, three outcomes, and the order matters:
 *
 *   1. `unresolved` → the shell skeleton. Not the login screen, and not page
 *      content. This is the whole point of the component: a signed-in user
 *      reloading must not see a flash of the login form (requirement 1.4), and
 *      a protected page must not mount — and fire its requests — before a token
 *      is known to be available.
 *   2. `anonymous` → `/login`, carrying the route they asked for so sign-in can
 *      return them to it (requirement 1.5). `replace` keeps the protected URL
 *      out of history, where Back would only bounce off this gate again.
 *   3. `authenticated` → the route renders (requirement 1.3).
 *
 * This decides *rendering*, never access. Every request behind these routes is
 * still authorized by API Gateway and `tenancy.authorize_organization`
 * (requirement 16.2).
 */
export function RequireSession({ children, skeleton }: RequireSessionProps) {
  const { status } = useSession();
  const location = useLocation();

  if (status === "unresolved") {
    return <>{skeleton}</>;
  }

  if (status === "anonymous") {
    return (
      <Navigate to={LOGIN_ROUTE} replace state={intendedRouteState(currentRoute(location))} />
    );
  }

  return <>{children}</>;
}

export interface RedirectWhenAuthenticatedProps {
  /** The public content — the login screen. */
  children: ReactNode;

  /**
   * What renders while the session is unresolved. Anything but the login screen:
   * rendering it here and redirecting a moment later is the flash requirement
   * 1.4 exists to prevent, seen from the other side.
   */
  pending: ReactNode;
}

/**
 * The counterpart gate for `/login`, which the routing map marks public but
 * "redirects away when a session exists" (design.md §5.5).
 *
 * It is also what completes requirement 1.1's "navigate to the intended route,
 * defaulting to the Command Center": sign-in resolves the session, this gate
 * sees `authenticated`, and the retained route — validated on the way out, since
 * history state is not ours — becomes the destination. No imperative navigation
 * after sign-in, so there is exactly one place that decides where a fresh
 * session lands.
 */
export function RedirectWhenAuthenticated({
  children,
  pending,
}: RedirectWhenAuthenticatedProps) {
  const { status } = useSession();
  const { state } = useLocation();

  if (status === "unresolved") {
    return <>{pending}</>;
  }

  if (status === "authenticated") {
    return <Navigate to={readIntendedRoute(state) ?? DEFAULT_ROUTE} replace />;
  }

  return <>{children}</>;
}
