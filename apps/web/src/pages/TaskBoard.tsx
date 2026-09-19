/**
 * TeamOps — "Which team is blocked, and on what?" (design.md §8.3,
 * requirement 7).
 *
 * The page this replaces was a task board: a four-metric stat wall, a row of
 * team filter buttons and one flat table of every task. It answered "here are 47
 * tasks", which is not the question a community leader arrives with — they arrive
 * wanting to know which team to go and help. So teams are the structure, and a
 * task is something you reach from a team (requirement 7.1).
 *
 * **Where team identity comes from.** The old page held six team ids in source
 * and issued one request per id. That made this console the author of the
 * organization's team structure: a team the organization does not have appeared
 * on screen, and a team it does have could not. Every identifier this page uses
 * now comes from `GET /events/{eventId}/teams` (requirement 7.2), and the
 * per-team task requests fan out over exactly the directory that returned —
 * never over a list written here.
 *
 * **What ships today.** That route does not exist yet (design.md A5). So the
 * board is written against the specified contract and degrades to a single honest
 * state — "Team directory unavailable" — until it lands (requirement 7.3). The
 * degradation is deliberate and total: with no directory there are no team cards,
 * no counts and no fabricated names, because there is nothing real to show.
 *
 * **Colour.** `StatusBadge` owns the status-to-colour table (requirement 12.5).
 * This page maps nothing to a colour of its own: every count, every segment of
 * the one progress visual and every card carries its state in words
 * (requirements 7.6, 15.10). Priority is neither a status nor a risk — a
 * HIGH-priority task is not a high *risk* — so it renders as text with weight,
 * and is deliberately not routed through `StatusBadge` and not given a badge
 * colour of its own.
 */

import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { getTasks } from "../api";
import { ApiErrorState } from "../components/ApiErrorState";
import { DistributionBar } from "../components/DistributionBar";
import { Drawer } from "../components/Drawer";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { SkeletonCard } from "../components/Skeleton";
import { StatusBadge } from "../components/StatusBadge";
import type { EventScopedPageProps } from "../event/EventScopedView";
import { formatAbsoluteTime, formatRelativeTime, toMachineTime } from "../lib/formatTime";
import { useApiFailure, type ReportApiFailure } from "../session/useApiFailure";
import { loadTeamDirectory } from "../teamDirectory";
import { updateTask, type TaskUpdate } from "../taskUpdate";
import type { Task, Team } from "../types";
import {
  assigneeLabel,
  blocksSentence,
  dependsOnSentence,
  escalationLabel,
  orderByAttention,
  orderTasksByAttention,
  PRIORITY_LABELS,
  teamAttentionSentence,
  toEntry,
  totalCounts,
  type TeamBoardEntry,
  type TeamTaskCounts,
} from "./teamBoard";
import "./TaskBoard.css";

/** Requirement 7.7, verbatim. */
const NO_TASKS_LINE = "No tasks recorded for this team.";

/** Requirement 7.3 — the state that ships until the team directory exists. */
const UNAVAILABLE_TITLE = "Team directory unavailable";

/**
 * One team, and whatever its task request produced. A team whose tasks failed is
 * still a real team, so it keeps its card and states that its tasks are unread.
 */
interface TeamTasks {
  readonly team: Team;
  readonly tasks: readonly Task[] | null;
  /** Reported failure for this team's tasks, or `null` when there is none. */
  readonly failure: unknown;
}

/** A team with its counts resolved, carrying its own task-request failure. */
type BoardEntry = TeamBoardEntry & { readonly failure: unknown };

type BoardState =
  | { readonly kind: "loading" }
  /**
   * No team directory. `failure` is the reported failure when the request itself
   * failed, and `null` when it answered with no directory at all — which is what
   * happens today, and is not something a retry can fix.
   */
  | { readonly kind: "unavailable"; readonly failure: unknown }
  | { readonly kind: "ready"; readonly teams: readonly TeamTasks[] };

/** Where a change is in its lifecycle (requirement 13.11). */
type SaveState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
  | { readonly kind: "failed"; readonly failure: unknown };

/** The editable fields, as the form holds them while the user is typing. */
interface TaskDraft {
  readonly status: Task["status"];
  readonly priority: Task["priority"];
  readonly assigned_to: string;
  readonly escalation_level: number;
}

