/**
 * TeamOps view model — the derivations behind "which team is blocked, and on
 * what?" (requirements 7.4, 7.5, 7.6, design.md §8.3).
 *
 * Kept out of the page for the same reason `src/pages/auditView.ts` is: counting
 * a team's work, ordering teams by how much attention they need and turning a
 * dependency array into a sentence are decisions with right and wrong answers,
 * and they are worth testing without a DOM.
 *
 * Every function here reads only fields declared on `Task` in `src/types.ts`
 * (requirement 16.5), and none of them maps a status to a colour — that table is
 * `StatusBadge`'s alone (requirement 12.5). What they produce is words and
 * numbers.
 */

import { readTableEntry } from "../lib/unknownValue";
import type { Task, Team } from "../types";

/**
 * The buckets a team's work is counted into.
 *
 * Requirement 7.4 names four — blocked, overdue, in progress, completed. The
 * other two exist so the totals add up: a page that shows four counts out of
 * nine tasks and calls it a progress visual is misreporting the remainder.
 */
export type TaskBucket =
  | "blocked"
  | "overdue"
  | "inProgress"
  | "completed"
  | "pending"
  | "cancelled"
  | "unrecognised";

/**
 * Which bucket each declared status counts into. A `Record` over the whole union,
 * so a status added to `src/types.ts` without a bucket here is a compile error; a
 * status the *backend* invents beyond the union is read through `readTableEntry`
 * and counted as `unrecognised`, which is the only honest bucket for a state this
 * console cannot interpret.
 */
const BUCKET_BY_STATUS: Record<Task["status"], TaskBucket> = {
  BACKLOG: "pending",
  PENDING: "pending",
  ASSIGNED: "pending",
  IN_PROGRESS: "inProgress",
  BLOCKED: "blocked",
  REVIEW: "inProgress",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  OVERDUE: "overdue",
};

export type TeamTaskCounts = Readonly<Record<TaskBucket, number>> & {
  /** Every task the team has, whatever state it is in. */
  readonly total: number;
};

const EMPTY_COUNTS: TeamTaskCounts = {
  blocked: 0,
  overdue: 0,
  inProgress: 0,
  completed: 0,
  pending: 0,
  cancelled: 0,
  unrecognised: 0,
  total: 0,
};

export function countTasks(tasks: readonly Task[]): TeamTaskCounts {
  const counts: Record<TaskBucket, number> = {
    blocked: 0,
    overdue: 0,
    inProgress: 0,
    completed: 0,
    pending: 0,
    cancelled: 0,
    unrecognised: 0,
  };

  for (const task of tasks) {
    counts[readTableEntry(BUCKET_BY_STATUS, task.status) ?? "unrecognised"] += 1;
  }

  return { ...counts, total: tasks.length };
}

/**
 * How much of a person's attention this team needs.
 *
 * Blocked and overdue work is the only work on this page that a person has to
 * move: everything else is either progressing or done (design.md §1.1). So the
 * score is those two counts and nothing else — not a weighted index, which would
 * be this page inventing a severity model.
 */
export function attentionScore(counts: TeamTaskCounts): number {
  return counts.blocked + counts.overdue;
}

/** A team plus what is known about its tasks. `null` tasks means "not loaded". */
export interface TeamBoardRow {
  readonly team: Team;
  readonly tasks: readonly Task[] | null;
}

/** A row with its counts resolved, which is what the page renders. */
export interface TeamBoardEntry extends TeamBoardRow {
  /** `null` when this team's task list could not be read. */
  readonly counts: TeamTaskCounts | null;
  readonly attention: number;
}

/**
 * Resolve a row's counts.
 *
 * Generic over the row so a caller's own fields — the reported failure for that
 * team's task request, say — survive the derivation with their types intact and
 * do not have to be looked up again alongside the result.
 */
export function toEntry<Row extends TeamBoardRow>(
  row: Row,
): Row & { readonly counts: TeamTaskCounts | null; readonly attention: number } {
  const counts = row.tasks === null ? null : countTasks(row.tasks);

  return { ...row, counts, attention: counts === null ? 0 : attentionScore(counts) };
}

/**
 * Teams ordered by attention needed (requirement 7.4).
 *
 *   1. A team whose task list could not be read comes first. Its state is
 *      unknown, and an unknown state is not a healthy one — sorting it to the
 *      bottom would hide the one team nobody can see.
 *   2. Then the most blocked-and-overdue work.
 *   3. Then blocked before overdue at the same total, because a blocked team is
 *      the one this page exists to unblock.
 *   4. Then the most unfinished work.
 *   5. Then name, so the order never depends on response order.
 */
export function orderByAttention<Entry extends TeamBoardEntry>(
  entries: readonly Entry[],
): readonly Entry[] {
  return [...entries].sort((left, right) => {
    const unknown = Number(right.counts === null) - Number(left.counts === null);
    if (unknown !== 0) return unknown;

    if (right.attention !== left.attention) return right.attention - left.attention;

    const blocked = (right.counts?.blocked ?? 0) - (left.counts?.blocked ?? 0);
    if (blocked !== 0) return blocked;

    const openRight = (right.counts?.total ?? 0) - (right.counts?.completed ?? 0);
    const openLeft = (left.counts?.total ?? 0) - (left.counts?.completed ?? 0);
    if (openRight !== openLeft) return openRight - openLeft;

    return left.team.name.localeCompare(right.team.name);
  });
}

