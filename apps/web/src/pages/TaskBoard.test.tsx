/**
 * TeamOps behaviour tests (requirements 7.2, 7.3, 7.6; task 6.5).
 *
 * The three things this page has to get right, in the order they matter:
 *
 *   1. **It never invents a team.** Every identifier and every name comes from
 *      `GET /events/{eventId}/teams`. The page this replaced held six team ids in
 *      source, so the test asserts against those six by name: if any of them ever
 *      reappears in rendered output, this fails.
 *   2. **It degrades honestly.** That route does not exist yet (design.md A5), so
 *      both of today's outcomes — a failed request and a response carrying no
 *      directory — must land on "Team directory unavailable" with no team cards
 *      at all.
 *   3. **Blocked and overdue are words.** Never a colour on its own
 *      (requirements 7.6, 15.10).
 *
 * Only the network boundary is stubbed. The real `Drawer`, `StatusBadge`,
 * `ApiErrorState` and `useApiFailure` are composed, so what the assertions read
 * is what a user would see.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { SessionContext, type SessionValue } from "../session/sessionContext";
import type { Task, Team } from "../types";
import { TaskBoard } from "./TaskBoard";

/** The six ids and names the deleted hardcoded list carried (design.md A5). */
const DELETED_TEAM_IDS = [
  "TEAM-marketing",
  "TEAM-registration",
  "TEAM-speakers",
  "TEAM-venue",
  "TEAM-volunteers",
  "TEAM-tech",
];

const DELETED_TEAM_NAMES = [
  "Marketing",
  "Registration",
  "Speaker Management",
  "Venue & Logistics",
  "Volunteers",
  "Technical Operations",
];

const EVENT_ID = "EVT-test";

/**
 * The stubbed network. `directory` is typed `unknown` on purpose: the point of
 * these tests is what the page does when the response is not the declared shape.
 */
const api = vi.hoisted(() => ({
  directory: null as unknown,
  directoryFailure: null as unknown,
  tasksByTeam: new Map<string, readonly unknown[]>(),
  failingTeams: new Set<string>(),
  taskWrites: [] as { eventId: string; teamId: string; taskId: string; changes: Record<string, unknown> }[],
  reassignWrites: [] as { eventId: string; teamId: string; taskId: string; assigned_to: string; reason: string }[],
  taskReads: 0,
  updateFailure: null as unknown,
}));

vi.mock("../api", () => ({
  getTeams: () =>
    api.directoryFailure === null
      ? Promise.resolve(api.directory)
      : Promise.reject(api.directoryFailure),
  getEventTasks: () => {
    api.taskReads += 1;
    const tasks = [...api.tasksByTeam.values()].flat();
    return Promise.resolve({ tasks, count: tasks.length, overdue_count: 0, blocked_count: 0, completed_count: 0, in_progress_count: 0 });
  },
  getWorkload: () => Promise.resolve({ event_id: EVENT_ID, teams: [], members: [], busiest_member: null, most_available_member: null }),
  updateTask: (eventId: string, teamId: string, taskId: string, changes: Record<string, unknown>) => {
    api.taskWrites.push({ eventId, teamId, taskId, changes });
    if (api.updateFailure !== null) return Promise.reject(api.updateFailure);
    const tasks = api.tasksByTeam.get(teamId) ?? [];
    api.tasksByTeam.set(teamId, tasks.map((task) => {
      const current = task as Task;
      return current.task_id === taskId ? { ...current, ...changes } : current;
    }));
    return Promise.resolve({ task_id: taskId, status: String(changes.status ?? ""), message: "saved" });
  },
  reassignTask: (eventId: string, teamId: string, taskId: string, input: { assigned_to: string; reason: string }) => {
    api.reassignWrites.push({ eventId, teamId, taskId, ...input });
    const tasks = api.tasksByTeam.get(teamId) ?? [];
    api.tasksByTeam.set(teamId, tasks.map((task) => {
      const current = task as Task;
      return current.task_id === taskId ? { ...current, assigned_to: input.assigned_to } : current;
    }));
    return Promise.resolve({ task_id: taskId, assigned_to: input.assigned_to, message: "reassigned" });
  },
  getTasks: (_eventId: string, teamId: string) =>
    api.failingTeams.has(teamId)
      ? Promise.reject({ status: 502 })
      : Promise.resolve({
          tasks: api.tasksByTeam.get(teamId) ?? [],
          count: (api.tasksByTeam.get(teamId) ?? []).length,
        }),
}));

