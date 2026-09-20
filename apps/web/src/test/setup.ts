/**
 * Vitest setup for the component test environment.
 *
 * Runs before every test file (see `test.setupFiles` in `vite.config.ts`):
 *   - registers the jest-dom matchers on Vitest's `expect`
 *   - installs a controllable `window.matchMedia`, which jsdom does not provide
 *   - unmounts anything rendered by Testing Library after each test, so one
 *     test never sees another test's DOM
 *
 * Tests that only exercise plain modules (for example `src/api.test.ts`) are
 * unaffected: `cleanup` is a no-op when nothing has been rendered.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/* -------------------------------------------------------------------------- */
/* Media queries                                                              */
/* -------------------------------------------------------------------------- */

/**
 * jsdom implements no `window.matchMedia` at all, so `useMediaQuery` reports no
 * match and every test renders the console's widest layout. That default is
 * right — the design is desktop-first — but it leaves the compact-width
 * behaviour of `AppShell` (requirement 14.3) unreachable, because at that width
 * the event switcher moves to a different place in the DOM and only JavaScript
 * decides where it goes.
 *
 * The stub below closes that gap without changing the default. It reports no
 * match until a test says otherwise through `setMatchingMediaQueries`, and the
 * set is emptied after every test, so a suite that never mentions a media query
 * behaves exactly as it did before this existed.
 *
 * A match is decided by **exact query string**, not by evaluating the query
 * against a viewport size: there is no viewport in jsdom to evaluate against.
 * That is why a test names the query through the same exported constant the
 * component uses (`BELOW_BP_MD`) rather than spelling one out — the test and the
 * component then cannot disagree about which width is being asked for.
 */
const matchingQueries = new Set<string>();

/** Every list handed out to the component under test, so a change reaches it. */
const issuedLists = new Set<StubMediaQueryList>();

/**
 * A `MediaQueryList` whose `matches` is read from `matchingQueries`.
 *
 * Built on `EventTarget` so `addEventListener("change", …)` — the subscription
 * `useMediaQuery` actually makes — is the real platform implementation rather
 * than a hand-rolled callback list. The deprecated `addListener` pair delegates
 * to it, so the stub is a complete `MediaQueryList` and not a partial one a
 * future caller could fall off.
 */
class StubMediaQueryList extends EventTarget implements MediaQueryList {
  matches: boolean;

  onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null = null;

  constructor(readonly media: string) {
    super();
    this.matches = matchingQueries.has(media);
  }

  addListener(listener: ((event: MediaQueryListEvent) => void) | null): void {
    if (listener === null) return;
    this.addEventListener("change", listener as EventListener);
  }

  removeListener(listener: ((event: MediaQueryListEvent) => void) | null): void {
    if (listener === null) return;
    this.removeEventListener("change", listener as EventListener);
  }

  /** Announce a new `matches` value the way a browser does. */
  announce(): void {
    const event: MediaQueryListEvent = Object.assign(new Event("change"), {
      matches: this.matches,
      media: this.media,
    });

    this.onchange?.call(this, event);
    this.dispatchEvent(event);
  }
}

window.matchMedia = (query: string): MediaQueryList => {
  const list = new StubMediaQueryList(query);
  issuedLists.add(list);

  return list;
};

/**
 * Make exactly `queries` the media queries that report a match, and tell
 * anything already subscribed that the viewport changed.
 *
 * Call it before `render` to have a component mount at that width, or during a
 * test to move between widths — the second is how a resize is simulated, since
 * there is no viewport to resize.
 *
 * Called with no arguments it restores the default: nothing matches, which is
 * the console's widest layout.
 *
 * @example
 * setMatchingMediaQueries(BELOW_BP_MD);
 * render(<AppShell … />);
 */
export function setMatchingMediaQueries(...queries: readonly string[]): void {
  matchingQueries.clear();

  for (const query of queries) {
    matchingQueries.add(query);
  }

  for (const list of issuedLists) {
    const matches = matchingQueries.has(list.media);
    if (matches === list.matches) continue;

    list.matches = matches;
    list.announce();
  }
}

/* -------------------------------------------------------------------------- */
/* Per-test reset                                                             */
/* -------------------------------------------------------------------------- */

afterEach(() => {
  cleanup();

  // After `cleanup`, so nothing is subscribed when the matching set empties and
  // no component is re-rendered on the way out of a test.
  matchingQueries.clear();
  issuedLists.clear();
});
