/**
 * IncidentOps behaviour (task 7.5 — requirements 8.1, 8.5, 8.6).
 *
 * Three claims the page makes, tested as behaviour rather than as markup:
 *
 *   1. **CRITICAL is first, resolved is out of the way** (8.1). Asserted from the
 *      rendered row order of the active table, with the fetched list deliberately
 *      in the wrong order.
 *   2. **The recommendation is reachable only through the drawer** (8.5). The
 *      recommendation text is absent from the page until "View details" is
 *      activated, and absent again once the drawer closes — so no row, card or
 *      headline can be previewing it.
 *   3. **The approval linkage is derived** (8.6). An approval is surfaced only
 *      when its `affected_resource_id` equals the incident id, and the copy says
 *      the match was derived rather than read from a stored reference.
 *
 * Only the network boundary is replaced. Ordering, the drawer, the derived match
 * and the mutation body are the real implementations.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { SessionContext } from "../session/sessionContext";
import type { Approval, Incident } from "../types";
import { buildIncidentUpdateBody } from "../incidentUpdate";
import { IncidentCenter } from "./IncidentCenter";
import { orderIncidents, readIncidentAnalysis, severityDistribution } from "./incidentModel";

const EVENT_ID = "EVT-devcon-2026";

const api = vi.hoisted(() => ({
  incidents: vi.fn(),
  approvals: vi.fn(),
  detail: vi.fn(),
  comment: vi.fn(),
  update: vi.fn(),
  resolve: vi.fn(),
  reopen: vi.fn(),
}));

vi.mock("../api", () => ({
  getIncidents: api.incidents,
  getApprovals: api.approvals,
  getIncident: api.detail,
  addIncidentComment: api.comment,
  resolveIncident: api.resolve,
  reopenIncident: api.reopen,
  updateIncident: api.update,
}));

function incident(overrides: Partial<Incident> & Pick<Incident, "incident_id">): Incident {
  return {
    event_id: EVENT_ID,
    title: `Incident ${overrides.incident_id}`,
    description: "Something happened that could disrupt the event.",
    severity: "MEDIUM",
    status: "RECOMMENDATION_READY",
    affected_resource_type: "Speaker",
    affected_resource_id: "SPK-006",
    recommendation: "",
    backup_options: [],
    detected_at: "2026-10-15T09:00:00Z",
    ...overrides,
  };
}

function approval(overrides: Partial<Approval> & Pick<Approval, "approval_id">): Approval {
  return {
    event_id: EVENT_ID,
    title: `Approval ${overrides.approval_id}`,
    description: "CommunityOps wants to act.",
    status: "PENDING",
    risk_level: "HIGH",
    requested_action: "RESOLVE_INCIDENT",
    reason: "Speaker cancellation",
    evidence: {},
    affected_resource_type: "Incident",
    affected_resource_id: "INC-001",
    agent_name: "IncidentOps",
    requested_at: "2026-10-15T09:05:00Z",
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SessionContext.Provider
        value={{
          status: "authenticated",
          user: {
            userId: "USR-leader",
            name: "Asha",
            email: "asha@example.org",
            role: "LEADER",
            organizations: ["ORG-test"],
            isDemo: false,
          },
          activeOrganizationId: "ORG-test",
          refresh: () => Promise.resolve(),
          signOut: () => undefined,
        }}
      >
        <IncidentCenter eventId={EVENT_ID} />
      </SessionContext.Provider>
    </MemoryRouter>,
  );
}

/** Row header text of the named table, in rendered order. */
function rowTitles(tableName: string): string[] {
  const rows = within(screen.getByRole("table", { name: tableName })).getAllByRole("rowheader");

  return rows.map((row) => row.textContent ?? "");
}

beforeEach(() => {
  api.incidents.mockReset();
  api.approvals.mockReset();
  api.detail.mockReset();
  api.comment.mockReset();
  api.update.mockReset();
  api.resolve.mockReset();
  api.reopen.mockReset();
  api.approvals.mockResolvedValue({ approvals: [], count: 0 });
  api.update.mockResolvedValue({ incident_id: "INC-001", message: "saved" });
  api.detail.mockRejectedValue(new Error("detail unavailable in legacy fixture"));
});

