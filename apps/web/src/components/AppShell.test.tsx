/**
 * Structural sanity checks for the shared page frame. These cover the
 * landmark and skip-link guarantees the shell exists to hold
 * (requirements 12.4, 15.1); broader shared-component behaviour is covered
 * elsewhere.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppShell, MAIN_CONTENT_ID } from "./AppShell";

describe("AppShell", () => {
  it("renders exactly one main, one nav landmark and one banner", () => {
    render(
      <AppShell navigation={<p>nav slot</p>} topbar={<p>topbar slot</p>}>
        <p>page content</p>
      </AppShell>,
    );

    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getByRole("navigation")).toHaveAccessibleName("Main navigation");
  });

  it("renders the skip link as the first focusable element, targeting main", () => {
    render(
      <AppShell navigation={<a href="/somewhere">A nav link</a>}>
        <p>page content</p>
      </AppShell>,
    );

    const focusable = screen.getAllByRole("link");
    const skipLink = screen.getByRole("link", { name: "Skip to main content" });

    expect(focusable[0]).toBe(skipLink);
    expect(skipLink).toHaveAttribute("href", `#${MAIN_CONTENT_ID}`);
    expect(screen.getByRole("main")).toHaveAttribute("id", MAIN_CONTENT_ID);
  });

  it("renders no header when no topbar is supplied", () => {
    render(
      <AppShell navigation={<p>nav slot</p>}>
        <p>page content</p>
      </AppShell>,
    );

    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });
});
