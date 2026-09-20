/**
 * Capability flags, read from build configuration (requirement 16.1).
 *
 * A capability flag answers one question: does the contract behind this area of
 * the product exist yet? It is not a permission — permissions are decided by
 * API Gateway and `tenancy.authorize_organization`, never in the browser
 * (requirement 16.2). Turning a flag on grants nothing; it only stops the
 * console hiding an area whose data it can finally fetch.
 *
 * One value, two consumers, and that is the point: `Sidebar` uses it to decide
 * which nav entries exist (requirement 3.5) and the route table uses it to
 * decide which routes exist (requirement 11.1). Reading the same object through
 * the same `visibleNavSections` call is what makes a visible nav entry that
 * 404s, or a reachable route with no way to find it, impossible.
 */

import type { NavCapabilities } from "./navConfig";

/**
 * Off unless the configured value is exactly `"true"`.
 *
 * Any other value — absent, empty, `"1"`, `"false"` — leaves the area absent.
 * A flag that turns itself on through a typo would ship a half-built page
 * (design.md A6).
 */
export const CAPABILITIES: NavCapabilities = {
  attendeeOps: true,
};
