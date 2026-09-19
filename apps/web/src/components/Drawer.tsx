import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./Drawer.css";

/**
 * Test hook on the scrim. The scrim has no role and no accessible name, so a
 * behaviour test that closes the drawer by clicking the backdrop (Property 9)
 * has nothing else to query it by.
 */
export const DRAWER_SCRIM_TEST_ID = "drawer-scrim";

/**
 * Candidates for the focus trap. Everything the platform puts in the tab order
 * by default, plus anything given an explicit `tabindex`. The list is filtered
 * further in `focusableWithin` — the selector alone cannot tell a
 * `tabindex="-1"` element from a focusable one.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "audio[controls]",
  "video[controls]",
  "iframe",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]",
].join(",");

/**
 * The tabbable elements inside `root`, in document order.
 *
 * `tabIndex >= 0` is what excludes the panel's own `tabindex="-1"` descendants
 * and keeps the list to elements a Tab press should actually reach. Visibility
 * is judged from `hidden` and `aria-hidden` rather than from layout, because
 * layout-based checks (`offsetParent`, `getClientRects`) report nothing in a
 * headless DOM and would silently empty the list under test.
 */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute("disabled") &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.closest("[hidden]") === null,
  );
}

/**
 * Number of drawers currently holding the body scroll lock, and the inline
 * `overflow` value found on `<body>` before the first of them took it.
 *
 * The count exists so a second layer opening and closing over a first one
 * cannot release a lock the first one still needs. Module scope is correct here:
 * there is one `<body>` per document, so the lock is a document-wide fact rather
 * than component state.
 */
let scrollLockDepth = 0;
let bodyOverflowBeforeLock = "";

/**
 * Prevents the page behind the drawer from scrolling and returns the release
 * function.
 *
 * `overflow: hidden` on `<body>` is deliberate: it freezes the page without
 * moving it, so the scroll position is exactly where the user left it when the
 * lock is released. The `position: fixed` variant of this technique scrolls the
 * page to the top on release, which is the "broken scroll position" this avoids.
 *
 * The returned function is idempotent, so a double release cannot drive the
 * count negative.
 */
function lockBodyScroll(): () => void {
  if (scrollLockDepth === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLockDepth += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollLockDepth -= 1;
    if (scrollLockDepth > 0) return;

    document.body.style.overflow = bodyOverflowBeforeLock;
    // Restoring an empty value leaves an empty `style=""` behind. Removing it
    // leaves the document exactly as the drawer found it.
    if (document.body.getAttribute("style") === "") {
      document.body.removeAttribute("style");
    }
  };
}

export interface DrawerProps {
  /**
   * Whether the drawer is open. While false nothing renders, so closed content
   * holds no focusable elements and no stale DOM.
   */
  open: boolean;

  /**
   * Called when the user dismisses the drawer — Escape, the Close control, or
   * the scrim. The drawer never closes itself: the owner flips `open`, which is
   * what keeps one drawer's state in one place.
   */
  onClose: () => void;

  /**
   * The drawer's heading. Rendered as the panel's `<h2>` and referenced by
   * `aria-labelledby`, so the dialog is named by what the user can see
   * (requirement 15.5).
   */
  title: string;

  /**
   * Optional one-line context under the heading, announced as the dialog's
   * description. Content, not a subtitle style: keep it to a sentence.
   */
  description?: string;

  /** Panel content. Any headings inside start at `<h3>`, under the title. */
  children: ReactNode;

  /**
   * Optional action row, pinned below the scrolling body. Omit it and no footer
   * renders, so a read-only drawer shows no empty action bar.
   */
  footer?: ReactNode;
}

/**
 * The one progressive-disclosure surface in the product (requirement 12.6,
 * design.md §7 and §7.1). Every "view details" interaction opens this; no page
 * builds a panel of its own, which is what makes the behaviour identical on
 * every route.
 *
 * Behaviour it owns (requirements 15.5, 15.6, design.md §Accessibility):
 *   - `role="dialog"` with `aria-modal`, labelled by its own heading
 *   - focus moves into the panel on open
 *   - focus is trapped while open: Tab and Shift+Tab cycle inside the panel and
 *     never reach the page behind it
 *   - focus returns to the element that opened it on close, by any means —
 *     Escape, Close, or the scrim (Property 9)
 *   - Escape closes
 *   - the page behind it cannot scroll while it is open
 *
 * It renders through a portal on `<body>` so no page container can clip it and
 * no ancestor's `z-index` can order it below the page. The scrim sits at
 * `--z-overlay` and the panel at `--z-drawer`.
 */