const session: SessionValue = {
  status: "authenticated",
  user: {
    userId: "USR-1",
    name: "Asha",
    email: "asha@example.org",
    role: "LEADER",
    organizations: ["ORG-test"],
    isDemo: false,
  },
  activeOrganizationId: "ORG-test",
  refresh: () => Promise.resolve(),
  signOut: () => {},
};

function renderBoard() {
  return render(
    <MemoryRouter>
      <SessionContext.Provider value={session}>
        <TaskBoard eventId={EVENT_ID} />
      </SessionContext.Provider>
    </MemoryRouter>,
  );
}

function teamWith(fields: Partial<Team> & { team_id: string; name: string }): Team {
  return { event_id: EVENT_ID, is_active: true, ...fields };
}

function taskWith(fields: Partial<Task> & { task_id: string; team_id: string }): Task {
  return {
    event_id: EVENT_ID,
    title: `Work item ${fields.task_id}`,
    description: "",
    status: "PENDING",
    priority: "MEDIUM",
    assigned_to: "",
    due_date: "",
    depends_on: [],
    blocks: [],
    escalation_level: 0,
    ...fields,
  };
}

beforeEach(() => {
  api.directory = null;
  api.directoryFailure = null;
  api.tasksByTeam = new Map();
  api.failingTeams = new Set();
  api.taskWrites = [];
  api.reassignWrites = [];
  api.taskReads = 0;
  api.updateFailure = null;
});

