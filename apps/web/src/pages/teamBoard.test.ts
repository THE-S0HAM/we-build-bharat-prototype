/**
 * The TeamOps derivations (requirements 7.4, 7.5, 7.6).
 *
 * Counting a team's work, ordering teams by attention needed and turning a
 * dependency array into a sentence each have a right answer, and none of them
 * needs a DOM to check.
 */

import { describe, expect, it } from "vitest";

import type { Task, Team } from "../types";
import {
  attentionScore,
  blocksSentence,
  countTasks,
  dependsOnSentence,
  escalationLabel,
  orderByAttention,
  orderTasksByAttention,
  teamAttentionSentence,
  toEntry,
  totalCounts,
} from "./teamBoard";

function team(teamId: string, name: string): Team {
  return { team_id: teamId, event_id: "EVT-1", name, is_active: true };
}

function task(fields: Partial<Task> & { task_id: string }): Task {
  return {
    event_id: "EVT-1",
    team_id: "TEAM-1",
    title: `Work ${fields.task_id}`,
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

describe("countTasks", () => {
  it("counts each declared status into its own bucket and keeps the total honest", () => {
    const counts = countTasks([
      task({ task_id: "1", status: "BLOCKED" }),
      task({ task_id: "2", status: "OVERDUE" }),
      task({ task_id: "3", status: "OVERDUE" }),
      task({ task_id: "4", status: "IN_PROGRESS" }),
      task({ task_id: "5", status: "COMPLETED" }),
      task({ task_id: "6", status: "PENDING" }),
      task({ task_id: "7", status: "CANCELLED" }),
    ]);

    expect(counts).toEqual({
      blocked: 1,
      overdue: 2,
      inProgress: 1,
      completed: 1,
      pending: 1,
      cancelled: 1,
      unrecognised: 0,
      total: 7,
    });

    // The four counts requirement 7.4 names, plus the remainder, add up to the
    // total — a progress visual that reported four of seven tasks would lie.
    const summed =
      counts.blocked +
      counts.overdue +
      counts.inProgress +
      counts.completed +
      counts.pending +
      counts.cancelled +
      counts.unrecognised;
    expect(summed).toBe(counts.total);
  });

  it("counts a status outside the declared union as unrecognised rather than as progress", () => {
    // `apiFetch` asserts response shapes rather than validating them, so a status
    // the types have not caught up with reaches this function.
    const unknownStatus = JSON.parse('{"status":"AWAITING_VENDOR"}') as Pick<Task, "status">;

    const counts = countTasks([task({ task_id: "1", status: unknownStatus.status })]);

    expect(counts.unrecognised).toBe(1);
    expect(counts.inProgress).toBe(0);
    expect(counts.completed).toBe(0);
  });

  it("scores attention as blocked plus overdue and nothing else", () => {
    const counts = countTasks([
      task({ task_id: "1", status: "BLOCKED" }),
      task({ task_id: "2", status: "OVERDUE" }),
      task({ task_id: "3", status: "IN_PROGRESS" }),
      task({ task_id: "4", status: "COMPLETED" }),
    ]);

    expect(attentionScore(counts)).toBe(2);
  });
});

describe("orderByAttention", () => {
  it("puts a team whose tasks could not be read first, then the most blocked and overdue", () => {
    const unknown = toEntry({ team: team("TEAM-u", "Unknown crew"), tasks: null });
    const calm = toEntry({
      team: team("TEAM-c", "Calm crew"),
      tasks: [task({ task_id: "1", status: "COMPLETED" })],
    });
    const blocked = toEntry({
      team: team("TEAM-b", "Blocked crew"),
      tasks: [task({ task_id: "2", status: "BLOCKED" }), task({ task_id: "3", status: "OVERDUE" })],
    });
    const overdue = toEntry({
      team: team("TEAM-o", "Overdue crew"),
      tasks: [task({ task_id: "4", status: "OVERDUE" })],
    });

    expect(orderByAttention([calm, overdue, unknown, blocked]).map((e) => e.team.name)).toEqual([
      "Unknown crew",
      "Blocked crew",
      "Overdue crew",
      "Calm crew",
    ]);
  });

  it("breaks an equal score by blocked first, then by name, so the order never depends on the response", () => {
    const oneBlocked = toEntry({
      team: team("TEAM-1", "Zulu crew"),
      tasks: [task({ task_id: "1", status: "BLOCKED" })],
    });
    const oneOverdue = toEntry({
      team: team("TEAM-2", "Alpha crew"),
      tasks: [task({ task_id: "2", status: "OVERDUE" })],
    });
    const alsoOverdue = toEntry({
      team: team("TEAM-3", "Bravo crew"),
      tasks: [task({ task_id: "3", status: "OVERDUE" })],
    });

    expect(
      orderByAttention([alsoOverdue, oneOverdue, oneBlocked]).map((e) => e.team.name),
    ).toEqual(["Zulu crew", "Alpha crew", "Bravo crew"]);
  });

  it("adds up only the teams that answered", () => {
    const answered = toEntry({
      team: team("TEAM-1", "One"),
      tasks: [task({ task_id: "1", status: "BLOCKED" })],
    });
    const unread = toEntry({ team: team("TEAM-2", "Two"), tasks: null });

    expect(totalCounts([answered, unread]).total).toBe(1);
    expect(totalCounts([answered, unread]).blocked).toBe(1);
  });
});

describe("teamAttentionSentence", () => {
  it("names the blocked and overdue counts in words", () => {
    const entry = toEntry({
      team: team("TEAM-1", "One"),
      tasks: [
        task({ task_id: "1", status: "BLOCKED" }),
        task({ task_id: "2", status: "OVERDUE" }),
        task({ task_id: "3", status: "OVERDUE" }),
      ],
    });

    expect(teamAttentionSentence(entry)).toBe("1 blocked and 2 overdue — this team needs you.");
  });

  it("says so when nothing needs a person, and when there is nothing at all", () => {
    const calm = toEntry({
      team: team("TEAM-1", "One"),
      tasks: [task({ task_id: "1", status: "IN_PROGRESS" })],
    });
    const done = toEntry({
      team: team("TEAM-2", "Two"),
      tasks: [task({ task_id: "2", status: "COMPLETED" })],
    });
    const empty = toEntry({ team: team("TEAM-3", "Three"), tasks: [] });
    const unread = toEntry({ team: team("TEAM-4", "Four"), tasks: null });

    expect(teamAttentionSentence(calm)).toBe(
      "Nothing blocked and nothing overdue. CommunityOps is tracking the rest.",
    );
    expect(teamAttentionSentence(done)).toBe("Everything this team was tracking is done.");
    expect(teamAttentionSentence(empty)).toBe("No tasks recorded for this team.");
    expect(teamAttentionSentence(unread)).toBe(
      "CommunityOps couldn't read this team's tasks, so its state is unknown.",
    );
  });
});

describe("task relationships as sentences (requirement 7.5)", () => {
  it("reads depends_on and blocks as sentences, singular and plural", () => {
    expect(dependsOnSentence(task({ task_id: "1", depends_on: ["TSK-9"] }))).toBe(
      "This task is waiting on one other task: TSK-9.",
    );
    expect(dependsOnSentence(task({ task_id: "1", depends_on: ["TSK-9", "TSK-8"] }))).toBe(
      "This task is waiting on 2 other tasks: TSK-9, TSK-8.",
    );
    expect(dependsOnSentence(task({ task_id: "1" }))).toBe("Nothing is holding this task up.");

    expect(blocksSentence(task({ task_id: "1", blocks: ["TSK-3"] }))).toBe(
      "Finishing this unblocks one other task: TSK-3.",
    );
    expect(blocksSentence(task({ task_id: "1" }))).toBe("No other task is waiting on this one.");
  });

  it("reads the escalation ladder in the backend's own terms, and reports a level it does not know", () => {
    expect(escalationLabel(0)).toBe("Not escalated");
    expect(escalationLabel(3)).toBe("Escalated to critical");
    expect(escalationLabel(7)).toBe("Escalated to level 7");
    expect(escalationLabel(-1)).toBe("Escalation not recorded");
  });

  it("lists a team's tasks with the work that needs a person first", () => {
    const ordered = orderTasksByAttention([
      task({ task_id: "done", status: "COMPLETED" }),
      task({ task_id: "low", status: "PENDING", priority: "LOW" }),
      task({ task_id: "overdue", status: "OVERDUE" }),
      task({ task_id: "blocked", status: "BLOCKED", priority: "LOW" }),
    ]);

    expect(ordered.map((entry) => entry.task_id)).toEqual(["blocked", "overdue", "low", "done"]);
  });
});
