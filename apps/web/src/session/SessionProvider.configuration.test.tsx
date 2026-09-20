import { render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../auth", () => ({
  isAuthConfigured: false,
  isSignedIn: () => Promise.resolve(false),
  getSignedInUser: () => Promise.resolve(null),
  signOut: () => undefined,
}));
vi.mock("../api", () => ({
  isMockMode: false,
  getOrganizationContext: () => Promise.resolve({ organizationId: "", selectable: [], source: "fallback" }),
}));

import { Login } from "../pages/Login";
import { RedirectWhenAuthenticated, RequireSession } from "./routeGuards";
import { SessionProvider } from "./SessionProvider";

function Harness() {
  return (
    <MemoryRouter initialEntries={["/protected"]}>
      <SessionProvider>
        <Routes>
          <Route path="/login" element={<RedirectWhenAuthenticated pending={<p>pending</p>}><Login onSignedIn={() => undefined} /></RedirectWhenAuthenticated>} />
          <Route element={<RequireSession skeleton={<p>skeleton</p>}><Outlet /></RequireSession>}>
            <Route path="/protected" element={<p>protected data</p>} />
          </Route>
        </Routes>
      </SessionProvider>
    </MemoryRouter>
  );
}

describe("missing Cognito configuration", () => {
  it("fails closed on a stable configuration message without mounting protected data", async () => {
    render(<Harness />);
    expect(await screen.findByRole("heading", { name: "Sign-in unavailable" })).toBeInTheDocument();
    expect(screen.getByText(/authentication is not configured/i)).toBeInTheDocument();
    expect(screen.queryByText("protected data")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