/** The counts of every loaded team added together, for the page's one visual. */
export function totalCounts(entries: readonly TeamBoardEntry[]): TeamTaskCounts {
  return entries.reduce<TeamTaskCounts>((running, entry) => {
    if (entry.counts === null) {
      return running;
    }

    const counts = entry.counts;

    return {
      blocked: running.blocked + counts.blocked,
      overdue: running.overdue + counts.overdue,
      inProgress: running.inProgress + counts.inProgress,
      completed: running.completed + counts.completed,
      pending: running.pending + counts.pending,
      cancelled: running.cancelled + counts.cancelled,
      unrecognised: running.unrecognised + counts.unrecognised,
      total: running.total + counts.total,
    };
  }, EMPTY_COUNTS);
}

/**
 * Why this team is on screen, in one sentence built from its own counts.
 *
 * The sentence is the page's answer to its own question, so it states the
 * blocked and overdue counts in words — which is also what keeps those two
 * states off colour alone (requirements 7.6, 15.10).
 */
export function teamAttentionSentence(entry: TeamBoardEntry): string {
  const counts = entry.counts;

  if (counts === null) {
    return "CommunityOps couldn't read this team's tasks, so its state is unknown.";
  }

  if (counts.total === 0) {
    return "No tasks recorded for this team.";
  }

  const parts: string[] = [];
  if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
  if (counts.overdue > 0) parts.push(`${counts.overdue} overdue`);

  if (parts.length === 0) {
    return counts.completed === counts.total
      ? "Everything this team was tracking is done."
      : "Nothing blocked and nothing overdue. CommunityOps is tracking the rest.";
  }

  return `${joinWords(parts)} — this team needs you.`;
}

/** "a", "a and b", "a, b and c". */
function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) {
    return parts[0] ?? "";
  }

  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
}

/**
 * Tasks in the order the drawer lists them: the work that needs a person first,
 * then by priority, then by identifier so the order is stable.
 */
const PRIORITY_RANK: Record<Task["priority"], number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

const STATUS_RANK: Record<Task["status"], number> = {
  BLOCKED: 0,
  OVERDUE: 1,
  IN_PROGRESS: 2,
  REVIEW: 2,
  ASSIGNED: 3,
  PENDING: 3,
  BACKLOG: 4,
  COMPLETED: 5,
  CANCELLED: 6,
};

/** Unknown values sort after everything the console understands. */
const UNRANKED = 9;

export function orderTasksByAttention(tasks: readonly Task[]): readonly Task[] {
  return [...tasks].sort((left, right) => {
    const status =
      (readTableEntry(STATUS_RANK, left.status) ?? UNRANKED) -
      (readTableEntry(STATUS_RANK, right.status) ?? UNRANKED);
    if (status !== 0) return status;

    const priority =
      (readTableEntry(PRIORITY_RANK, left.priority) ?? UNRANKED) -
      (readTableEntry(PRIORITY_RANK, right.priority) ?? UNRANKED);
    if (priority !== 0) return priority;

    return left.task_id.localeCompare(right.task_id);
  });
}

/**
 * `depends_on` as a sentence (requirement 7.5).
 *
 * The identifiers are named because they are what the reader has to go and look
 * at, and they are real values from the record — the sentence around them is what
 * makes the relationship readable instead of a bare array.
 */
export function dependsOnSentence(task: Task): string {
  const ids = task.depends_on;

  if (ids.length === 0) {
    return "Nothing is holding this task up.";
  }

  const subject = ids.length === 1 ? "one other task" : `${ids.length} other tasks`;

  return `This task is waiting on ${subject}: ${ids.join(", ")}.`;
}

/** `blocks` as a sentence (requirement 7.5). */
export function blocksSentence(task: Task): string {
  const ids = task.blocks;

  if (ids.length === 0) {
    return "No other task is waiting on this one.";
  }

  const subject = ids.length === 1 ? "one other task" : `${ids.length} other tasks`;

  return `Finishing this unblocks ${subject}: ${ids.join(", ")}.`;
}

/**
 * The escalation ladder, in the backend's own words.
 *
 * `services/shared/models/team.py` documents `escalation_level` as
 * "0=normal, 1=attention, 2=warning, 3=critical" and constrains it to that
 * range. These are those four rungs as text; a value outside the range is
 * reported as the number rather than guessed at.
 */
const ESCALATION_LABELS: readonly string[] = [
  "Not escalated",
  "Escalated once — flagged for attention",
  "Escalated twice — warning",
  "Escalated to critical",
];

export function escalationLabel(level: number): string {
  if (!Number.isInteger(level) || level < 0) {
    return "Escalation not recorded";
  }

  return ESCALATION_LABELS[level] ?? `Escalated to level ${level}`;
}

/** Priority as words. A ranking, not a status and not a risk — so, no colour. */
export const PRIORITY_LABELS: Record<Task["priority"], string> = {
  CRITICAL: "Critical priority",
  HIGH: "High priority",
  MEDIUM: "Medium priority",
  LOW: "Low priority",
};

/** Who holds this task. `assigned_to` is `""` on an unassigned task. */
export function assigneeLabel(task: Task): string {
  return task.assigned_to.trim() === "" ? "Not assigned to anyone yet" : task.assigned_to;
}
