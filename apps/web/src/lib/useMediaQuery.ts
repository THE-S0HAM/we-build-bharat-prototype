/**
 * One place the layout asks the viewport a question (requirements 14.1–14.3).
 *
 * Almost all responsive behaviour in this console is CSS, and that is the rule:
 * a width that only changes how something looks belongs in a media query, not
 * in React. This hook exists for the one case CSS cannot express — a width that
 * changes *where an element lives in the DOM*.
 *
 * That case is the navigation panel. Below `--bp-md` the event switcher must sit
 * inside the menu panel rather than in the top bar (requirement 14.3). Rendering
 * it in both places and hiding one with CSS would put two switchers in the
 * document, so the one that is currently hidden could still be found, focused
 * and operated by anything that does not consult the cascade. One switcher, in
 * one place, is the only honest arrangement — and choosing that place needs the
 * viewport in JavaScript.
 *
 * ## Breakpoints are still tokens
 *
 * The queries below repeat the `--bp-*` numbers because neither a CSS media
 * query nor `matchMedia` can read a custom property. That is the same documented
 * exception every `@media` prelude in the product relies on, and `tokens.css`
 * remains the reference value (design.md §6.2).
 *
 * ## Absent `matchMedia`
 *
 * A DOM without `matchMedia` — jsdom, and any server-side render — reports no
 * match rather than throwing. The console then renders its widest layout, which
 * is the desktop-first default design.md §Responsive Behaviour starts from.
 */

import { useEffect, useState } from "react";

/**
 * `--bp-md` in pixels, the one number this module repeats from `tokens.css`.
 *
 * A number rather than a string, so the query below is composed from it the same
 * way a media query's `max-width` is derived — one less than the breakpoint —
 * and so the token value appears exactly once.
 */
const BP_MD = 900;

/**
 * Below `--bp-md` (900px): the navigation is a menu button opening a full-height
 * panel, and that panel holds the event switcher (requirement 14.3).
 */
export const BELOW_BP_MD = `(max-width: ${BP_MD - 1}px)`;

/** The query list for `query`, or `null` where the DOM has no `matchMedia`. */
function queryList(query: string): MediaQueryList | null {
  if (typeof window === "undefined") return null;
  if (typeof window.matchMedia !== "function") return null;

  return window.matchMedia(query);
}

/**
 * Whether `query` currently matches, kept in step with the viewport.
 *
 * The initial value is read during the first render rather than in an effect, so
 * a narrow viewport renders its own layout immediately instead of mounting the
 * wide one and then correcting it.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => queryList(query)?.matches ?? false);

  useEffect(() => {
    const list = queryList(query);
    if (list === null) return;

    // Re-read on subscribe: the viewport can change between the first render and
    // this effect, and that change would otherwise be missed.
    setMatches(list.matches);

    const onChange = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };

    list.addEventListener("change", onChange);

    return () => {
      list.removeEventListener("change", onChange);
    };
  }, [query]);

  return matches;
}
