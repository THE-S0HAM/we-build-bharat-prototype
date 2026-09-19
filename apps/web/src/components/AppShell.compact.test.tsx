/**
 * The shell at compact widths — requirement 14.3, as far as jsdom allows
 * (design.md §21.3 "Responsive nav").
 *
 * Below `--bp-md` the navigation *is* a menu button: the panel it opens holds
 * both the navigation entries and the event switcher, and while it is closed
 * neither is in the document. That is the one piece of the responsive design
 * that is not CSS — the switcher changes place in the DOM rather than changing
 * appearance — so it is the one piece a jsdom test can and must cover.
 *
 * jsdom implements no `window.matchMedia`, so `useMediaQuery` reports no match
 * and every other suite renders the widest layout. `setMatchingMediaQueries`
 * from the test setup is the opt-in that makes this width reachable: it names
 * the query through `BELOW_BP_MD`, the same constant `AppShell` asks with, and
 * the setup empties the set after every test.
 *
 * The event switcher is a stand-in button here, not the real `EventSwitcher`.
 * What requirement 14.3 asks of the shell is *where the `topbar` slot renders*,
 * and a slot's contents are the caller's business — `Topbar.test.tsx` covers
 * what actually goes in it.
 *
 * **Validates: Requirements 14.3, 15.1, 15.6**
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { BELOW_BP_MD } from "../lib/useMediaQuery";
import { setMatchingMediaQueries } from "../test/setup";
import { AppShell, NAV_MENU_LABEL } from "./AppShell";

/** Accessible name of the stand-in for the event switcher. */
const SWITCHER = "DevCon Bengaluru 2026";

/** A navigation entry, as the `Sidebar` renders one: a link with a label. */
const NAV_ENTRY = "Speakers";

function renderShell() {
  return render(
    <AppShell
      navigation={<a href="#speakers">{NAV_ENTRY}</a>}
      topbar={<button type="button">{SWITCHER}</button>}
    >
      <p>page content</p>
    </AppShell>,
  );
}

/** The shell at a width below `--bp-md`, with the menu still closed. */
function renderCompactShell() {
  setMatchingMediaQueries(BELOW_BP_MD);

  return renderShell();
}

function menuButton(): HTMLElement {
  return screen.getByRole("button", { name: NAV_MENU_LABEL });
}

/**
 * The panel the menu button opens, read through its own `aria-controls`.
 *
 * That attribute is the contract the button publishes to assistive technology,
 * so following it is both the accessible route to the panel and a check that the
 * pointer leads somewhere real.
 */
function panel(): HTMLElement {
  const controls = menuButton().getAttribute("aria-controls");

  if (controls === null) {
    throw new Error("The menu button publishes no aria-controls.");
  }

  const target = document.getElementById(controls);

  if (target === null) {
    throw new Error(`aria-controls="${controls}" points at nothing in the document.`);
  }

  return target;
}

describe("at or above --bp-md", () => {
  it("renders the navigation itself, with no menu button", () => {
    renderShell();

    expect(screen.queryByRole("button", { name: NAV_MENU_LABEL })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: NAV_ENTRY })).toBeInTheDocument();
  });

  it("renders the event switcher in the header", () => {
    renderShell();

    expect(screen.getByRole("banner")).toContainElement(
      screen.getByRole("button", { name: SWITCHER }),
    );
  });
});

describe("below --bp-md (requirement 14.3)", () => {
  it("replaces the navigation with a menu button that says what it controls", () => {
    renderCompactShell();

    const button = menuButton();

    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(panel()).toHaveAttribute("hidden");
  });

  it("holds the navigation and the event switcher out of the document while closed", () => {
    renderCompactShell();

    // Neither is reachable: a closed menu leaves nothing behind it to find, to
    // focus, or to announce.
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: NAV_ENTRY })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: SWITCHER })).not.toBeInTheDocument();
  });

  it("reveals the navigation and the switcher on open, and moves focus into the panel", async () => {
    const user = userEvent.setup();
    renderCompactShell();

    await user.click(menuButton());

    expect(menuButton()).toHaveAttribute("aria-expanded", "true");

    const opened = panel();
    expect(opened).not.toHaveAttribute("hidden");
    expect(opened).toHaveFocus();

    // One navigation landmark, and it is inside the panel (requirement 15.1).
    const navigation = screen.getByRole("navigation", { name: "Main navigation" });
    expect(opened).toContainElement(navigation);
    expect(within(navigation).getByRole("link", { name: NAV_ENTRY })).toBeInTheDocument();
  });

  it("puts the event switcher in the panel and not in the header", async () => {
    const user = userEvent.setup();
    renderCompactShell();

    await user.click(menuButton());

    // One switcher, in one place: the panel at this width, never both.
    const switcher = screen.getByRole("button", { name: SWITCHER });
    expect(panel()).toContainElement(switcher);
    expect(screen.getByRole("banner")).not.toContainElement(switcher);
  });

  it("closes on Escape and returns focus to the menu button (requirement 15.6)", async () => {
    const user = userEvent.setup();
    renderCompactShell();

    await user.click(menuButton());
    await user.keyboard("{Escape}");

    expect(menuButton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(menuButton()).toHaveFocus();
  });

  it("closes when a navigation entry is activated", async () => {
    const user = userEvent.setup();
    renderCompactShell();

    await user.click(menuButton());
    await user.click(screen.getByRole("link", { name: NAV_ENTRY }));

    expect(menuButton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: NAV_ENTRY })).not.toBeInTheDocument();
  });

  it("closes and hands the switcher back to the header when the viewport widens", async () => {
    const user = userEvent.setup();
    renderCompactShell();

    await user.click(menuButton());
    expect(screen.getByRole("navigation")).toBeInTheDocument();

    // The window a user turns sideways: the same document, a different width.
    setMatchingMediaQueries();

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: NAV_MENU_LABEL })).not.toBeInTheDocument();
    });

    // The navigation is the navigation again, and the switcher is back in the
    // header rather than left in a panel nobody can see.
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    expect(screen.getByRole("banner")).toContainElement(
      screen.getByRole("button", { name: SWITCHER }),
    );
  });
});
