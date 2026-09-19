import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { BELOW_BP_MD, useMediaQuery } from "../lib/useMediaQuery";
import "./AppShell.css";

/**
 * The id of the shell's single `<main>` element and the target of the skip
 * link. Exported so anything that needs to point at the content region links to
 * it rather than re-deriving the value.
 */
export const MAIN_CONTENT_ID = "main-content";

/**
 * The compact-width navigation control (requirement 14.3). Exported so a test
 * names the same control the user reads rather than a copy of the string.
 */
export const NAV_MENU_LABEL = "Menu";

export interface AppShellProps {
  /**
   * Navigation content, rendered inside the shell's single `<nav>` landmark.
   *
   * The shell owns the landmark, so this slot must not render a `<nav>` of its
   * own — that would nest a duplicate landmark (requirement 15.1).
   */
  navigation: ReactNode;

  /**
   * Accessible name for the navigation landmark. Override only when a route
   * renders a genuinely different navigation set.
   */
  navigationLabel?: string;

  /**
   * Global context bar. Rendered inside the shell's `<header>` banner at or
   * above `--bp-md`, and inside the navigation panel below it, where the event
   * switcher belongs to the panel rather than to the header
   * (requirement 14.3).
   *
   * Omit it and no context bar renders at either width, so the frame never shows
   * an empty bar.
   */
  topbar?: ReactNode;

  /**
   * Page content, rendered inside the shell's single `<main>`. Direct children
   * are the page's sections and pick up the shell's section rhythm.
   */
  children: ReactNode;
}

/**
 * The one page frame for every authenticated route (design.md §7, §15.1).
 *
 * The shell owns the structure pages must not redefine: the skip link, the
 * `<nav>` landmark, the `<header>` banner, the single `<main>`, the content
 * column capped at `--content-max`, the page padding and the section rhythm.
 * That is what makes the frame identical on every route (requirement 12.4).
 *
 * Navigation and the top bar arrive as slots, so the shell has no knowledge of
 * — and no dependency on — what fills them.
 *
 * Landmarks rendered here, exactly once each (requirement 15.1):
 *   - `<nav>`, labelled, wrapping the `navigation` slot
 *   - `<header>`, a banner because it is not inside `main`, `nav` or `section`
 *   - `<main>`, the skip link's target
 *
 * The `<h1>` is not the shell's: `PageHeader` owns it, so the single top-level
 * heading belongs to the page rather than the frame.
 *
 * ## The four widths (design.md §Responsive Behaviour, requirements 14.1–14.3)
 *
 * | Width | Frame |
 * |---|---|
 * | ≥ `--bp-lg` | Full `--nav-w` navigation column, content capped at `--content-max` |
 * | `--bp-md` to `--bp-lg` | Navigation collapses to the `--nav-w-collapsed` icon rail, labels on hover and focus; one content column |
 * | `--bp-sm` to `--bp-md` | Navigation is a menu button opening a full-height `--nav-panel-w` panel that also holds the event switcher |
 * | < `--bp-sm` | The same menu panel, full width, over a sticky `--header-h` bar |
 *
 * Only the third row needs JavaScript, and only for one reason: below `--bp-md`
 * the event switcher lives *inside the panel*, which is a different place in the
 * DOM rather than a different appearance. Rendering it twice and hiding one copy
 * would leave a second switcher in the document for anything that does not read
 * the cascade to find. So `useMediaQuery` decides where the `topbar` slot goes,
 * and every other width behaviour stays in `AppShell.css` where it belongs.
 *
 * ## Panel behaviour
 *
 * The panel is navigation, not progressive disclosure, so it is deliberately not
 * a `Drawer` and carries no `role="dialog"` — the `Drawer` stays the product's
 * one disclosure surface (requirement 12.6). It still behaves like a layer a
 * keyboard user can get into and out of: focus moves into it on open and returns
 * to the menu button on close, Escape closes it (requirement 15.6), activating a
 * navigation entry closes it, and the scrim behind it closes it.
 *
 * A closed panel carries the `hidden` attribute, so below `--bp-md` the `<nav>`
 * landmark exists only while the menu is open. That is what requirement 14.3
 * asks for — the navigation *is* a menu button at that width — and it is the
 * standard disclosure pattern: the button is the navigation's affordance, and
 * `aria-expanded` with `aria-controls` is what tells assistive technology what
 * it opens. The alternative, keeping the panel in the document and moving it
 * off-screen, would leave every entry focusable behind a closed menu.
 */