describe("severity ordering (requirement 8.1)", () => {
  it("renders CRITICAL first and collapses resolved incidents below the active ones", async () => {
    api.incidents.mockResolvedValue({
      incidents: [
        incident({ incident_id: "INC-low", severity: "LOW", title: "Badge printer offline" }),
        incident({
          incident_id: "INC-done",
          severity: "CRITICAL",
          title: "Power cut in hall B",
          status: "RESOLVED",
          resolved_at: "2026-10-15T10:00:00Z",
        }),
        incident({ incident_id: "INC-high", severity: "HIGH", title: "Catering delayed" }),
        incident({ incident_id: "INC-crit", severity: "CRITICAL", title: "Keynote cancelled" }),
        incident({ incident_id: "INC-med", severity: "MEDIUM", title: "Wi-Fi flaky" }),
      ],
      count: 5,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("table", { name: "Active incidents" })).toBeInTheDocument();
    });

    const titles = rowTitles("Active incidents");
    expect(titles[0]).toContain("Keynote cancelled");
    expect(titles[1]).toContain("Catering delayed");
    expect(titles[2]).toContain("Wi-Fi flaky");
    expect(titles[3]).toContain("Badge printer offline");

    // The resolved critical is not in the active table, and its table is not
    // rendered until the reader asks for it.
    expect(titles.join(" ")).not.toContain("Power cut in hall B");
    expect(screen.queryByRole("table", { name: "Resolved incidents" })).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: "Show 1 resolved" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);

    expect(rowTitles("Resolved incidents")[0]).toContain("Power cut in hall B");
    expect(screen.getByRole("button", { name: "Hide resolved" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("states every severity count in words beside the distribution strip", async () => {
    api.incidents.mockResolvedValue({
      incidents: [
        incident({ incident_id: "INC-1", severity: "CRITICAL" }),
        incident({ incident_id: "INC-2", severity: "MEDIUM" }),
        incident({ incident_id: "INC-3", severity: "MEDIUM" }),
      ],
      count: 3,
    });

    renderPage();

    expect(
      await screen.findByText("3 incidents: 1 critical, 0 high, 2 medium, 0 low. None are resolved yet."),
    ).toBeInTheDocument();
  });
});

describe("the recommendation (requirement 8.5)", () => {
  const RECOMMENDATION = "Replace the cancelled speaker with backup speaker SPK-005.";

  beforeEach(() => {
    api.incidents.mockResolvedValue({
      incidents: [
        incident({
          incident_id: "INC-001",
          severity: "CRITICAL",
          title: "Keynote cancelled",
          recommendation: RECOMMENDATION,
          backup_options: ["SPK-005"],
        }),
      ],
      count: 1,
    });
  });

  it("is reachable only through the drawer", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("table", { name: "Active incidents" })).toBeInTheDocument();
    });

    // Nothing on the page previews it: no headline card, no row cell.
    expect(screen.queryByText(RECOMMENDATION)).not.toBeInTheDocument();
    expect(screen.queryByText("What CommunityOps proposes")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "View details for Keynote cancelled" }));

    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText(RECOMMENDATION)).toBeInTheDocument();
    expect(
      within(drawer).getByRole("heading", { name: "What CommunityOps proposes" }),
    ).toBeInTheDocument();
    // The proposal carries its state, and the backup options are a labelled list.
    expect(within(drawer).getByText(/Proposal state:/)).toBeInTheDocument();
    expect(within(drawer).getByRole("list", { name: "Backup options" })).toBeInTheDocument();

    await userEvent.click(within(drawer).getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByText(RECOMMENDATION)).not.toBeInTheDocument();
    });
  });
});

describe("derived approval linkage (requirement 8.6)", () => {
  beforeEach(() => {
    api.incidents.mockResolvedValue({
      incidents: [
        incident({ incident_id: "INC-001", severity: "CRITICAL", title: "Keynote cancelled" }),
        incident({ incident_id: "INC-002", severity: "HIGH", title: "Catering delayed" }),
      ],
      count: 2,
    });
  });

  it("surfaces an approval whose affected_resource_id matches, and calls the link derived", async () => {
    api.approvals.mockResolvedValue({
      approvals: [
        approval({ approval_id: "APR-001", title: "Replace cancelled speaker with backup", affected_resource_id: "INC-001" }),
        approval({ approval_id: "APR-002", title: "Send a third follow-up", affected_resource_id: "SPK-002" }),
      ],
      count: 2,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("table", { name: "Active incidents" })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "View details for Keynote cancelled" }));

    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("Replace cancelled speaker with backup")).toBeInTheDocument();
    expect(within(drawer).getByText(/^Derived:/)).toBeInTheDocument();

    // An approval pointing at a speaker is not this incident's.
    expect(within(drawer).queryByText("Send a third follow-up")).not.toBeInTheDocument();
  });

  it("shows no linkage for an incident no approval names", async () => {
    api.approvals.mockResolvedValue({
      approvals: [approval({ approval_id: "APR-001", affected_resource_id: "INC-001" })],
      count: 1,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("table", { name: "Active incidents" })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "View details for Catering delayed" }));

    const drawer = screen.getByRole("dialog");
    expect(
      within(drawer).getByText("No pending approval names this incident as its affected resource."),
    ).toBeInTheDocument();
    expect(within(drawer).queryByText(/^Derived:/)).not.toBeInTheDocument();
  });
});

