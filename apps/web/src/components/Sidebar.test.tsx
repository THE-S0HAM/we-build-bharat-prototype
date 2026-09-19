/**
 * Behaviour checks for the navigation contents: the order and grouping
 * requirement 3.2 fixes, the active treatment (3.3), the pending-approval badge
 * (3.4), capability omission (3.5) and the account block (3.6).
 *
 * `NavLink` needs a router, so every render is wrapped in `MemoryRouter`; the
 * entry path is what makes one entry active.
 */

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import type { SidebarProps } from "./Sidebar";

const account = {
  name: "Asha Menon",
  email: "asha.menon@example.org",
  organizationId: "ORG-example",
};

function renderSidebar(props: SidebarProps = {}, path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar {...props} />
    </MemoryRouter>,
  );
}

describe("Sidebar", () => {
  it("renders the entries in order, grouped, and no nav landmark of its own", () => {
    renderSidebar();

    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Command Center",
      "SpeakerOps",
      "TeamOps",
      "IncidentOps",
      "Check-In",
      "Approvals",
      "Audit Log",
    ]);

    const operations = screen.getByRole("list", { name: "OPERATIONS" });
    expect(within(operations).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "SpeakerOps",
      "TeamOps",
      "IncidentOps",
    ]);
    expect(
      within(screen.getByRole("list", { name: "EVENT DAY" })).getAllByRole("link"),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole("list", { name: "GOVERNANCE" })).getAllByRole("link"),
    ).toHaveLength(2);

    // The shell owns the single navigation landmark (requirement 15.1).
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByText("CommunityOps")).toBeInTheDocument();
  });

  it("omits a capability-gated entry from the DOM while its flag is off", () => {
    renderSidebar();

    expect(screen.queryByRole("link", { name: "AttendeeOps" })).not.toBeInTheDocument();
  });

  it("renders a capability-gated entry in its declared position once the flag is on", () => {
    renderSidebar({ capabilities: { attendeeOps: true } });

    const operations = screen.getByRole("list", { name: "OPERATIONS" });
    expect(within(operations).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "SpeakerOps",
      "TeamOps",
      "AttendeeOps",
      "IncidentOps",
    ]);
    expect(screen.getByRole("link", { name: "AttendeeOps" })).toHaveAttribute(
      "href",
      "/attendees",
    );
  });

  it("disables the event-scoped entries, and only those, when there is no event", () => {
    renderSidebar({ eventScopedDisabled: true });

    // Disabled, not omitted: the area exists and works the moment an event does,
    // which is the difference from the capability gate above (requirement 3.10).
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Command Center",
    ]);

    const speakers = screen.getByText("SpeakerOps").closest("[aria-disabled]");
    expect(speakers).toHaveAttribute("aria-disabled", "true");

    // The reason is text beside the label, never colour alone (requirement 15.10).
    expect(screen.getAllByText("Needs an event")).toHaveLength(6);
  });

  it("renders no badge on a disabled entry, because a count needs an event", () => {
    renderSidebar({ eventScopedDisabled: true, pendingApprovals: 3 });

    expect(screen.queryByText("3")).not.toBeInTheDocument();
    expect(screen.queryByText(/pending approvals/)).not.toBeInTheDocument();
  });

  it("marks only the active route with aria-current and the active treatment", () => {
    renderSidebar({}, "/approvals");

    const active = screen.getByRole("link", { name: "Approvals" });
    expect(active).toHaveAttribute("aria-current", "page");
    // Weight and a left rule accompany the colour change (requirement 15.10).
    expect(active.className).toContain("side-nav__link--active");

    const inactive = screen.getByRole("link", { name: "Audit Log" });
    expect(inactive).not.toHaveAttribute("aria-current");
    expect(inactive.className).not.toContain("side-nav__link--active");
  });

  it("keeps Command Center inactive on another route", () => {
    renderSidebar({}, "/speakers");

    expect(screen.getByRole("link", { name: "Command Center" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByRole("link", { name: "SpeakerOps" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("renders the pending-approval count as a badge when it is above zero", () => {
    renderSidebar({ pendingApprovals: 3 });

    const approvals = screen.getByRole("link", { name: /Approvals/ });
    expect(approvals).toHaveTextContent("3");
    // The number alone would announce as "Approvals 3".
    expect(approvals).toHaveAccessibleName(/3 pending approvals/);
  });

  it("renders no badge when nothing is pending", () => {
    renderSidebar({ pendingApprovals: 0 });

    expect(screen.queryByText(/pending approvals/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Approvals" })).toHaveTextContent("Approvals");
  });

  it("renders name, email and organization in the account block, and nothing else", () => {
    renderSidebar({ account });

    const block = screen.getByText(account.name).parentElement;
    expect(block).not.toBeNull();
    // Exactly three lines: a fourth would be an identity attribute no token or
    // API carries, such as a role label (requirement 3.6, A2).
    expect(block?.children).toHaveLength(3);
    expect(block?.textContent).toBe(
      `${account.name}${account.email}${account.organizationId}`,
    );
  });

  it("omits the account block when no identity is supplied", () => {
    renderSidebar();

    expect(screen.queryByText(account.email)).not.toBeInTheDocument();
  });
});
