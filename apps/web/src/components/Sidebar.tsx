import { useId } from "react";
import { NavLink } from "react-router-dom";
import { visibleNavSections } from "../navConfig";
import type { NavBadge, NavCapabilities, NavItem } from "../navConfig";
import type { Role } from "../types";
import "./Sidebar.css";

/**
 * The product name in the wordmark (requirement 3.1). There is one product name
 * and it is this one — it is declared here once so no other surface can spell a
 * different one, and so a sweep for a stray product name finds nothing.
 */
const PRODUCT_NAME = "CommunityOps";

/**
 * What each badge count means, announced after the number so the link reads as
 * "Approvals 3 pending approvals" rather than "Approvals 3". Keyed by badge, so
 * a new badge slot cannot be added without supplying its wording.
 */
const BADGE_DESCRIPTIONS: Record<NavBadge, string> = {
  pendingApprovals: "pending approvals",
};

/**
 * Why an event-scoped entry cannot be opened right now (requirement 3.10).
 *
 * Rendered as visible text beside the label, not only as `aria-disabled`: the
 * entry is unavailable for a reason the user can act on, and a greyed label is a
 * colour-only signal (requirement 15.10).
 */
const EVENT_REQUIRED_NOTE = "Needs an event";

export interface SidebarAccount {
  /** The `name` claim from the ID token. */
  name: string;

  /** The `email` claim from the ID token. */
  email: string;

  /**
   * The active organization identifier, derived from the token's
   * `cognito:groups` claim by the caller.
   */
  organizationId: string;
  role?: Role;
}

export interface SidebarProps {
  /**
   * Identity for the account block. Omit it while the session is unresolved:
   * the block is then absent rather than showing placeholder identity.
   */
  account?: SidebarAccount;

  /**
   * `summary.pending_approvals` from `GET /command-center`. Rendered as a badge
   * on the Approvals entry when above zero (requirement 3.4). The caller owns
   * the fetch; this component never requests data.
   */
  pendingApprovals?: number;

  /**
   * Capability flags that are on. Any flag left out is off, so a gated entry is
   * absent by default (requirement 3.5).
   */
  capabilities?: NavCapabilities;

  /**
   * The organization has no event, so every entry marked `eventScoped` in the
   * nav config is rendered disabled (requirement 3.10).
   *
   * Disabled, deliberately not omitted, and that is the whole difference from
   * `capabilities`. A capability-gated entry is absent because the product does
   * not have that area yet; an event-scoped entry with no event is an area that
   * exists and will work the moment an event does, so removing it would
   * misrepresent the product's shape. Same reasoning as `NavItem.eventScoped`.
   *
   * Off by default: a caller with no event context to report gets the normal
   * navigation rather than a disabled one.
   */
  eventScopedDisabled?: boolean;
}

/**
 * The navigation contents: wordmark, grouped entries, account block
 * (design.md §7, §7.2).
 *
 * This component renders NO `<nav>` element. `AppShell` owns the single
 * navigation landmark and the nav region's width, surface and divider; this
 * fills that slot. Rendering a `<nav>` here would nest a duplicate landmark and
 * break requirement 15.1.
 *
 * Everything displayed arrives as a prop. The component reads no token, calls
 * no API and touches no storage, which is what keeps identity handling in one
 * place and keeps this renderable in a test with nothing but a router.
 */
