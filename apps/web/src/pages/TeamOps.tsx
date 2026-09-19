/**
 * TeamOps.
 *
 * Answers: which teams are healthy, blocked or drifting? Opens with team-level state, not a task
 * dump — a flat list of thirty tasks makes the leader do the grouping themselves, which is the work
 * being removed.
 *
 * Teams needing attention are foregrounded; healthy teams collapse to a single line. Selecting a team
 * reveals its tasks.
 *
 * Every figure — open, overdue, blocked, progress, workload per member, risk — is computed by the
 * backend from one event snapshot, so these numbers match the Command Center's.
 */

import { useCallback, useEffect, useState } from "react";

import { ApiError, getEventTasks, getTeams, getWorkload, updateTask } from "../api";
import {
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  Progress,
  SeverityBadge,
  Stat,
  Section,
  StatusBadge,
} from "../components/primitives";
import type { MemberWorkload, Role, Task, TeamSummary } from "../types";

/** Statuses a team member may set on their own task. Matches the backend's whitelist. */
const MEMBER_STATUSES = ["IN_PROGRESS", "REVIEW", "COMPLETED", "BLOCKED"] as const;

export function TeamOpsPage({ eventId, role }: { eventId: string; role: Role }) {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workload, setWorkload] = useState<MemberWorkload[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [selectedTeam, setSelectedTeam] = useState<TeamSummary | null>(null);
  const [updating, setUpdating] = useState<string | undefined>();
  const [updateError, setUpdateError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      // One request per concern rather than one per team: the event-wide task route replaced the
      // previous fan-out of one call per team flattened in the browser.
      const [teamResponse, taskResponse, workloadResponse] = await Promise.all([
        getTeams(eventId),
        getEventTasks(eventId),
        getWorkload(eventId).catch(() => null),
      ]);
      setTeams(teamResponse.teams);
      setTasks(taskResponse.tasks);
      setWorkload(workloadResponse?.members ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load teams.");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(task: Task, status: string) {
    setUpdating(task.task_id);
    setUpdateError(undefined);
    try {
      await updateTask(eventId, task.team_id, task.task_id, {
        status: status as Task["status"],
        // The backend refuses BLOCKED without a reason, so one is always supplied.
        ...(status === "BLOCKED" ? { blocked_reason: "Blocked from the team board" } : {}),
      });
      await load();
    } catch (err) {
      setUpdateError(
        err instanceof ApiError ? err.message : "The task could not be updated.",
      );
    } finally {
      setUpdating(undefined);
    }
  }

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  const needsAttention = teams.filter((t) => t.risk !== "LOW" || t.overdue_tasks > 0);
  const healthy = teams.filter((t) => !needsAttention.includes(t));

  const overdue = tasks.filter((t) => t.is_overdue);
  const blocked = tasks.filter((t) => t.status === "BLOCKED");
  const overloaded = workload.filter((m) => m.user_id && m.open_tasks >= 6);

  const teamTasks = selectedTeam
    ? tasks.filter((t) => t.team_id === selectedTeam.team_id)
    : [];

  return (
    <div>
      <PageHeader
        title="TeamOps"
        subtitle="Team coordination. Only teams needing attention are expanded — the rest are moving."
      />

      <div className="stat-grid" style={{ marginBottom: "var(--s5)" }}>
        <Stat
          value={needsAttention.length}
          label="Teams needing attention"
          tone={needsAttention.length > 0 ? "at-risk" : undefined}
          note={`of ${teams.length}`}
        />
        <Stat
          value={overdue.length}
          label="Overdue tasks"
          tone={overdue.length > 0 ? "overdue" : undefined}
        />
        <Stat
          value={blocked.length}
          label="Blocked tasks"
          tone={blocked.length > 0 ? "blocked" : undefined}
        />
        <Stat value={tasks.filter((t) => t.status === "COMPLETED").length} label="Completed" />
      </div>

      {updateError && (
        <div style={{ marginBottom: "var(--s4)" }}>
          <Notice tone="error">{updateError}</Notice>
        </div>
      )}

      {overloaded.length > 0 && (
        <div style={{ marginBottom: "var(--s4)" }}>
          <Notice tone="warn">
            {overloaded
              .slice(0, 3)
              .map((m) => `${m.display_name} (${m.open_tasks} open)`)
              .join(", ")}{" "}
            {overloaded.length === 1 ? "is" : "are"} carrying an unusual amount. Ask CommunityOps to
            recommend a rebalance — it compares real task counts.
          </Notice>
        </div>
      )}

      {needsAttention.length === 0 ? (
        <EmptyState
          title="Every team is on track"
          body="No overdue work, nothing blocked, and no team carrying disproportionate load."
        />
      ) : (
        <Section title="Needs attention">
          <div className="stack">
            {needsAttention.map((team) => (
              <Card
                key={team.team_id}
                title={team.name}
                action={
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={() => setSelectedTeam(team)}
                  >
                    View tasks
                  </button>
                }
              >
                <div className="cluster" style={{ marginBottom: "var(--s3)", gap: "var(--s3)" }}>
                  {team.overdue_tasks > 0 && (
                    <span className="badge badge-overdue">{team.overdue_tasks} overdue</span>
                  )}
                  {team.blocked_tasks > 0 && (
                    <span className="badge badge-blocked">{team.blocked_tasks} blocked</span>
                  )}
                  <span className="badge badge-outline">
                    {team.open_tasks} open of {team.total_tasks}
                  </span>
                  {team.member_count > 0 && (
                    <span className="t-meta">
                      {team.member_count} member{team.member_count === 1 ? "" : "s"} ·{" "}
                      {team.workload_per_member} open each
                    </span>
                  )}
                </div>
                <Progress
                  percent={team.progress_percent}
                  tone={team.overdue_tasks > 0 ? "at-risk" : "normal"}
                />
                <div className="cluster-between" style={{ marginTop: "var(--s2)" }}>
                  <span className="t-meta">{team.progress_percent}% complete</span>
                  <span className="t-meta">
                    {team.lead_name ? `Lead: ${team.lead_name}` : "No lead assigned"}
                  </span>
                </div>
              </Card>
            ))}
          </div>
        </Section>
      )}

      {healthy.length > 0 && (
        <Section title={`On track (${healthy.length})`}>
          <Card padding="flush">
            <ul className="rows">
              {healthy.map((team) => (
                <li key={team.team_id}>
                  <button className="row" type="button" onClick={() => setSelectedTeam(team)}>
                    <div className="row-main">
                      <div className="row-title">{team.name}</div>
                      <div className="row-meta">
                        {team.open_tasks} open · {team.progress_percent}% complete
                        {team.lead_name ? ` · ${team.lead_name}` : ""}
                      </div>
                    </div>
                    <div className="row-side">
                      <span className="badge badge-handled">On track</span>
                      <span className="row-chevron" aria-hidden="true">
                        ›
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      )}

      <Drawer
        open={selectedTeam !== null}
        onClose={() => setSelectedTeam(null)}
        title={selectedTeam?.name ?? ""}
        subtitle={
          selectedTeam
            ? `${selectedTeam.open_tasks} open · ${selectedTeam.member_count} member${selectedTeam.member_count === 1 ? "" : "s"}`
            : undefined
        }
      >
        {selectedTeam && (
          <div className="stack">
            {teamTasks.length === 0 ? (
              <EmptyState mark="—" title="No tasks" body="This team has no tasks yet." />
            ) : (
              <ul className="rows" style={{ margin: "0 calc(-1 * var(--s5))" }}>
                {teamTasks.map((task) => (
                  <li className="row" key={task.task_id} style={{ flexWrap: "wrap" }}>
                    <div className="row-main">
                      <div className="row-title">{task.title}</div>
                      <div className="row-meta">
                        {task.assigned_to_name || task.assigned_to || "Unassigned"}
                        {task.due_date ? ` · due ${new Date(task.due_date).toLocaleDateString("en-IN")}` : ""}
                      </div>
                      {task.blocked_reason && (
                        <div className="t-meta" style={{ color: "var(--status-blocked)" }}>
                          {task.blocked_reason}
                        </div>
                      )}
                    </div>
                    <div className="row-side">
                      <SeverityBadge severity={task.priority} />
                      {task.is_overdue ? (
                        <span className="badge badge-overdue">Overdue</span>
                      ) : (
                        <StatusBadge status={task.status} />
                      )}
                    </div>

                    {/* Status change is offered where the API allows it. A team member may only
                        progress their own work, and the backend enforces that independently. */}
                    {(role === "LEADER" || task.status !== "COMPLETED") && (
                      <div className="cluster" style={{ width: "100%", marginTop: "var(--s2)" }}>
                        {MEMBER_STATUSES.filter((s) => s !== task.status).map((status) => (
                          <button
                            key={status}
                            className="btn btn-sm btn-ghost"
                            type="button"
                            disabled={updating === task.task_id}
                            onClick={() => void setStatus(task, status)}
                          >
                            {status === "IN_PROGRESS"
                              ? "Start"
                              : status === "REVIEW"
                                ? "Review"
                                : status === "COMPLETED"
                                  ? "Complete"
                                  : "Block"}
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