export function Drawer({ open, onClose, title, description, children, footer }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const headingId = useId();
  const descriptionId = useId();

  // The document listener below is registered once per open, so it reads the
  // callback through a ref. An inline `onClose` arrow from the caller therefore
  // costs nothing, and — more importantly — cannot re-run the focus effects.
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Focus lifecycle. Keyed on `open` alone so the cleanup runs exactly once per
  // open/close cycle: on close, and on unmount while still open.
  useEffect(() => {
    if (!open) return;

    const activeOnOpen = document.activeElement;
    triggerRef.current = activeOnOpen instanceof HTMLElement ? activeOnOpen : null;

    // The panel itself, not its first control: a screen reader then announces
    // the dialog and its heading before the user starts moving through content.
    panelRef.current?.focus();

    return () => {
      const trigger = triggerRef.current;
      triggerRef.current = null;
      // A trigger that has been removed from the document — a table row that no
      // longer exists, say — cannot take focus back. Leaving focus where it is
      // beats throwing it somewhere arbitrary.
      if (trigger && trigger.isConnected) {
        trigger.focus();
      }
    };
  }, [open]);

  // Scroll lock, released on close and on unmount while open.
  useEffect(() => {
    if (!open) return;
    return lockBodyScroll();
  }, [open]);

  // Escape to close, and the focus trap.
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Requirement 15.6. Registered on the document, so Escape closes the
        // drawer even if focus has drifted outside the panel.
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;

      // Tab is taken over completely while open, rather than intercepted only
      // at the two ends of the list. Cycling is then identical wherever focus
      // currently sits, including on the panel itself and — after a stray focus
      // change — outside it.
      event.preventDefault();

      const focusables = focusableWithin(panel);
      const first = focusables[0];
      const last = focusables.at(-1);
      if (first === undefined || last === undefined) {
        // Nothing focusable inside: focus stays on the panel rather than
        // escaping to the page behind it.
        panel.focus();
        return;
      }

      const active = document.activeElement;
      const index = active instanceof HTMLElement ? focusables.indexOf(active) : -1;

      if (event.shiftKey) {
        const previous = index <= 0 ? last : focusables[index - 1];
        (previous ?? last).focus();
        return;
      }

      const next = index === -1 || index >= focusables.length - 1 ? first : focusables[index + 1];
      (next ?? first).focus();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!open) return null;

  const dismiss = () => {
    onClose();
  };

  return createPortal(
    <>
      {/* Presentational: the same dismissal is available from the Close control
          and from Escape, so the scrim needs no role and no place in the
          accessibility tree. */}
      <div
        className="drawer__scrim"
        data-testid={DRAWER_SCRIM_TEST_ID}
        aria-hidden="true"
        onClick={dismiss}
      />

      <div
        className="drawer__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        // Makes the panel a focus target on open without putting it in the tab
        // order, where it would sit between the content's own controls.
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="drawer__header">
          <div className="drawer__heading">
            <h2 className="drawer__title" id={headingId}>
              {title}
            </h2>
            {description === undefined ? null : (
              <p className="drawer__description" id={descriptionId}>
                {description}
              </p>
            )}
          </div>

          {/* The product's shared button set, so the drawer's control is the
              same control as everywhere else. Labelled with text rather than a
              glyph: this is also the explicit Close the full-screen sheet needs
              below `--bp-sm` (requirement 14.4). */}
          <button type="button" className="btn btn-sm drawer__close" onClick={dismiss}>
            Close
          </button>
        </div>

        <div className="drawer__body">{children}</div>

        {footer === undefined ? null : <div className="drawer__footer">{footer}</div>}
      </div>
    </>,
    document.body,
  );
}