describe("states (requirements 8.7, 13.1, 13.2, 13.3)", () => {
  it("renders the specified copy when the event has no incidents", async () => {
    api.incidents.mockResolvedValue({ incidents: [], count: 0 });

    renderPage();

    expect(await screen.findByText("No incidents for this event.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Active incidents" })).not.toBeInTheDocument();
  });

  it("renders a skeleton in the shape of the list while loading", () => {
    api.incidents.mockReturnValue(new Promise(() => undefined));

    renderPage();

    expect(screen.getByText("Getting the latest incident state…")).toBeInTheDocument();
  });

  it("renders the shared failure copy with a retry that re-runs only the incidents request", async () => {
    api.incidents.mockRejectedValueOnce(new Error("network down"));

    renderPage();

    expect(await screen.findByText("CommunityOps couldn't load this view.")).toBeInTheDocument();
    // No backend detail reaches the screen.
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();

    api.incidents.mockResolvedValue({
      incidents: [incident({ incident_id: "INC-001", severity: "CRITICAL" })],
      count: 1,
    });

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(screen.getByRole("table", { name: "Active incidents" })).toBeInTheDocument();
    });
    expect(api.incidents).toHaveBeenCalledTimes(2);
    expect(api.approvals).toHaveBeenCalledTimes(1);
  });
});

describe("the incident mutation (requirement 8.8)", () => {
  it("sends only the fields the endpoint allows", () => {
    const body = buildIncidentUpdateBody("ORG-wemakedev", { status: "ANALYZING", severity: "LOW" });

    expect(body).toEqual({
      organization_id: "ORG-wemakedev",
      status: "ANALYZING",
      severity: "LOW",
    });
    // `approval_id` is not an allowed field, which is why the linkage is derived.
    expect(Object.keys(body)).not.toContain("approval_id");
    expect(Object.keys(buildIncidentUpdateBody("ORG-wemakedev", {}))).toEqual(["organization_id"]);
  });
});

describe("reading the incident record", () => {
  it("never renders a JSON impact analysis raw, and counts what it does not display", () => {
    const analysed = {
      ...incident({ incident_id: "INC-001" }),
      impact_analysis: JSON.stringify({
        affected_resource_type: "Speaker",
        affected_resource_id: "SPK-006",
        dependencies: ["SESSION-14"],
        analysis_complete: true,
        trace_context: { span: "abc" },
      }),
      dependencies: ["SESSION-14"],
      resolution_summary: "Backup speaker confirmed for the 14:00 slot.",
    };

    const analysis = readIncidentAnalysis(analysed);

    expect(analysis.impact.kind).toBe("structured");
    if (analysis.impact.kind === "structured") {
      expect(analysis.impact.rows.map((row) => row.label)).toEqual([
        "Affected resource type",
        "Affected resource",
        "Dependencies identified",
        "Analysis complete",
      ]);
      expect(analysis.impact.rows.map((row) => row.value)).toEqual([
        "Speaker",
        "SPK-006",
        "1",
        "Yes",
      ]);
      expect(analysis.impact.undisplayedCount).toBe(1);
    }

    expect(analysis.dependencies).toEqual(["SESSION-14"]);
    expect(analysis.resolutionSummary).toBe("Backup speaker confirmed for the 14:00 slot.");
  });

  it("treats prose as prose and an absent analysis as absent", () => {
    const prose = { ...incident({ incident_id: "INC-002" }), impact_analysis: "The 14:00 slot is empty." };

    expect(readIncidentAnalysis(prose).impact).toEqual({
      kind: "prose",
      text: "The 14:00 slot is empty.",
    });
    expect(readIncidentAnalysis(incident({ incident_id: "INC-003" })).impact).toEqual({
      kind: "absent",
    });
  });

  it("sorts an unrecognised severity after the four declared levels", () => {
    const { active } = orderIncidents([
      incident({ incident_id: "INC-odd", severity: "CRITICAL" }),
      incident({ incident_id: "INC-low", severity: "LOW" }),
    ]);

    expect(active.map((entry) => entry.incident_id)).toEqual(["INC-odd", "INC-low"]);
    expect(severityDistribution(active).map((segment) => segment.count)).toEqual([1, 0, 0, 1]);
  });
});

