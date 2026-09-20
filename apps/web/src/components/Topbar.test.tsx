/**
 * Structural checks for the one global-context strip: the two composition slots
 * and sign-out (requirement 3.11), the single sign-out path (requirement 1.6),
 * and the `VITE_USE_MOCK` Demo Mode badge (requirement 13.9) staying distinct
 * from the "Demo workspace" chip (requirement 2.8).
 *
 * `isMockMode` is derived from `import.meta.env` when `api.ts` is first
 * imported, so the mock-mode tests stub the environment and re-import the
 * component — the same approach `api.test.ts` uses.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Topbar } from "./Topbar";

/** Re-import `Topbar` with `VITE_USE_MOCK` set to the given value. */
async function loadTopbar(useMock: string) {
  vi.resetModules();
  vi.stubEnv("VITE_USE_MOCK", useMock);
  return (await import("./Topbar")).Topbar;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Topbar", () => {
  it("renders the event switcher and demo-workspace slots alongside sign-out", () => {
    render(
      <Topbar
        eventSwitcher={<button type="button">DevCon Bengaluru 2026</button>}
        demoWorkspaceChip={<span>Demo workspace</span>}
        onSignOut={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "DevCon Bengaluru 2026" })).toBeInTheDocument();
    expect(screen.getByText("Demo workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("renders no banner landmark, because the shell owns the header", () => {
    render(<Topbar onSignOut={() => {}} />);

    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });

  it("invokes the supplied sign-out handler once per activation", async () => {
    const onSignOut = vi.fn();
    render(<Topbar onSignOut={onSignOut} />);

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("renders the Demo Mode badge while mock mode is active", async () => {
    const MockModeTopbar = await loadTopbar("true");
    render(<MockModeTopbar onSignOut={() => {}} />);

    const badge = screen.getByRole("status");

    expect(badge).toHaveTextContent("Demo Mode");
    expect(badge).toHaveAccessibleName(/simulated data, not live operational data/);
    // A mock-mode change is one of the three things requirement 15.8 names for a
    // polite live region, and this badge is that region. Stated rather than left
    // to the role's implicit value, exactly as the component states it.
    expect(badge).toHaveAttribute("aria-live", "polite");
  });

  it("renders no Demo Mode badge when mock mode is off", async () => {
    const LiveTopbar = await loadTopbar("");
    render(<LiveTopbar onSignOut={() => {}} />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/Demo Mode/)).not.toBeInTheDocument();
  });

  it("keeps the Demo Mode badge distinct from the demo-workspace chip", async () => {
    const MockModeTopbar = await loadTopbar("true");
    render(
      <MockModeTopbar demoWorkspaceChip={<span>Demo workspace</span>} onSignOut={() => {}} />,
    );

    const badge = screen.getByRole("status");
    const chip = screen.getByText("Demo workspace");

    expect(badge).not.toContainElement(chip);
    expect(chip).not.toContainElement(badge);
    expect(badge).toHaveTextContent("Demo Mode");
    expect(badge).not.toHaveTextContent("Demo workspace");
  });
});
