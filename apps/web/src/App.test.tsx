/**
 * Checks on the composed console: capability gating (requirement 11.1) and the
 * agreement between the navigation list and the route table.
 *
 * `/attendees` is chosen deliberately — it is the one capability-gated entry, and
 * because no route is registered for it the render mounts the shell and the
 * not-found view only, with no page and therefore no request.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";
import { CAPABILITIES } from "./capabilities";
import { visibleNavSections } from "./navConfig";
import { navigableViewPaths } from "./routes";

vi.mock("./auth", () => ({
  isAuthConfigured: true,
  isSignedIn: () => Promise.resolve(true),
  signOut: () => undefined,
  getIdToken: () => Promise.resolve(null),
  getSignedInEmail: () => null,
  getMemberOrganizations: () => Promise.resolve([]),
  signIn: () => Promise.resolve(),
  AuthError: class AuthError extends Error {},
}));

describe("capability gating", () => {
  it("resolves a capability-gated route to the not-found view while its flag is off", async () => {
    render(
      <MemoryRouter initialEntries={["/attendees"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByText("We couldn't find that page.")).toBeInTheDocument();

    // The not-found view renders inside the shell, so the navigation is the way
    // out — and the gated entry is absent from it (requirement 3.5).
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "AttendeeOps" })).not.toBeInTheDocument();
  });

  it("registers a route for every navigation entry the capabilities leave visible", () => {
    const navigated = visibleNavSections(CAPABILITIES)
      .flatMap((section) => section.items)
      .map((item) => item.path);

    // Equal lists, in order: a nav entry with no route would 404, and a route
    // with no nav entry would be unreachable.
    expect(navigableViewPaths(CAPABILITIES)).toEqual(navigated);
  });
});
