/**
 * The intended route — where a visitor was trying to go when the session gate
 * sent them to sign in (requirements 1.5, 1.1).
 *
 * It travels in the navigation's history state, not in the URL. Two reasons:
 * a route can carry a search string with operational identifiers, and an
 * address bar reading `/login?next=/events/EVT-…/checkin` invites editing. The
 * value is therefore never rendered, never persisted by us, and never trusted
 * on the way back out — `readIntendedRoute` re-validates it.
 */

export const LOGIN_ROUTE = "/login";

/** Where a signed-in visitor lands when no intended route was retained. */
export const DEFAULT_ROUTE = "/";

/** History state carrying the route the visitor asked for. */
export interface IntendedRouteState {
  readonly from: string;
}

/**
 * A retained route must be a path inside this application.
 *
 * `//evil.example` and `/\evil.example` are both read as protocol-relative URLs
 * by browsers, so a value that passed a bare `startsWith("/")` check could
 * navigate off-site. `/login` is rejected too: retaining it would bounce a
 * visitor back to the screen they just finished with.
 */
export function isSafeIntendedRoute(route: string): boolean {
  if (!route.startsWith("/")) return false;
  if (route.startsWith("//") || route.startsWith("/\\")) return false;

  return route !== LOGIN_ROUTE && !route.startsWith(`${LOGIN_ROUTE}?`);
}

/** The history state to attach when redirecting to `/login`. */
export function intendedRouteState(route: string): IntendedRouteState {
  return { from: route };
}

/**
 * Read the intended route back out of history state, or `null` when there is
 * nothing usable there.
 *
 * The argument is `unknown` because that is what history state honestly is:
 * anything can put anything in it, and a reload replays whatever was there.
 */
export function readIntendedRoute(state: unknown): string | null {
  if (typeof state !== "object" || state === null || !("from" in state)) {
    return null;
  }

  const from = state.from;

  return typeof from === "string" && isSafeIntendedRoute(from) ? from : null;
}
