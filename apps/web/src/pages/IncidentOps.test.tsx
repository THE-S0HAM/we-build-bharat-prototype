/**
 * Tests for IncidentOps.
 *
 * Three things matter here beyond rendering a list:
 *
 * 1. **Agent and human observations are distinguishable.** A reader has to know which notes came from
 *    a person standing in the hall and which are the system's analysis. If those look identical the
 *    thread stops being evidence.
 *
 * 2. **The recommendation is not shown before what happened.** It sits behind a disclosure on
 *    purpose: a suggestion read first tends to be accepted without reading the incident.
 *
 * 3. **Resolving is leader-only and needs a summary.** An incident closed with no explanation teaches
 *    nobody anything, and deciding a problem is actually over is a judgement about the world.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import { EVENT_ID, INCIDENT_001, INCIDENT_DETAIL } from "../test/fixtures";

const getIncidents = vi.fn();
const getIncident = vi.fn();
const getTeams = vi.fn();
const addIncidentComment = vi.fn();
const updateIncident = vi.fn();
const resolveIncident = vi.fn();

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getIncidents: (...args: unknown[]) => getIncidents(...args),
    getIncident: (...args: unknown[]) => getIncident(...args),
    getTeams: (...args: unknown[]) => getTeams(...args),
    addIncidentComment: (...args: unknown[]) => addIncidentComment(...args),
    updateIncident: (...args: unknown[]) => updateIncident(...args),
    resolveIncident: (...args: unknown[]) => resolveIncident(...args),
  };
});

const { IncidentOpsPage } = await import("./IncidentOps");

function renderPage(role: "LEADER" | "TEAM_MEMBER" = "LEADER") {
  const onChanged = vi.fn();
  const view = render(
    <IncidentOpsPage eventId={EVENT_ID} role={role} onChanged={onChanged} />,
  );
  return { ...view, onChanged };
}

beforeEach(() => {
  getIncidents.mockResolvedValue({
    incidents: [INCIDENT_001],
    count: 1,
    open_count: 1,
    critical_open_count: 0,
  });
  getIncident.mockResolvedValue(INCIDENT_DETAIL);
  getTeams.mockResolvedValue({
    teams: [
      {
        team_id: "TEAM-tech",
        event_id: EVENT_ID,
        name: "Tech and AV",
        lead_user_id: "demo-team-rahul",
        lead_name: "Rahul Patil",
        member_count: 4,
        total_tasks: 6,
        open_tasks: 3,
        completed_tasks: 2,
        overdue_tasks: 1,
        blocked_tasks: 0,
        in_progress_tasks: 2,
        progress_percent: 33,
        workload_per_member: 1,
        risk: "MEDIUM" as const,
      },
    ],
    count: 1,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function openIncident() {
  await userEvent.click(await screen.findByText(INCIDENT_001.title));
  return screen.findByRole("dialog");
}

describe("the list", () => {
  it("counts open incidents by severity", async () => {
    renderPage();
    await screen.findByText(INCIDENT_001.title);
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it("says so when nothing is threatening the event", async () => {
    getIncidents.mockResolvedValue({
      incidents: [],
      count: 0,
      open_count: 0,
      critical_open_count: 0,
    });
    renderPage();
    expect(await screen.findByText(/Nothing is threatening the event/i)).toBeInTheDocument();
  });

  it("still renders when the team list is unavailable", async () => {
    getTeams.mockRejectedValue(new ApiError("unavailable", 503));
    renderPage();
    expect(await screen.findByText(INCIDENT_001.title)).toBeInTheDocument();
  });
});

describe("the discussion thread", () => {
  it("distinguishes the agent's analysis from a person's observation", async () => {
    const dialog = await (renderPage(), openIncident());

    // Scoped to the thread: "Rahul Patil" also appears in the detail list as the reporter.
    const authors = [...dialog.querySelectorAll(".message-author")].map((n) => n.textContent);
    expect(authors).toEqual(["Rahul Patil", "CommunityOps"]);
    // The agent's message carries an explicit marker, not only a different colour.
    expect(within(dialog).getByText("Agent")).toBeInTheDocument();
    expect(dialog.querySelectorAll(".message.agent-message")).toHaveLength(1);
  });

  it("posts a comment and reloads the thread from the backend", async () => {
    addIncidentComment.mockResolvedValue({
      comment_id: "CMT-009",
      created_task_id: null,
      message: "Comment added.",
    });

    renderPage();
    await openIncident();

    await userEvent.type(
      screen.getByLabelText("Comment"),
      "Second unit tested clean for an hour.",
    );
    await userEvent.click(screen.getByRole("button", { name: /^Comment$/ }));

    await waitFor(() =>
      expect(addIncidentComment).toHaveBeenCalledWith(EVENT_ID, "INC-001", {
        body: "Second unit tested clean for an hour.",
      }),
    );
    // Reloaded rather than optimistically appended, so the thread is what the backend stored.
    await waitFor(() => expect(getIncident).toHaveBeenCalledTimes(2));
  });

  it("creates a task from a comment in one action", async () => {
    addIncidentComment.mockResolvedValue({
      comment_id: "CMT-010",
      created_task_id: "TSK-av07",
      message: "Comment added and task created.",
    });

    renderPage();
    await openIncident();

    await userEvent.type(screen.getByLabelText("Comment"), "Backup unit needs testing.");
    await userEvent.click(screen.getByLabelText(/Also create a task from this/i));
    await userEvent.type(screen.getByLabelText(/^Task$/), "Test the backup projector");
    await userEvent.selectOptions(screen.getByLabelText(/^Team$/), "TEAM-tech");
    await userEvent.click(screen.getByRole("button", { name: /Comment and create task/i }));

    await waitFor(() =>
      expect(addIncidentComment).toHaveBeenCalledWith(
        EVENT_ID,
        "INC-001",
        expect.objectContaining({
          create_task: true,
          task_team_id: "TEAM-tech",
          task_title: "Test the backup projector",
        }),
      ),
    );
  });

  it("will not create a task without a team to own it", async () => {
    renderPage();
    await openIncident();

    await userEvent.type(screen.getByLabelText("Comment"), "Needs doing.");
    await userEvent.click(screen.getByLabelText(/Also create a task from this/i));
    await userEvent.type(screen.getByLabelText(/^Task$/), "Test the backup projector");

    expect(screen.getByRole("button", { name: /Comment and create task/i })).toBeDisabled();
  });

  it("reports a failed comment in place rather than losing the text", async () => {
    addIncidentComment.mockRejectedValue(new ApiError("Comment rejected.", 400));

    renderPage();
    await openIncident();

    await userEvent.type(screen.getByLabelText("Comment"), "Something happened.");
    await userEvent.click(screen.getByRole("button", { name: /^Comment$/ }));

    expect(await screen.findByText(/Comment rejected/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Comment")).toHaveValue("Something happened.");
  });
});

describe("the recommendation", () => {
  it("is behind a disclosure so the incident is read first", async () => {
    const dialog = await (renderPage(), openIncident());

    expect(within(dialog).getByText(INCIDENT_001.description)).toBeInTheDocument();
    // Present as a summary the reader chooses to open, not as standing text.
    const disclosure = within(dialog).getByText(/What does CommunityOps suggest\?/i);
    expect(disclosure.tagName.toLowerCase()).toBe("summary");
  });

  it("shows the options and impact once opened", async () => {
    renderPage();
    await openIncident();

    await userEvent.click(screen.getByText(/What does CommunityOps suggest\?/i));
    expect(screen.getByText(INCIDENT_001.recommendation)).toBeInTheDocument();
    expect(screen.getByText("Hire a replacement unit")).toBeInTheDocument();
  });
});

describe("resolving", () => {
  it("is offered to a leader", async () => {
    renderPage("LEADER");
    await openIncident();
    expect(screen.getByRole("button", { name: /^Resolve$/ })).toBeInTheDocument();
  });

  it("is not offered to a team member", async () => {
    renderPage("TEAM_MEMBER");
    await openIncident();
    expect(screen.queryByRole("button", { name: /^Resolve$/ })).not.toBeInTheDocument();
  });

  it("requires a summary before it can be recorded", async () => {
    renderPage("LEADER");
    await openIncident();

    await userEvent.click(screen.getByRole("button", { name: /^Resolve$/ }));
    expect(screen.getByRole("button", { name: /Resolve incident/i })).toBeDisabled();

    await userEvent.type(
      screen.getByLabelText(/What resolved it/i),
      "Replacement projector installed and tested.",
    );
    expect(screen.getByRole("button", { name: /Resolve incident/i })).toBeEnabled();
  });

  it("refreshes the shell, because resolving removes a health signal", async () => {
    resolveIncident.mockResolvedValue({
      incident_id: "INC-001",
      status: "RESOLVED",
      message: "Resolved.",
    });

    const { onChanged } = renderPage("LEADER");
    await openIncident();

    await userEvent.click(screen.getByRole("button", { name: /^Resolve$/ }));
    await userEvent.type(screen.getByLabelText(/What resolved it/i), "Replacement installed.");
    await userEvent.click(screen.getByRole("button", { name: /Resolve incident/i }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("explains why a high-severity incident is not closed automatically", async () => {
    const dialog = await (renderPage("LEADER"), openIncident());
    expect(dialog).toHaveTextContent(
      /will not resolve a high or critical incident on its own/i,
    );
  });
});

describe("acknowledging", () => {
  it("is offered while the incident is unacknowledged", async () => {
    updateIncident.mockResolvedValue({ incident_id: "INC-001", message: "Acknowledged." });

    renderPage();
    await openIncident();
    await userEvent.click(screen.getByRole("button", { name: /Acknowledge/i }));

    await waitFor(() =>
      expect(updateIncident).toHaveBeenCalledWith(EVENT_ID, "INC-001", {
        status: "ACKNOWLEDGED",
      }),
    );
  });

  it("is withdrawn once it has been acknowledged", async () => {
    getIncident.mockResolvedValue({
      ...INCIDENT_DETAIL,
      incident: {
        ...INCIDENT_001,
        status: "ACKNOWLEDGED",
        acknowledged_at: new Date().toISOString(),
      },
    });

    renderPage();
    await openIncident();
    expect(screen.queryByRole("button", { name: /Acknowledge/i })).not.toBeInTheDocument();
  });
});
