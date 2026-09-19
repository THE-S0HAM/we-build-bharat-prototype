/**
 * The single navigation configuration list (design.md §7.2, requirement 3.2).
 *
 * One flat, ordered list is the source of truth for what the console navigates
 * to. `Sidebar` renders it; later work — the route table and the capability
 * gate — reads the same list, so a route and its nav entry can never disagree
 * about existence, order or grouping.
 *
 * Two rules this module exists to enforce:
 *   - Order is the list order. Requirement 3.2 fixes it as Command Center,
 *     then OPERATIONS, then EVENT DAY, then GOVERNANCE, and the list is written
 *     in exactly that sequence rather than sorted at render time.
 *   - A capability-gated entry is ABSENT, not disabled, while its flag is off
 *     (requirement 3.5, A6). `visibleNavSections` drops the item, so nothing
 *     reaches the DOM to be hidden with CSS or greyed out.
 */

/** The three labelled groups. Ungrouped entries carry `group: null`. */
export type NavGroupId = "operations" | "event-day" | "governance";

/**
 * Capability flags that gate a nav entry. A flag is off unless the caller says
 * otherwise, so an unfinished area stays absent by default (design.md §8.7).
 */
export type NavCapability = "attendeeOps";

/** Badge slots an entry can carry. The count itself always comes from data. */
export type NavBadge = "pendingApprovals";

/**
 * The Approvals route, named because something other than the navigation links
 * to it: a `POLICY_REQUIRES_APPROVAL` failure carries a link to Approvals
 * (requirement 13.6). Named here rather than spelled again there, so the entry
 * below and that link cannot drift apart.
 */
export const APPROVALS_PATH = "/approvals";

export interface NavItem {
  /** Stable key, also used as the React key and in tests. */
  readonly id: string;

  /** Visible label. This is the entry's accessible name. */
  readonly label: string;

  /** Route path, matching the routing map in design.md §5.5. */
  readonly path: string;

  /**
   * True when the path must match exactly. Only `/` needs it: without it every
   * route would keep Command Center marked active.
   */
  readonly end?: boolean;

  /** Owning group, or `null` for an entry that sits above the first group. */
  readonly group: NavGroupId | null;

  /**
   * Capability flag this entry depends on. Present only where the underlying
   * contract does not exist yet.
   */
  readonly capability?: NavCapability;

  /**
   * The route behind this entry operates on one event, so it cannot be reached
   * until the organization has one (requirement 3.10).
   *
   * This is a different kind of unavailability from `capability`, and the
   * difference is the whole reason both exist. A capability-gated entry is
   * ABSENT: the contract behind it does not exist, so the product does not have
   * that area yet. An event-scoped entry with no event is DISABLED and stays
   * visible: the area is real and will work the moment an event exists, so
   * removing it would misrepresent the product's shape (requirement 3.5 versus
   * requirement 3.10).
   *
   * Mirrors `eventScoped()` in `src/routes.ts`: an entry marked here is one
   * whose view is wrapped in `EventScopedView`, and the two lists must name the
   * same routes.
   */
  readonly eventScoped?: boolean;

  /** Badge slot, filled by the caller's count when that count is above zero. */
  readonly badge?: NavBadge;
}

/**
 * The navigation list, in the order requirement 3.2 specifies.
 *
 * AttendeeOps is declared here rather than omitted from the file: the entry is
 * real, its data contract is not (A6). Declaring it with a capability flag
 * keeps one list honest about the product's shape while keeping the entry out
 * of the DOM until `GET /events/{eventId}/attendees` exists.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  // Not event-scoped: the Command Center summarises the organization and reads
  // `GET /command-center`, which takes no event.
  { id: "command-center", label: "Command Center", path: "/", end: true, group: null },
  { id: "speaker-ops", label: "SpeakerOps", path: "/speakers", group: "operations", eventScoped: true },
  { id: "team-ops", label: "TeamOps", path: "/teams", group: "operations", eventScoped: true },
  {
    id: "attendee-ops",
    label: "AttendeeOps",
    path: "/attendees",
    group: "operations",
    capability: "attendeeOps",
    eventScoped: true,
  },
  {
    id: "incident-ops",
    label: "IncidentOps",
    path: "/incidents",
    group: "operations",
    eventScoped: true,
  },
  { id: "checkin", label: "Check-In", path: "/checkin", group: "event-day", eventScoped: true },
  {
    id: "approvals",
    label: "Approvals",
    path: APPROVALS_PATH,
    group: "governance",
    badge: "pendingApprovals",
    eventScoped: true,
  },
  { id: "audit-log", label: "Audit Log", path: "/audit", group: "governance", eventScoped: true },
];

/**
 * Group labels are stored upper-case rather than transformed in CSS, so the
 * text a screen reader announces is the text requirement 3.2 names.
 */
const NAV_GROUP_LABELS: Record<NavGroupId, string> = {
  operations: "OPERATIONS",
  "event-day": "EVENT DAY",
  governance: "GOVERNANCE",
};

/** Section id for the ungrouped entries above the first labelled group. */
export const PRIMARY_SECTION_ID = "primary";

/** Which capability flags are on. Anything absent is treated as off. */
export type NavCapabilities = Readonly<Partial<Record<NavCapability, boolean>>>;

export interface NavSection {
  /** Group id, or `PRIMARY_SECTION_ID` for the ungrouped section. */
  readonly id: string;

  /** Group label, or `null` when the section renders without one. */
  readonly label: string | null;

  readonly items: readonly NavItem[];
}

/**
 * Group the nav list into renderable sections, dropping every entry whose
 * capability flag is off (requirement 3.5).
 *
 * Section order and item order both follow `NAV_ITEMS`, so requirement 3.2's
 * ordering is a property of the list rather than of this function. A section
 * whose entries are all gated away is dropped with them: a group label with
 * nothing under it would advertise an area that does not exist.
 */
export function visibleNavSections(capabilities: NavCapabilities = {}): NavSection[] {
  interface Draft {
    id: string;
    label: string | null;
    items: NavItem[];
  }

  const order: Draft[] = [];
  const byId = new Map<string, Draft>();

  for (const item of NAV_ITEMS) {
    if (item.capability && capabilities[item.capability] !== true) continue;

    const sectionId = item.group ?? PRIMARY_SECTION_ID;
    let section = byId.get(sectionId);
    if (!section) {
      section = {
        id: sectionId,
        label: item.group ? NAV_GROUP_LABELS[item.group] : null,
        items: [],
      };
      byId.set(sectionId, section);
      order.push(section);
    }
    section.items.push(item);
  }

  return order;
}
