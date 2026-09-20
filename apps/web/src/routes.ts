/**
 * The protected route table, derived from the navigation list (design.md §5.5,
 * §7.2, requirements 3.2, 11.1).
 *
 * `navConfig.ts` is the single source of what the console navigates to. This
 * module supplies the other half — which view each of those entries renders —
 * and builds the routes by walking the *same* `visibleNavSections` output the
 * `Sidebar` renders, with the *same* capability flags. A nav entry and its route
 * therefore cannot disagree about existence: they are the same list, filtered
 * once.
 *
 * An entry with no view here gets no route and falls through to the not-found
 * view, which is exactly the interim behaviour AttendeeOps needs — the route
 * resolves to not-found while its contract is missing, and nothing partial is
 * shipped (design.md §8.4, requirement 11.1).
 *
 * This is a table, not a component, so it is a `.ts` file and builds its
 * elements with `createElement`.
 */

import { createElement } from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";
import { Route } from "react-router-dom";
import { EventScopedView } from "./event/EventScopedView";
import type { EventScopedPageProps } from "./event/EventScopedView";
import { visibleNavSections } from "./navConfig";
import type { NavCapabilities } from "./navConfig";
import { ApprovalCenter } from "./pages/ApprovalCenter";
import { AgentConsole } from "./pages/AgentConsole";
import { AttendeeOps } from "./pages/AttendeeOps";
import { AuditLog } from "./pages/AuditLog";
import { Budget } from "./pages/Budget";
import { CheckinConsole } from "./pages/CheckinConsole";
import { CommandCenter } from "./pages/CommandCenter";
import { IncidentCenter } from "./pages/IncidentCenter";
import { SpeakerOps } from "./pages/SpeakerOps";
import { TaskBoard } from "./pages/TaskBoard";

/**
 * An event-scoped page, wrapped so it receives the resolved active event.
 *
 * This is where `const EVENT_ID = "EVT-devcon-2026"` used to be (design.md A16).
 * The identifier now comes from `EventProvider` — `GET /events` filtered by the
 * URL, the stored preference and status — and `EventScopedView` holds the page
 * back until there is a real one to hand it, so no page can be mounted with a
 * guessed event.
 */
function eventScoped(view: ComponentType<EventScopedPageProps>): ReactNode {
  return createElement(EventScopedView, { view });
}

/**
 * The view behind each navigation path. Keyed by the path from `navConfig.ts`,
 * so the key is the thing the nav entry links to and not a second spelling of it.
 */
const VIEW_BY_PATH: ReadonlyMap<string, ReactNode> = new Map<string, ReactNode>([
  ["/", createElement(CommandCenter)],
  ["/speakers", eventScoped(SpeakerOps)],
  ["/teams", eventScoped(TaskBoard)],
  ["/attendees", eventScoped(AttendeeOps)],
  ["/incidents", eventScoped(IncidentCenter)],
  ["/checkin", eventScoped(CheckinConsole)],
  ["/approvals", eventScoped(ApprovalCenter)],
  ["/budget", eventScoped(Budget)],
  ["/agent", eventScoped(AgentConsole)],
  ["/audit", eventScoped(AuditLog)],
]);

/**
 * The paths that get a route, in navigation order: every entry the supplied
 * capabilities leave visible that also has a view.
 *
 * Exported separately from the elements below so the agreement between
 * navigation and routing is a plain list a test can compare against
 * `visibleNavSections`.
 */
export function navigableViewPaths(capabilities: NavCapabilities): string[] {
  return visibleNavSections(capabilities)
    .flatMap((section) => section.items)
    .map((item) => item.path)
    .filter((path) => VIEW_BY_PATH.has(path));
}

/** Those paths as `<Route>` elements. */
export function protectedRoutes(capabilities: NavCapabilities): ReactElement[] {
  return navigableViewPaths(capabilities).map((path) =>
    createElement(Route, { key: path, path, element: VIEW_BY_PATH.get(path) }),
  );
}