describe("incident discussion", () => {
  it("loads detail comments and preserves comment submission in the drawer", async () => {
    const user = userEvent.setup();
    const selected = incident({ incident_id: "INC-comments", title: "Registration queue blocked" });
    api.incidents.mockResolvedValue({ incidents: [selected], count: 1 });
    api.detail
      .mockResolvedValueOnce({ incident: selected, comments: [], comment_count: 0 })
      .mockResolvedValueOnce({ incident: selected, comments: [{ comment_id: "CMT-1", incident_id: selected.incident_id, event_id: EVENT_ID, body: "Move one volunteer to desk two", author_id: "USR-1", author_name: "Asha", author_type: "user", created_at: "2026-10-15T10:00:00Z" }], comment_count: 1 });
    api.comment.mockResolvedValue({ comment_id: "CMT-1", created_task_id: null, message: "Comment added" });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "View details for Registration queue blocked" }));
    await user.type(screen.getByLabelText("Add a comment"), "Move one volunteer to desk two");
    await user.click(screen.getByRole("button", { name: "Add comment" }));
    expect(await screen.findByText("Move one volunteer to desk two")).toBeInTheDocument();
    expect(api.comment).toHaveBeenCalledWith(EVENT_ID, "INC-comments", { body: "Move one volunteer to desk two" });
  });
});


describe("incident transition boundaries", () => {
  it("never offers dedicated or terminal statuses through generic update", async () => {
    const selected = incident({ incident_id: "INC-safe", title: "Safe transition" });
    api.incidents.mockResolvedValue({ incidents: [selected], count: 1 });
    api.detail.mockResolvedValue({ incident: selected, comments: [], comment_count: 0 });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "View details for Safe transition" }));
    const options = within(screen.getByRole("dialog")).getAllByRole("option").map((option) => option.getAttribute("value"));
    for (const status of ["RESOLVED", "REOPENED", "CLOSED", "REJECTED", "ESCALATED"]) {
      expect(options).not.toContain(status);
    }
    expect(options).toEqual(expect.arrayContaining(["REPORTED", "ACKNOWLEDGED", "ANALYZING", "EXECUTING"]));
    expect(options).not.toContain("OPEN");
  });

  it("locks rapid resolve activation and renders the authoritative refreshed incident", async () => {
    const selected = incident({ incident_id: "INC-resolve", title: "Resolve safely" });
    const resolved = {
      ...selected,
      status: "RESOLVED",
      resolved_at: "2026-10-15T10:30:00Z",
      resolution_summary: "Authoritative backend resolution",
    };
    api.incidents
      .mockResolvedValueOnce({ incidents: [selected], count: 1 })
      .mockResolvedValueOnce({ incidents: [resolved], count: 1 });
    api.detail
      .mockResolvedValueOnce({ incident: selected, comments: [], comment_count: 0 })
      .mockResolvedValueOnce({
        incident: resolved,
        comments: [{ comment_id: "CMT-resolved", incident_id: selected.incident_id, event_id: EVENT_ID, body: "Verified by the response team", author_id: "USR-1", author_name: "Asha", author_type: "user", created_at: "2026-10-15T10:31:00Z" }],
        comment_count: 1,
      });
    api.resolve.mockResolvedValue({ incident_id: selected.incident_id, status: "RESOLVED", message: "Incident resolved" });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "View details for Resolve safely" }));
    await userEvent.type(screen.getByLabelText("Resolution summary"), "  Backup confirmed  ");

    const resolveButton = screen.getByRole("button", { name: "Resolve incident" });
    fireEvent.click(resolveButton);
    fireEvent.click(resolveButton);

    expect(api.resolve).toHaveBeenCalledTimes(1);
    expect(api.resolve).toHaveBeenCalledWith(EVENT_ID, "INC-resolve", { resolution_summary: "Backup confirmed" });
    expect(api.update).not.toHaveBeenCalled();
    expect(await screen.findByText("Incident resolved")).toBeInTheDocument();
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("Authoritative backend resolution")).toBeInTheDocument();
    expect(within(drawer).getByText("Verified by the response team")).toBeInTheDocument();
    expect(within(drawer).getByText("Resolved", { selector: "dt" })).toBeInTheDocument();
    expect(api.detail).toHaveBeenCalledTimes(2);
    expect(api.incidents).toHaveBeenCalledTimes(2);
  });
});