describe('"Team directory unavailable" (requirement 7.3, design.md A5)', () => {
  it("renders when the teams request fails, and offers a retry", async () => {
    api.directoryFailure = { status: 502 };

    renderBoard();

    expect(
      await screen.findByRole("heading", { name: "Team directory unavailable" }),
    ).toBeInTheDocument();

    // The missing capability is named in product language, and the page states
    // that task data becomes reachable once a directory exists.
    expect(
      screen.getByText(/no way to ask this event which teams it has/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/once a team directory exists for this event/i)).toBeInTheDocument();

    // A failed request is worth retrying, so the shared failure surface appears.
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("renders when the teams contract answers without a directory, with nothing to retry", async () => {
    // What happens today: the route does not exist, so nothing carries `teams`.
    api.directory = {};

    renderBoard();

    expect(
      await screen.findByRole("heading", { name: "Team directory unavailable" }),
    ).toBeInTheDocument();

    // Not a failure the user can do anything about, so no retry and no alert.
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders no team at all while the directory is unavailable (requirement 7.2)", async () => {
    api.directoryFailure = { status: 502 };

    renderBoard();
    await screen.findByRole("heading", { name: "Team directory unavailable" });

    const rendered = document.body.textContent ?? "";

    for (const identifier of [...DELETED_TEAM_IDS, ...DELETED_TEAM_NAMES]) {
      expect(rendered, identifier).not.toContain(identifier);
    }

    // No card, and no "View details" affordance into a team that does not exist.
    expect(screen.queryByRole("button", { name: /^View details for / })).not.toBeInTheDocument();
  });
});

describe("the team-first board once the contract responds", () => {
  const platform = teamWith({ team_id: "TEAM-42", name: "Platform crew" });
  const hospitality = teamWith({ team_id: "TEAM-7", name: "Hospitality crew" });

  beforeEach(() => {
    api.directory = { teams: [hospitality, platform], count: 2 };
    api.tasksByTeam = new Map<string, readonly Task[]>([
      [
        "TEAM-42",
        [
          taskWith({
            task_id: "TSK-1",
            team_id: "TEAM-42",
            title: "Confirm venue power draw",
            status: "BLOCKED",
            priority: "CRITICAL",
            assigned_to: "Asha",
            depends_on: ["TSK-9"],
            blocks: ["TSK-3"],
            escalation_level: 2,
          }),
          taskWith({
            task_id: "TSK-2",
            team_id: "TEAM-42",
            title: "Publish the run sheet",
            status: "OVERDUE",
            due_date: "2020-01-01T09:00:00Z",
          }),
          taskWith({ task_id: "TSK-3", team_id: "TEAM-42", status: "COMPLETED" }),
        ],
      ],
      ["TEAM-7", [taskWith({ task_id: "TSK-4", team_id: "TEAM-7", status: "IN_PROGRESS" })]],
    ]);
  });

  it("names only the teams the directory returned, in attention order", async () => {
    renderBoard();

    const headings = await screen.findAllByRole("heading", { level: 2 });
    const names = headings.map((heading) => heading.textContent);

    // The page's one visual comes first, then the team that needs a person.
    expect(names).toEqual(["Where the work stands", "Platform crew", "Hospitality crew"]);

    const rendered = document.body.textContent ?? "";
    for (const identifier of DELETED_TEAM_NAMES) {
      expect(rendered, identifier).not.toContain(identifier);
    }
  });

  it("labels blocked and overdue in words, on the card and in the visual (requirement 7.6)", async () => {
    renderBoard();
    await screen.findByRole("heading", { name: "Platform crew" });

    // The one contextual visual: every segment is named and counted in text, and
    // the bar itself is hidden from assistive technology because it adds nothing.
    const progress = screen.getByRole("region", { name: "Where the work stands" });
    const blocked = within(progress).getByText("Blocked");
    const overdue = within(progress).getByText("Overdue");

    expect(blocked).toBeInTheDocument();
    expect(overdue).toBeInTheDocument();
    expect(within(progress).getByText(/1 blocked, 1 overdue/)).toBeInTheDocument();

    // And on the team card, as a labelled count plus a sentence.
    const card = screen.getByRole("region", { name: "Platform crew" });
    expect(within(card).getByText("Blocked")).toBeInTheDocument();
    expect(within(card).getByText("Overdue")).toBeInTheDocument();
    expect(
      within(card).getByText("1 blocked and 1 overdue — this team needs you."),
    ).toBeInTheDocument();
  });

  it("opens a team's tasks with the relationships as sentences (requirement 7.5)", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("heading", { name: "Platform crew" });

    const card = screen.getByRole("region", { name: "Platform crew" });
    await user.click(within(card).getByRole("button", { name: "View details for Platform crew" }));

    const drawer = screen.getByRole("dialog", { name: "Platform crew" });

    expect(within(drawer).getByRole("heading", { name: "Confirm venue power draw" })).toBeInTheDocument();
    expect(within(drawer).getByText("Asha")).toBeInTheDocument();
    expect(within(drawer).getByText("Escalated twice — warning")).toBeInTheDocument();
    expect(
      within(drawer).getByText("This task is waiting on one other task: TSK-9."),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByText("Finishing this unblocks one other task: TSK-3."),
    ).toBeInTheDocument();

    // Blocked and overdue keep their text label inside the drawer too.
    expect(within(drawer).getByText("Blocked")).toBeInTheDocument();
    expect(within(drawer).getByText("Overdue")).toBeInTheDocument();
  });

  it("submits only the fields the task endpoint allows, and updates in place (requirement 7.8)", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("heading", { name: "Hospitality crew" });

    const card = screen.getByRole("region", { name: "Hospitality crew" });
    await user.click(
      within(card).getByRole("button", { name: "View details for Hospitality crew" }),
    );

    const drawer = screen.getByRole("dialog", { name: "Hospitality crew" });
    await user.click(within(drawer).getByRole("button", { name: /Record a change to/ }));

    await user.selectOptions(within(drawer).getByLabelText("Task status"), "BLOCKED");
    await user.type(within(drawer).getByLabelText("Blocking reason"), "Waiting for vendor confirmation");
    await user.click(within(drawer).getByRole("button", { name: "Save change" }));

    expect(await within(drawer).findByText("Change saved. This task is up to date.")).toBeInTheDocument();

    expect(api.taskWrites).toEqual([
      { eventId: EVENT_ID, teamId: "TEAM-7", taskId: "TSK-4", changes: { status: "BLOCKED", blocked_reason: "Waiting for vendor confirmation" } },
    ]);

    // The board refetches authoritative task state after the accepted mutation.
    expect(api.taskReads).toBe(2);
    expect(within(screen.getByRole("region", { name: "Hospitality crew" })).getByText(
      "1 blocked — this team needs you.",
    )).toBeInTheDocument();
  });

  it("states when a team has no tasks (requirement 7.7)", async () => {
    const user = userEvent.setup();
    api.tasksByTeam = new Map([["TEAM-42", []]]);

    renderBoard();
    await screen.findByRole("heading", { name: "Platform crew" });

    const card = screen.getByRole("region", { name: "Platform crew" });
    expect(within(card).getByText("No tasks recorded for this team.")).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "View details for Platform crew" }));

    expect(
      within(screen.getByRole("dialog", { name: "Platform crew" })).getByText(
        "No tasks recorded for this team.",
      ),
    ).toBeInTheDocument();
  });

  it("uses the event-wide task response for every returned team", async () => {
    renderBoard();

    const platform = await screen.findByRole("region", { name: "Platform crew" });
    expect(within(platform).getByText("1 blocked and 1 overdue — this team needs you.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Hospitality crew" })).toBeInTheDocument();
  });
});