export function AppShell({
  navigation,
  navigationLabel = "Main navigation",
  topbar,
  children,
}: AppShellProps) {
  const compact = useMediaQuery(BELOW_BP_MD);
  const [menuOpen, setMenuOpen] = useState(false);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
  }, []);

  // Leaving compact widths with the menu open would otherwise leave `menuOpen`
  // set, so the next narrowing would show the panel without anyone asking.
  useEffect(() => {
    if (!compact) setMenuOpen(false);
  }, [compact]);

  const panelOpen = compact && menuOpen;

  // Focus into the panel on open, back to the button on close. The panel sits
  // before the header in the DOM so the navigation reads first at full width,
  // which means a keyboard user would otherwise have to Shift+Tab backwards out
  // of the menu button to reach what they just opened.
  useEffect(() => {
    if (!panelOpen) return;

    panelRef.current?.focus();

    // Read now rather than in the cleanup: the button is the same node for the
    // whole time the panel is open, and the `isConnected` check below still
    // covers the case where leaving compact widths unmounted it.
    const button = menuButtonRef.current;

    return () => {
      if (button !== null && button.isConnected) button.focus();
    };
  }, [panelOpen]);

  // Escape closes the panel (requirement 15.6). On the document, so it works
  // wherever focus has drifted to.
  useEffect(() => {
    if (!panelOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [panelOpen]);

  /**
   * Navigating closes the panel. Delegated rather than wired into every entry,
   * because the entries belong to the `navigation` slot and the shell must not
   * need to know what is in it.
   */
  const closeOnNavigation = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!panelOpen) return;
    if (event.target instanceof Element && event.target.closest("a") !== null) {
      setMenuOpen(false);
    }
  };

  // At compact widths the header holds the menu button, so it renders even
  // without a top bar; at full width it renders only when there is something to
  // put in it, and never as an empty strip.
  const showHeader = compact || topbar !== undefined;

  return (
    <div className="app-shell">
      {/* First focusable element in the document, ahead of the navigation. */}
      <a className="app-shell__skip-link" href={`#${MAIN_CONTENT_ID}`}>
        Skip to main content
      </a>

      {/* Presentational: the panel closes from the menu button and from Escape
          as well, so the scrim needs no role and no place in the accessibility
          tree. Rendered only while the panel is open. */}
      {panelOpen ? (
        <div className="app-shell__scrim" aria-hidden="true" onClick={closeMenu} />
      ) : null}

      <div
        className="app-shell__panel"
        id={panelId}
        ref={panelRef}
        // Focusable on open without joining the tab order, where it would sit
        // between the navigation's own entries.
        tabIndex={panelOpen ? -1 : undefined}
        // `hidden`, not a CSS class: a closed panel holds no focusable entries
        // and is absent from the accessibility tree, rather than being off-screen
        // and still reachable by Tab.
        hidden={compact && !menuOpen}
        onClick={closeOnNavigation}
      >
        {/* Requirement 14.3 — below `--bp-md` the event switcher is part of the
            panel. One switcher, one place in the DOM.

            Above the navigation, not below it: "which workspace and which event
            am I acting for" reads before "where can I go", the same order the
            header and the content column have at full width. It also gives the
            switcher's own menu the height of the panel to open into, rather than
            the few pixels left under a group pinned to the bottom edge. */}
        {compact && topbar !== undefined ? (
          <div className="app-shell__panel-context">{topbar}</div>
        ) : null}

        <nav className="app-shell__nav" aria-label={navigationLabel}>
          {navigation}
        </nav>
      </div>

      <div className="app-shell__body">
        {showHeader ? (
          <header className="app-shell__header">
            <div className="app-shell__header-inner">
              {compact ? (
                <button
                  type="button"
                  className="btn app-shell__menu"
                  ref={menuButtonRef}
                  aria-expanded={menuOpen}
                  aria-controls={panelId}
                  onClick={() => {
                    setMenuOpen((open) => !open);
                  }}
                >
                  {NAV_MENU_LABEL}
                </button>
              ) : (
                topbar
              )}
            </div>
          </header>
        ) : null}

        {/* `tabIndex={-1}` is what lets the skip link actually move focus here
            rather than only scrolling the page. */}
        <main className="app-shell__main" id={MAIN_CONTENT_ID} tabIndex={-1}>
          <div className="app-shell__content">{children}</div>
        </main>
      </div>
    </div>
  );
}