const STATUS_OPTION_LABELS: Record<Task["status"], string> = {
  PENDING: "Pending",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  OVERDUE: "Overdue",
};

const STATUS_OPTIONS = Object.keys(STATUS_OPTION_LABELS) as readonly Task["status"][];
const PRIORITY_OPTIONS = Object.keys(PRIORITY_LABELS) as readonly Task["priority"][];

/** The escalation rungs the backend model allows (0–3). */
const ESCALATION_OPTIONS = [0, 1, 2, 3] as const;

function asTaskStatus(value: string): Task["status"] | null {
  return STATUS_OPTIONS.find((status) => status === value) ?? null;
}

function asTaskPriority(value: string): Task["priority"] | null {
  return PRIORITY_OPTIONS.find((priority) => priority === value) ?? null;
}

function asEscalationLevel(value: string): number | null {
  return ESCALATION_OPTIONS.find((level) => String(level) === value) ?? null;
}

function draftOf(task: Task): TaskDraft {
  return {
    status: task.status,
    priority: task.priority,
    assigned_to: task.assigned_to,
    escalation_level: task.escalation_level,
  };
}

/** Only what the user actually changed, so an untouched field is never sent. */
function changesIn(task: Task, draft: TaskDraft): TaskUpdate {
  const changes: TaskUpdate = {};

  if (draft.status !== task.status) changes.status = draft.status;
  if (draft.priority !== task.priority) changes.priority = draft.priority;
  if (draft.assigned_to !== task.assigned_to) changes.assigned_to = draft.assigned_to;
  if (draft.escalation_level !== task.escalation_level) {
    changes.escalation_level = draft.escalation_level;
  }

  return changes;
}

/**
 * One team's tasks. Never rejects: a team that could not be read is a card that
 * says so, not a page that disappears (requirement 13.8).
 */
function fetchTeamTasks(
  eventId: string,
  team: Team,
  report: ReportApiFailure,
): Promise<TeamTasks> {
  return getTasks(eventId, team.team_id).then(
    (response) => ({
      team,
      // The declared response shape is asserted rather than validated, so an
      // answer carrying no array is treated as unread rather than rendered as
      // "zero tasks" — which would be a claim this console cannot support.
      tasks: Array.isArray(response.tasks) ? response.tasks : null,
      failure: null,
    }),
    (error: unknown) => ({ team, tasks: null, failure: report(error) }),
  );
}

/** The due date as relative age, with the absolute time available on hover. */
function DueDate({ task }: { task: Task }) {
  if (task.due_date.trim() === "") {
    return <>No due date set</>;
  }

  const machine = toMachineTime(task.due_date);
  const absolute = formatAbsoluteTime(task.due_date);

  return (
    <time dateTime={machine ?? undefined} title={absolute}>
      {formatRelativeTime(task.due_date)} ({absolute})
    </time>
  );
}

/**
 * The supplementary text §6.4 asks of two statuses: the blocking reason beside
 * "Blocked", the relative age beside "Overdue". Both are built from modelled
 * fields, and `undefined` elsewhere so no other status gains a detail it has no
 * value for.
 */
function statusDetail(task: Task): string | undefined {
  if (task.status === "BLOCKED") {
    return task.depends_on.length === 0
      ? "No blocking task recorded"
      : `Waiting on ${task.depends_on.join(", ")}`;
  }

  if (task.status === "OVERDUE" && task.due_date.trim() !== "") {
    return `Due ${formatRelativeTime(task.due_date)}`;
  }

  return undefined;
}