export function Sidebar({
  account,
  pendingApprovals = 0,
  capabilities,
  eventScopedDisabled = false,
}: SidebarProps) {
  const sections = visibleNavSections(capabilities);

  // Group labels are referenced by their list through `aria-labelledby`, so the
  // ids must be unique even if two sidebars ever render in one document.
  const idPrefix = useId();

  // Keyed by badge rather than checked with an `if`, so adding a badge slot to
  // the nav config fails to compile until its count is wired up here.
  const badgeCounts: Record<NavBadge, number> = { pendingApprovals };

  function renderItem(item: NavItem) {
    const count = item.badge ? badgeCounts[item.badge] : 0;

    if (eventScopedDisabled && item.eventScoped === true) {
      // Not a `NavLink`, and not a link at all: the route resolves to the
      // no-events state, so an entry that navigated there would look like it
      // worked. A `<span>` keeps the entry and its position visible while
      // removing the destination, which is exactly what is unavailable.
      //
      // No badge either. A count only exists for an event, and there is none.
      return (
        <li key={item.id}>
          <span className="side-nav__link side-nav__link--disabled" aria-disabled="true">
            <span className="side-nav__link-icon" data-nav-icon={item.id} aria-hidden="true" />
            <span className="side-nav__link-text">
              <span className="side-nav__link-label">{item.label}</span>
              <span className="side-nav__link-note">{EVENT_REQUIRED_NOTE}</span>
            </span>
          </span>
        </li>
      );
    }

    return (
      <li key={item.id}>
        <NavLink
          to={item.path}
          end={item.end}
          // React Router applies this only while the entry is the active route,
          // which is exactly requirement 3.3. Stated explicitly rather than
          // left to the library default, because the requirement is on us.
          aria-current="page"
          // The active entry carries weight and a left rule as well as colour,
          // so position is never signalled by colour alone (requirement 15.10).
          className={({ isActive }) =>
            isActive ? "side-nav__link side-nav__link--active" : "side-nav__link"
          }
        >
          {/* The rail's monogram between `--bp-md` and `--bp-lg`
              (requirement 14.2). Empty in the DOM and hidden from assistive
              technology: its glyph is CSS `content` keyed by `data-nav-icon`, so
              the entry's accessible name and its text stay exactly the label.
              It repeats the label, it never replaces it — the label itself
              appears beside the rail on hover and focus. */}
          <span className="side-nav__link-icon" data-nav-icon={item.id} aria-hidden="true" />

          <span className="side-nav__link-text">
            <span className="side-nav__link-label">{item.label}</span>
          </span>

          {item.badge && count > 0 ? (
            <span className="side-nav__badge">
              {count}
              <span className="side-nav__badge-context">
                {" "}
                {BADGE_DESCRIPTIONS[item.badge]}
              </span>
            </span>
          ) : null}
        </NavLink>
      </li>
    );
  }

  return (
    <div className="side-nav">
      {/* Not a link: Command Center is the first entry, and a second control to
          the same route would only add a stop for keyboard users.
          The mark is the rail's stand-in for the name between `--bp-md` and
          `--bp-lg`, where the full wordmark does not fit. Its glyph is CSS
          `content`, so the product name in the DOM stays exactly one string
          (requirement 3.1). */}
      <p className="side-nav__wordmark">
        <span className="side-nav__wordmark-mark" aria-hidden="true" />
        <span className="side-nav__wordmark-name">{PRODUCT_NAME}</span>
      </p>

      <div className="side-nav__groups">
        {sections.map((section) => {
          // Group labels are deliberately not headings: they are not
          // interactive and must stay out of the page's heading order, which
          // belongs to `PageHeader`'s `<h1>` and the page's sections
          // (requirement 15.1). Labelling the list gives the grouping to
          // assistive technology without adding an outline entry.
          const labelId = section.label ? `${idPrefix}${section.id}` : undefined;

          return (
            <div className="side-nav__group" key={section.id}>
              {section.label ? (
                <p className="side-nav__group-label" id={labelId}>
                  {section.label}
                </p>
              ) : null}

              <ul className="side-nav__list" aria-labelledby={labelId}>
                {section.items.map(renderItem)}
              </ul>
            </div>
          );
        })}
      </div>

      {/* Name, email, active organization — and nothing else. There is no role
          claim in any token or API response, so a role label here would be
          invented data (requirement 3.6, A2). */}
      {account ? (
        <div className="side-nav__account">
          <p className="side-nav__account-name">{account.name}</p>
          <p className="side-nav__account-email">{account.email}</p>
          <p className="side-nav__account-org">{account.organizationId}</p>
          {account.role ? <p className="side-nav__account-org">{account.role === "LEADER" ? "Community leader" : "Team member"}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