describe("terminal incident presentation", () => {
  it("treats a refreshed reopened incident with a cleared timestamp as active and renders no invalid resolution time", async () => {
    const selected = incident({
      incident_id: "INC-reopened-refresh",
      title: "Reopened after refresh",
      status: "REOPENED",
      resolved_at: null,
    });
    api.incidents.mockResolvedValue({ incidents: [selected], count: 1 });
    api.detail.mockResolvedValue({ incident: selected, comments: [], comment_count: 0 });

    renderPage();

    expect(await screen.findByRole("table", { name: "Active incidents" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View details for Reopened after refresh" }));

    const drawer = screen.getByRole("dialog");
    expect(within(drawer).queryByText("Resolved", { selector: "dt" })).not.toBeInTheDocument();
    expect(drawer.textContent).not.toMatch(/1970|invalid date|time unavailable/i);
  });

  it("locks rapid reopen activation and renders the authoritative refreshed incident", async () => {
    const selected = incident({
      incident_id: "INC-reopen",
      title: "Reopen locally",
      status: "RESOLVED",
      resolved_at: "2026-10-15T10:00:00Z",
    });
    const reopened = {
      ...selected,
      title: "Reopened from authoritative detail",
      status: "REOPENED",
      resolved_at: null,
      recommendation: "Authoritative reopened recommendation",
    };
    api.incidents
      .mockResolvedValueOnce({ incidents: [selected], count: 1 })
      .mockResolvedValueOnce({ incidents: [reopened], count: 1 });
    api.detail
      .mockResolvedValueOnce({ incident: selected, comments: [], comment_count: 0 })
      .mockResolvedValueOnce({
        incident: reopened,
        comments: [{ comment_id: "CMT-reopened", incident_id: selected.incident_id, event_id: EVENT_ID, body: "Authoritative reopen note", author_id: "USR-1", author_name: "Asha", author_type: "user", created_at: "2026-10-15T10:05:00Z" }],
        comment_count: 1,
      });
    api.reopen.mockResolvedValue({
      incident_id: selected.incident_id,
      status: "REOPENED",
      message: "Incident reopened",
    });

    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Show 1 resolved" }));
    await userEvent.click(screen.getByRole("button", { name: "View details for Reopen locally" }));

    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("Resolved", { selector: "dt" })).toBeInTheDocument();
    const reopenButton = within(drawer).getByRole("button", { name: "Reopen incident" });
    fireEvent.click(reopenButton);
    fireEvent.click(reopenButton);

    expect(api.reopen).toHaveBeenCalledTimes(1);
    expect(api.reopen).toHaveBeenCalledWith(EVENT_ID, "INC-reopen");
    expect(await screen.findByText("Incident reopened")).toBeInTheDocument();
    await waitFor(() => {
      expect(within(drawer).queryByText("Resolved", { selector: "dt" })).not.toBeInTheDocument();
    });
    expect(within(drawer).getByText("Authoritative reopened recommendation")).toBeInTheDocument();
    expect(within(drawer).getByText("Authoritative reopen note")).toBeInTheDocument();
    expect(rowTitles("Active incidents")[0]).toContain("Reopened from authoritative detail");
    expect(api.detail).toHaveBeenCalledTimes(2);
    expect(api.incidents).toHaveBeenCalledTimes(2);
    expect(drawer.textContent).not.toMatch(/1970|invalid date|time unavailable/i);
  });

  it.each(["RESOLVED", "CLOSED", "REJECTED"] as const)(
    "offers dedicated reopen and no generic update form for %s",
    async (status) => {
      const selected = incident({
        incident_id: `INC-${status.toLowerCase()}`,
        title: `${status} incident`,
        status,
        resolved_at: "2026-10-15T10:00:00Z",
      });
      api.incidents.mockResolvedValue({ incidents: [selected], count: 1 });
      api.detail.mockResolvedValue({ incident: selected, comments: [], comment_count: 0 });
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "Show 1 resolved" }));
      await userEvent.click(screen.getByRole("button", { name: `View details for ${status} incident` }));
      const drawer = screen.getByRole("dialog");
      expect(within(drawer).getByRole("button", { name: "Reopen incident" })).toBeInTheDocument();
      expect(within(drawer).queryByRole("heading", { name: "Record a change" })).not.toBeInTheDocument();
      expect(within(drawer).queryByLabelText("Incident status")).not.toBeInTheDocument();
    },
  );
});