describe("task reassignment", () => {
  it("uses the dedicated endpoint with a reason and does not put assignment in generic update", async () => {
    const team = teamWith({ team_id: "TEAM-reassign", name: "Reassignment crew" });
    api.directory = { teams: [team], count: 1 };
    api.tasksByTeam = new Map([[team.team_id, [taskWith({ task_id: "TSK-reassign", team_id: team.team_id, title: "Move ownership", assigned_to: "USR-old" })]]]);
    renderBoard();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "View details for Reassignment crew" }));
    await user.click(screen.getByRole("button", { name: "Record a change to Move ownership" }));
    await user.clear(screen.getByLabelText("Assignee"));
    await user.type(screen.getByLabelText("Assignee"), "USR-new");
    expect(screen.getByRole("button", { name: "Save change" })).toBeDisabled();
    await user.type(screen.getByLabelText("Reassignment reason"), "Shift coverage");
    await user.click(screen.getByRole("button", { name: "Save change" }));
    expect(await screen.findByText("Change saved. This task is up to date.")).toBeInTheDocument();
    expect(api.reassignWrites).toEqual([{ eventId: EVENT_ID, teamId: team.team_id, taskId: "TSK-reassign", assigned_to: "USR-new", reason: "Shift coverage" }]);
    expect(api.taskWrites).toEqual([]);
    expect(api.taskReads).toBe(2);
  });
});


describe("partial task mutation failure", () => {
  it("refreshes authoritative state when reassignment commits before generic update fails", async () => {
    const team = teamWith({ team_id: "TEAM-partial", name: "Partial crew" });
    api.directory = { teams: [team], count: 1 };
    api.tasksByTeam = new Map([[team.team_id, [taskWith({ task_id: "TSK-partial", team_id: team.team_id, title: "Combined change", assigned_to: "USR-old" })]]]);
    api.updateFailure = { status: 500, category: "INTERNAL_ERROR" };
    renderBoard();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "View details for Partial crew" }));
    await user.click(screen.getByRole("button", { name: "Record a change to Combined change" }));
    await user.selectOptions(screen.getByLabelText("Task status"), "IN_PROGRESS");
    await user.clear(screen.getByLabelText("Assignee"));
    await user.type(screen.getByLabelText("Assignee"), "USR-new");
    await user.type(screen.getByLabelText("Reassignment reason"), "Coverage handoff");
    await user.click(screen.getByRole("button", { name: "Save change" }));
    expect(await screen.findByText("CommunityOps couldn't load this view.")).toBeInTheDocument();
    expect(api.reassignWrites).toHaveLength(1);
    expect(api.taskWrites).toHaveLength(1);
    expect(api.taskReads).toBe(2);
    expect(screen.getByText("USR-new")).toBeInTheDocument();
  });
});