export function TaskBoard({ eventId }: EventScopedPageProps) {
  const report = useApiFailure();

  const [state, setState] = useState<BoardState>({ kind: "loading" });
  const [openTeamId, setOpenTeamId] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  const statusFieldId = useId();
  const priorityFieldId = useId();
  const assigneeFieldId = useId();
  const escalationFieldId = useId();

  const load = useCallback(() => {
    setState({ kind: "loading" });

    loadTeamDirectory(eventId).then(
      (directory) => {
        if (directory.kind === "absent") {
          // The contract answered with no directory. Nothing to retry — this is
          // the state A5 describes, and it is what ships until the route exists.
          setState({ kind: "unavailable", failure: null });
          return;
        }

        // The fan-out is bounded by the directory the API returned. This is the
        // only place team ids enter a request, and they all came from one response.
        Promise.all(directory.teams.map((team) => fetchTeamTasks(eventId, team, report))).then(
          (teams) => {
            setState({ kind: "ready", teams });
          },
        );
      },
      (error: unknown) => {
        setState({ kind: "unavailable", failure: report(error) });
      },
    );
  }, [eventId, report]);

  useEffect(load, [load]);

  const entries = useMemo<readonly BoardEntry[]>(
    () => (state.kind === "ready" ? orderByAttention(state.teams.map(toEntry)) : []),
    [state],
  );

  const totals = useMemo(() => totalCounts(entries), [entries]);

  const openTeam = useMemo<TeamTasks | null>(
    () =>
      state.kind === "ready"
        ? state.teams.find((entry) => entry.team.team_id === openTeamId) ?? null
        : null,
    [state, openTeamId],
  );

  const openTasks = useMemo<readonly Task[]>(() => {
    const tasks = openTeam === null ? null : openTeam.tasks;

    return tasks === null ? [] : orderTasksByAttention(tasks);
  }, [openTeam]);

  const openTask = useMemo<Task | null>(
    () => openTasks.find((task) => task.task_id === openTaskId) ?? null,
    [openTasks, openTaskId],
  );

  const closeDrawer = useCallback(() => {
    setOpenTeamId(null);
    setOpenTaskId(null);
    setDraft(null);
    setSave({ kind: "idle" });
  }, []);

  const editTask = useCallback((task: Task) => {
    setOpenTaskId(task.task_id);
    setDraft(draftOf(task));
    setSave({ kind: "idle" });
  }, []);

  const editDraft = useCallback((change: Partial<TaskDraft>) => {
    setDraft((current) => (current === null ? current : { ...current, ...change }));
    setSave((current) => (current.kind === "saving" ? current : { kind: "idle" }));
  }, []);

  const pendingChanges = useMemo<TaskUpdate>(
    () => (openTask === null || draft === null ? {} : changesIn(openTask, draft)),
    [openTask, draft],
  );
  const hasChanges = Object.keys(pendingChanges).length > 0;

  const submitChanges = useCallback(() => {
    if (openTeam === null || openTask === null || !hasChanges) {
      return;
    }

    const teamId = openTeam.team.team_id;
    const taskId = openTask.task_id;
    setSave({ kind: "saving" });

    updateTask(eventId, teamId, taskId, pendingChanges).then(
      () => {
        // The endpoint acknowledges rather than returning the record, so the task
        // is updated from the change that was accepted — never from a value this
        // page guessed at (requirement 7.8).
        setState((current) => {
          if (current.kind !== "ready") return current;

          return {
            kind: "ready",
            teams: current.teams.map((entry) =>
              entry.team.team_id !== teamId || entry.tasks === null
                ? entry
                : {
                    ...entry,
                    tasks: entry.tasks.map((task) =>
                      task.task_id === taskId ? { ...task, ...pendingChanges } : task,
                    ),
                  },
            ),
          };
        });
        setSave({ kind: "saved" });
      },
      (error: unknown) => {
        const reported = report(error, { refresh: load });
        setSave(reported === null ? { kind: "idle" } : { kind: "failed", failure: reported });
      },
    );
  }, [eventId, hasChanges, load, openTask, openTeam, pendingChanges, report]);

  const attentionTeams = entries.filter((entry) => entry.attention > 0).length;

  return (
    <div className="page team-ops">
      <PageHeader
        title="TeamOps"
        context={
          state.kind === "ready"
            ? `${attentionTeams} of ${entries.length} teams need you. CommunityOps is tracking the rest.`
            : "Which team is blocked, and on what."
        }
      />

      {state.kind === "loading" && (
        <SkeletonCard lines={3} label="Getting the latest team state…" />
      )}

      {state.kind === "unavailable" && (
        <TeamDirectoryUnavailable failure={state.failure} onRetry={load} />
      )}

      {state.kind === "ready" && entries.length === 0 && (
        <EmptyState
          title="No teams recorded for this event."
          description="Task tracking starts once this event has a team."
        />
      )}

      {state.kind === "ready" && entries.length > 0 && (
        <>
          <WorkProgress counts={totals} />

          <ul className="team-cards">
            {entries.map((entry) => (
              <li key={entry.team.team_id}>
                <TeamCard
                  entry={entry}
                  onOpen={() => {
                    setOpenTeamId(entry.team.team_id);
                    setOpenTaskId(null);
                    setDraft(null);
                    setSave({ kind: "idle" });
                  }}
                  onRetry={load}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      {openTeam !== null && (
        <Drawer
          open
          onClose={closeDrawer}
          title={openTeam.team.name}
          description={
            openTeam.tasks === null
              ? "CommunityOps couldn't read this team's tasks."
              : `${openTeam.tasks.length === 0 ? "No" : openTeam.tasks.length} ${
                  openTeam.tasks.length === 1 ? "task" : "tasks"
                } tracked for this team.`
          }
        >
          {openTeam.tasks === null && <p className="team-task__note">{NO_TASKS_LINE}</p>}

          {openTeam.tasks !== null && openTasks.length === 0 && (
            <EmptyState title={NO_TASKS_LINE} />
          )}

          {openTasks.length > 0 && (
            <ul className="team-tasks">
              {openTasks.map((task) => (
                <li className="team-task" key={task.task_id}>
                  <h3 className="team-task__title">{task.title}</h3>

                  <StatusBadge domain="task" status={task.status} detail={statusDetail(task)} />

                  {/* Priority is a ranking, so it is weighted text rather than a
                      colour: the amber and the red in the token set are spoken
                      for by attention and CRITICAL severity (design.md §6.4). */}
                  <p className="team-task__priority" data-priority={task.priority}>
                    {PRIORITY_LABELS[task.priority]}
                  </p>

                  <dl className="team-task__facts">
                    <div className="team-task__fact">
                      <dt>Assignee</dt>
                      <dd>{assigneeLabel(task)}</dd>
                    </div>
                    <div className="team-task__fact">
                      <dt>Due</dt>
                      <dd>
                        <DueDate task={task} />
                      </dd>
                    </div>
                    <div className="team-task__fact">
                      <dt>Escalation</dt>
                      <dd>{escalationLabel(task.escalation_level)}</dd>
                    </div>
                  </dl>

                  {/* Requirement 7.5: the two dependency relationships as
                      sentences, not as arrays of identifiers. */}
                  <p className="team-task__relationship">{dependsOnSentence(task)}</p>
                  <p className="team-task__relationship">{blocksSentence(task)}</p>

                  {openTaskId === task.task_id && draft !== null ? (
                    <form
                      className="team-task__form"
                      aria-label={`Record a change to ${task.title}`}
                      onSubmit={(formEvent) => {
                        formEvent.preventDefault();
                        submitChanges();
                      }}
                    >
                      {/* One `disabled` on the group locks every related control
                          while the change is in flight (requirement 13.11). */}
                      <fieldset
                        className="form-fields"
                        disabled={save.kind === "saving"}
                      >
                        <legend className="form-legend">
                          Only the fields CommunityOps can hand to the task record.
                        </legend>

                        <div className="form-field">
                          <label className="form-label" htmlFor={statusFieldId}>Task status</label>
                          <select
                            className="input"
                            id={statusFieldId}
                            value={draft.status}
                            onChange={(changeEvent) => {
                              const status = asTaskStatus(changeEvent.target.value);
                              if (status !== null) editDraft({ status });
                            }}
                          >
                            {STATUS_OPTIONS.map((status) => (
                              <option key={status} value={status}>
                                {STATUS_OPTION_LABELS[status]}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="form-field">
                          <label className="form-label" htmlFor={priorityFieldId}>Priority</label>
                          <select
                            className="input"
                            id={priorityFieldId}
                            value={draft.priority}
                            onChange={(changeEvent) => {
                              const priority = asTaskPriority(changeEvent.target.value);
                              if (priority !== null) editDraft({ priority });
                            }}
                          >
                            {PRIORITY_OPTIONS.map((priority) => (
                              <option key={priority} value={priority}>
                                {PRIORITY_LABELS[priority]}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="form-field">
                          <label className="form-label" htmlFor={assigneeFieldId}>Assignee</label>
                          <input
                            className="input"
                            id={assigneeFieldId}
                            type="text"
                            value={draft.assigned_to}
                            onChange={(changeEvent) => {
                              editDraft({ assigned_to: changeEvent.target.value });
                            }}
                          />
                        </div>

                        <div className="form-field">
                          <label className="form-label" htmlFor={escalationFieldId}>Escalation</label>
                          <select
                            className="input"
                            id={escalationFieldId}
                            value={String(draft.escalation_level)}
                            onChange={(changeEvent) => {
                              const level = asEscalationLevel(changeEvent.target.value);
                              if (level !== null) editDraft({ escalation_level: level });
                            }}
                          >
                            {ESCALATION_OPTIONS.map((level) => (
                              <option key={level} value={String(level)}>
                                {escalationLabel(level)}
                              </option>
                            ))}
                          </select>
                        </div>
                      </fieldset>

                      {/* The action row is replaced by the result in place, and
                          the result is announced politely (requirements 13.11,
                          15.7). */}
                      <div className="form-actions" role="status">
                        {save.kind === "saved" ? (
                          <p className="form-result">
                            Change saved. This task is up to date.
                          </p>
                        ) : (
                          <button
                            type="submit"
                            className="btn btn-primary"
                            disabled={save.kind === "saving" || !hasChanges}
                          >
                            {save.kind === "saving" ? "Saving…" : "Save change"}
                          </button>
                        )}
                      </div>

                      {save.kind === "failed" && (
                        <ApiErrorState error={save.failure} context="action" />
                      )}
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => editTask(task)}
                      aria-label={`Record a change to ${task.title}`}
                    >
                      Record a change
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Drawer>
      )}
    </div>
  );
}

/**
 * Requirement 7.3 — what ships until `GET /events/{eventId}/teams` exists
 * (design.md A5).
 *
 * It names the missing capability in product language rather than as a request
 * path, states that task data is reachable the moment a team directory exists,
 * and shows no team: an invented team list is the defect this state replaces.
 * When the request *failed* rather than answered without a directory, the shared
 * failure surface is rendered underneath so a retry is available for the case a
 * retry could fix.
 */
function TeamDirectoryUnavailable({
  failure,
  onRetry,
}: {
  failure: unknown;
  onRetry: () => void;
}) {
  const headingId = useId();

  return (
    <section className="team-unavailable" aria-labelledby={headingId}>
      <h2 className="team-unavailable__title" id={headingId}>
        {UNAVAILABLE_TITLE}
      </h2>

      <p className="team-unavailable__line">
        CommunityOps has no way to ask this event which teams it has. Tasks are
        reachable one team at a time, but nothing yet answers with the team
        directory this page is built on.
      </p>

      <p className="team-unavailable__line">
        Once a team directory exists for this event, every team&apos;s blocked,
        overdue, in-progress and completed work appears here. The console holds no
        team list of its own, so it will show your teams and only your teams.
      </p>

      {failure !== null && <ApiErrorState error={failure} onRetry={onRetry} />}
    </section>
  );
}

/** One segment of the page's single progress visual. */
interface ProgressSegment {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  /** Blocked and overdue get the hatched fill as well as the label. */
  readonly hatch: "blocked" | "overdue" | null;
}

function segmentsOf(counts: TeamTaskCounts): readonly ProgressSegment[] {
  return [
    { id: "blocked", label: "Blocked", count: counts.blocked, hatch: "blocked" },
    { id: "overdue", label: "Overdue", count: counts.overdue, hatch: "overdue" },
    { id: "in-progress", label: "In progress", count: counts.inProgress, hatch: null },
    { id: "pending", label: "Not started", count: counts.pending, hatch: null },
    { id: "completed", label: "Completed", count: counts.completed, hatch: null },
    { id: "cancelled", label: "Cancelled", count: counts.cancelled, hatch: null },
    { id: "unrecognised", label: "State unavailable", count: counts.unrecognised, hatch: null },
  ];
}

/**
 * The page's one contextual visual (requirement 12.10): how this event's work is
 * distributed, composed from the real counts of every team that answered.
 *
 * The bar, the legend and the text alternative are the shared `DistributionBar`,
 * the same component SpeakerOps and IncidentOps draw theirs with; the seven fills
 * live in `TaskBoard.css`, keyed off `data-segment`.
 *
 * Blocked and overdue carry a text label *and* a hatched fill, so neither is ever
 * distinguished by colour alone (requirements 7.6, 15.10). The hatches are this
 * page's, passed to the bar as `defs` and referenced per segment — the only thing
 * that makes this visual differ from the other two, and it is a texture rather
 * than a treatment.
 */
function WorkProgress({ counts }: { counts: TeamTaskCounts }) {
  const headingId = useId();
  const blockedHatchId = useId();
  const overdueHatchId = useId();
  const segments = segmentsOf(counts).filter((segment) => segment.count > 0);

  if (counts.total === 0) {
    return null;
  }

  const hatchIds: Record<"blocked" | "overdue", string> = {
    blocked: blockedHatchId,
    overdue: overdueHatchId,
  };

  const sentence = `${counts.total} ${counts.total === 1 ? "task" : "tasks"} across your teams: ${segments
    .map((segment) => `${segment.count} ${segment.label.toLowerCase()}`)
    .join(", ")}.`;

  return (
    <DistributionBar
      heading="Where the work stands"
      headingId={headingId}
      segments={segments.map((segment) => ({
        id: segment.id,
        label: segment.label,
        count: segment.count,
        fill: segment.hatch === null ? undefined : `url(#${hatchIds[segment.hatch]})`,
      }))}
      sentence={sentence}
      defs={
        // Two hatches, so the two states that need a person are told apart by
        // texture as well as by their label.
        <>
          <Hatch id={blockedHatchId} variant="blocked" />
          <Hatch id={overdueHatchId} variant="overdue" />
        </>
      }
    />
  );
}

/**
 * A diagonal hatch, referenced by the blocked and overdue segments.
 *
 * The two fills are CSS classes on the shapes, so the only values in this
 * component are the geometry of the tile in the bar's own user space.
 */
function Hatch({ id, variant }: { id: string; variant: "blocked" | "overdue" }) {
  return (
    <pattern
      id={id}
      width={2}
      height={2}
      patternUnits="userSpaceOnUse"
      patternTransform="rotate(45)"
    >
      <rect className="team-hatch__field" data-segment={variant} width={2} height={2} />
      <rect className="team-hatch__line" data-segment={variant} width={1} height={2} />
    </pattern>
  );
}

/**
 * One team, with the four counts requirement 7.4 names and the sentence that
 * says why it is where it is in the order.
 *
 * Every count is a number beside its own word. There is no per-team bar: a page
 * renders at most one contextual visual (requirement 12.10), and that one is
 * `WorkProgress` above.
 */
function TeamCard({
  entry,
  onOpen,
  onRetry,
}: {
  entry: BoardEntry;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const headingId = useId();
  const counts = entry.counts;

  return (
    <section className="card team-card" aria-labelledby={headingId}>
      <div className="team-card__header">
        <h2 className="team-card__name" id={headingId}>
          {entry.team.name}
        </h2>
        {entry.team.is_active ? null : (
          <p className="team-card__note">This team is no longer active.</p>
        )}
      </div>

      <p className="team-card__sentence">{teamAttentionSentence(entry)}</p>

      {counts !== null && counts.total > 0 && (
        <dl className="team-card__counts">
          {[
            { id: "blocked", label: "Blocked", count: counts.blocked, attention: true },
            { id: "overdue", label: "Overdue", count: counts.overdue, attention: true },
            { id: "in-progress", label: "In progress", count: counts.inProgress, attention: false },
            { id: "completed", label: "Completed", count: counts.completed, attention: false },
          ].map((metric) => (
            <div
              className="team-card__count"
              data-attention={metric.attention ? "true" : "false"}
              key={metric.id}
            >
              <dt>{metric.label}</dt>
              <dd>{metric.count}</dd>
            </div>
          ))}
        </dl>
      )}

      {entry.failure !== null && <ApiErrorState error={entry.failure} onRetry={onRetry} />}

      {/* "View details" is the glossary term for opening a record's full data
          (design.md §15.2), and it is what SpeakerOps and IncidentOps put on the
          same affordance. The accessible name names the team, so a screen-reader
          user tabbing the card grid is not offered a column of identical buttons
          — the same shape `DataTable`'s row action takes. */}
      <button
        type="button"
        className="btn btn-sm"
        onClick={onOpen}
        aria-label={`View details for ${entry.team.name}`}
      >
        View details
      </button>
    </section>
  );
}
