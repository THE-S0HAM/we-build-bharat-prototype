/**
 * Property 9 — a drawer opened from a trigger returns focus to that trigger when
 * it closes, by any means (requirements 15.5, 15.6; design.md §7.1).
 *
 * Two things shape this suite:
 *
 *   - The behaviour lives in the *transition*. The trigger is read from
 *     `document.activeElement` when the drawer opens and focused again when it
 *     closes, so the tests drive a host component that owns `open` and click a
 *     real trigger. Re-rendering `Drawer` with a different `open` value from the
 *     test body would skip the part that matters.
 *   - The focus trap works by preventing the default action of a Tab keydown, so
 *     only a keystroke produced the way a browser produces it proves anything.
 *     Interaction therefore goes through `@testing-library/user-event`, never
 *     through a hand-built event.
 *
 * The drawer is also the surface requirement 15.6 names for Escape, and the one
 * that holds the body scroll lock, so both are covered here.
 */

import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { DRAWER_SCRIM_TEST_ID, Drawer } from "./Drawer";

/** Accessible name of the control that opens the drawer. */
const TRIGGER = "View registration";

/** Accessible name of a control that stays on the page behind the drawer. */
const PAGE_BEHIND = "Sign out";

const TITLE = "Registration REG-4821";
const DESCRIPTION = "Waitlisted since Tuesday, payment not captured.";

type User = ReturnType<typeof userEvent.setup>;

/**
 * A page with a drawer on it: a trigger, a control that remains behind the
 * drawer, and four focusable elements inside the panel — the Close control in
 * the header, two in the body, one in the footer. Four is the smallest number
 * that distinguishes "cycles" from "bounces between the ends".
 */
function DrawerPage() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {TRIGGER}
      </button>
      <button type="button">{PAGE_BEHIND}</button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={TITLE}
        description={DESCRIPTION}
        footer={<button type="button">Confirm refund</button>}
      >
        <button type="button">Resend ticket</button>
        <label htmlFor="drawer-note">Note</label>
        <input id="drawer-note" />
      </Drawer>
    </>
  );
}

/**
 * The same page, where an action inside the drawer removes the record the drawer
 * was opened from — so the trigger is gone from the document by the time the
 * drawer closes. This is the case that must not throw.
 */
function VanishingTriggerPage() {
  const [open, setOpen] = useState(false);
  const [recordPresent, setRecordPresent] = useState(true);

  return (
    <>
      {recordPresent ? (
        <button type="button" onClick={() => setOpen(true)}>
          {TRIGGER}
        </button>
      ) : null}
      <button type="button">{PAGE_BEHIND}</button>

      <Drawer open={open} onClose={() => setOpen(false)} title={TITLE}>
        <button type="button" onClick={() => setRecordPresent(false)}>
          Cancel this registration
        </button>
      </Drawer>
    </>
  );
}

/** Opens the drawer the way a user does, and hands back both ends of Property 9. */
async function openFromTrigger(user: User) {
  const trigger = screen.getByRole("button", { name: TRIGGER });
  await user.click(trigger);

  return { trigger, dialog: screen.getByRole("dialog") };
}

/** The panel's focusable elements, in the order a Tab press should reach them. */
function panelTabOrder(): HTMLElement[] {
  return [
    screen.getByRole("button", { name: "Close" }),
    screen.getByRole("button", { name: "Resend ticket" }),
    screen.getByRole("textbox", { name: "Note" }),
    screen.getByRole("button", { name: "Confirm refund" }),
  ];
}

describe("Drawer", () => {
  it("renders nothing while closed, so its controls are not in the tab order", () => {
    render(<DrawerPage />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Note" })).not.toBeInTheDocument();
  });

  it("exposes a modal dialog named by its own heading", async () => {
    const user = userEvent.setup();
    render(<DrawerPage />);

    await openFromTrigger(user);

    const dialog = screen.getByRole("dialog", { name: TITLE });

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(DESCRIPTION);
    // The name is the heading the user can see, not a separate string.
    expect(screen.getByRole("heading", { level: 2, name: TITLE })).toBeInTheDocument();
  });

  it("moves focus into the panel on open", async () => {
    const user = userEvent.setup();
    render(<DrawerPage />);

    const { trigger, dialog } = await openFromTrigger(user);

    expect(dialog).toHaveFocus();
    expect(trigger).not.toHaveFocus();
  });

  it("cycles Tab inside the panel and never reaches the page behind it", async () => {
    const user = userEvent.setup();
    render(<DrawerPage />);

    const { trigger, dialog } = await openFromTrigger(user);
    const pageBehind = screen.getByRole("button", { name: PAGE_BEHIND });
    const tabOrder = panelTabOrder();

    // Twice round, so wrapping from the last control back to the first is
    // exercised rather than assumed.
    for (const expected of [...tabOrder, ...tabOrder]) {
      await user.tab();

      expect(expected).toHaveFocus();
      expect(pageBehind).not.toHaveFocus();
      expect(trigger).not.toHaveFocus();
    }

    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("cycles Shift+Tab inside the panel and never reaches the page behind it", async () => {
    const user = userEvent.setup();
    render(<DrawerPage />);

    const { trigger, dialog } = await openFromTrigger(user);
    const pageBehind = screen.getByRole("button", { name: PAGE_BEHIND });
    const backwards = [...panelTabOrder()].reverse();

    for (const expected of [...backwards, ...backwards]) {
      await user.tab({ shift: true });

      expect(expected).toHaveFocus();
      expect(pageBehind).not.toHaveFocus();
      expect(trigger).not.toHaveFocus();
    }

    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<DrawerPage />);

    const { trigger } = await openFromTrigger(user);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("returns focus to the trigger when the Close control closes it", async () => {
    const user = userEvent.setup();
    render(<DrawerPage />);

    const { trigger } = await openFromTrigger(user);
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("returns focus to the trigger when the scrim closes it", async () => {
    const user = userEvent.setup();
    render(<DrawerPage />);

    const { trigger } = await openFromTrigger(user);
    // The scrim carries no role and no accessible name by design, so the test
    // hook the component exports is the only handle on it.
    await user.click(screen.getByTestId(DRAWER_SCRIM_TEST_ID));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("locks page scroll while open and releases it on close", async () => {
    const user = userEvent.setup();
    render(<DrawerPage />);

    expect(document.body).not.toHaveAttribute("style");

    await openFromTrigger(user);

    expect(document.body).toHaveStyle({ overflow: "hidden" });

    await user.keyboard("{Escape}");

    // Released, and the document is left exactly as the drawer found it.
    expect(document.body).not.toHaveAttribute("style");
  });

  it("releases the page scroll lock when it unmounts while still open", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DrawerPage />);

    await openFromTrigger(user);

    expect(document.body).toHaveStyle({ overflow: "hidden" });

    // A route change with a drawer open must not leave the page unscrollable.
    unmount();

    expect(document.body).not.toHaveAttribute("style");
  });

  it("leaves focus where it is when the trigger no longer exists", async () => {
    const user = userEvent.setup();
    render(<VanishingTriggerPage />);

    const trigger = screen.getByRole("button", { name: TRIGGER });
    await user.click(trigger);

    // The record is cancelled from inside the drawer, so the row that opened it
    // is gone before the drawer closes.
    await user.click(screen.getByRole("button", { name: "Cancel this registration" }));

    expect(trigger).not.toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Focus stays put instead of being thrown at whatever else is on the page.
    expect(screen.getByRole("button", { name: PAGE_BEHIND })).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });
});
