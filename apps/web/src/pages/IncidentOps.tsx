/**
 * IncidentOps.
 *
 * Answers: what could disrupt the event? Severity-ordered, with the agent's recommendation behind a
 * disclosure rather than presented as a standing card — a recommendation shown before the leader has
 * read what happened invites accepting it without reading either.
 *
 * The discussion is real: `POST/GET .../comments`. Human and agent authors are visually distinguished
 * because a reader has to know which observations came from a person at the venue and which are the
 * system's analysis. A task can be created from a comment in one action, and the resulting task keeps a
 * reference back to the comment that produced it.
 *
 * Only transitions the API actually supports are offered. Resolving is leader-only and requires a
 * summary, because an incident closed with no explanation teaches nobody anything.
 */

import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  addIncidentComment,
  formatRelative,
  getIncident,
  getIncidents,
  getTeams,
  resolveIncident,
  updateIncident,
} from "../api";
import {
  Card,
  DetailList,
  Drawer,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  SeverityBadge,
  Stat,
  Section,
  StatusBadge,
} from "../components/primitives";
import type {
  Incident,
  IncidentComment,
  IncidentDetailResponse,
  Role,
  TeamSummary,
} from "../types";

const CLOSED = ["RESOLVED", "CLOSED", "REJECTED"];

export function IncidentOpsPage({
  eventId,
  role,
  onChanged,
}: {
  eventId: string;
  role: Role;
  onChanged: () => void;
}) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const [detail, setDetail] = useState<IncidentDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();

  // Creating work from a comment is opt-in, so the thread stays a discussion by default.
  const [makeTask, setMakeTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskTeam, setTaskTeam] = useState("");

  const [resolving, setResolving] = useState(false);
  const [resolution, setResolution] = useState("");
  const [rootCause, setRootCause] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [incidentResponse, teamResponse] = await Promise.all([
        getIncidents(eventId),
        getTeams(eventId).catch(() => ({ teams: [], count: 0 })),
      ]);
      setIncidents(incidentResponse.incidents);
      setTeams(teamResponse.teams);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load incidents.");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openIncident = useCallback(
    async (incidentId: string) => {
      setDetailLoading(true);
      setActionError(undefined);
      setComment("");
      setMakeTask(false);
      setTaskTitle("");
      setResolving(false);
      setResolution("");
      setRootCause("");
      try {
        setDetail(await getIncident(eventId, incidentId));
      } catch (err) {
        setActionError(
          err instanceof ApiError ? err.message : "Could not open that incident.",
        );
      } finally {
        setDetailLoading(false);
      }
    },
    [eventId],
  );

  async function postComment() {
    if (!detail || !comment.trim()) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await addIncidentComment(eventId, detail.incident.incident_id, {
        body: comment.trim(),
        ...(makeTask && taskTitle.trim() && taskTeam
          ? {
              create_task: true,
              task_team_id: taskTeam,
              task_title: taskTitle.trim(),
              task_priority: "HIGH",
            }
          : {}),
      });
      setComment("");
      setMakeTask(false);
      setTaskTitle("");
      await openIncident(detail.incident.incident_id);
      await load();
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : "The comment could not be posted.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function acknowledge() {
    if (!detail) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await updateIncident(eventId, detail.incident.incident_id, { status: "ACKNOWLEDGED" });
      await openIncident(detail.incident.incident_id);
      await load();
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : "The incident could not be acknowledged.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function resolve() {
    if (!detail || !resolution.trim()) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await resolveIncident(eventId, detail.incident.incident_id, {
        resolution_summary: resolution.trim(),
        root_cause: rootCause.trim() || undefined,
      });
      await openIncident(detail.incident.incident_id);
      await load();
      // Resolving removes a health signal, so the shell's context is refreshed.
      onChanged();
      setResolving(false);
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : "The incident could not be resolved.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  const open = incidents.filter((i) => !CLOSED.includes(i.status));
  const closed = incidents.filter((i) => CLOSED.includes(i.status));
  const critical = open.filter((i) => i.severity === "CRITICAL");
  const high = open.filter((i) => i.severity === "HIGH");

  const incident = detail?.incident;
  const isClosed = incident ? CLOSED.includes(incident.status) : false;

  return (
    <div>
      <PageHeader
        title="IncidentOps"
        subtitle="Operational risks to the event. CommunityOps analyses each one and can create work, but resolving is a human judgement."
      />

      <div className="stat-grid" style={{ marginBottom: "var(--s5)" }}>
        <Stat
          value={open.length}
          label="Open"
          tone={open.length > 0 ? "at-risk" : undefined}
        />
        <Stat
          value={critical.length}
          label="Critical"
          tone={critical.length > 0 ? "blocked" : undefined}
        />
        <Stat value={high.length} label="High" tone={high.length > 0 ? "at-risk" : undefined} />
        <Stat value={closed.length} label="Resolved" />
      </div>

      {open.length === 0 ? (
        <EmptyState
          title="Nothing is threatening the event"
          body="No open incidents. Anything reported by a team member appears here immediately."
        />
      ) : (
        <Section title={`Open (${open.length})`}>
          <Card padding="flush">
            <ul className="rows">
              {open.map((item) => (
                <li key={item.incident_id}>
                  <button
                    className="row"
                    type="button"
                    onClick={() => void openIncident(item.incident_id)}
                  >
                    <SeverityBadge severity={item.severity} />
                    <div className="row-main">
                      <div className="row-title">{item.title}</div>
                      <div className="row-meta">
                        {item.affected_resource_type
                          ? `${item.affected_resource_type} ${item.affected_resource_id} · `
                          : ""}
                        {item.reported_by_name ? `${item.reported_by_name} · ` : ""}
                        {formatRelative(item.detected_at)}
                      </div>
                    </div>
                    <div className="row-side">
                      {(item.comment_count ?? 0) > 0 && (
                        <span className="t-meta">{item.comment_count} comments</span>
                      )}
                      <StatusBadge status={item.status} />
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

      {closed.length > 0 && (
        <Section title={`Resolved (${closed.length})`}>
          <Card padding="flush">
            <ul className="rows">
              {closed.map((item) => (
                <li key={item.incident_id}>
                  <button
                    className="row"
                    type="button"
                    onClick={() => void openIncident(item.incident_id)}
                  >
                    <div className="row-main">
                      <div className="row-title">{item.title}</div>
                      <div className="row-meta">
                        {item.resolved_by ? `Resolved by ${item.resolved_by} · ` : ""}
                        {formatRelative(item.resolved_at)}
                      </div>
                    </div>
                    <div className="row-side">
                      <StatusBadge status={item.status} />
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
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={incident?.title ?? ""}
        subtitle={
          incident
            ? `${incident.severity} · ${incident.category ?? "OTHER"} · ${formatRelative(incident.detected_at)}`
            : undefined
        }
        footer={
          incident && !isClosed ? (
            resolving ? (
              <>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={busy || !resolution.trim()}
                  onClick={() => void resolve()}
                >
                  {busy ? "Resolving…" : "Resolve incident"}
                </button>
                <button className="btn" type="button" onClick={() => setResolving(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                {role === "LEADER" && (
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() => setResolving(true)}
                  >
                    Resolve
                  </button>
                )}
                {!incident.acknowledged_at && (
                  <button className="btn" type="button" disabled={busy} onClick={() => void acknowledge()}>
                    Acknowledge
                  </button>
                )}
              </>
            )
          ) : undefined
        }
      >
        {detailLoading && <LoadingState label="Opening the incident…" />}

        {incident && !detailLoading && (
          <div className="stack">
            {actionError && <Notice tone="error">{actionError}</Notice>}

            <div className="cluster">
              <SeverityBadge severity={incident.severity} />
              <StatusBadge status={incident.status} />
            </div>

            <p className="t-body">{incident.description}</p>

            {isClosed && incident.resolution_summary && (
              <Card title="Resolution" padding="tight">
                <DetailList
                  items={[
                    { label: "Summary", value: incident.resolution_summary },
                    { label: "Root cause", value: incident.root_cause },
                    {
                      label: "Actions taken",
                      value:
                        incident.actions_taken && incident.actions_taken.length > 0 ? (
                          <ul style={{ paddingLeft: "var(--s4)" }}>
                            {incident.actions_taken.map((action) => (
                              <li key={action}>{action}</li>
                            ))}
                          </ul>
                        ) : (
                          ""
                        ),
                    },
                    { label: "Resolved by", value: incident.resolved_by },
                    { label: "Resolved", value: formatRelative(incident.resolved_at) },
                  ]}
                />
              </Card>
            )}

            {resolving && (
              <Card title="Resolve this incident" padding="tight">
                <div className="field">
                  <label className="field-label" htmlFor="resolution">
                    What resolved it
                  </label>
                  <textarea
                    id="resolution"
                    className="textarea"
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                    placeholder="What was done, and how you know the problem is gone."
                  />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="root-cause">
                    Root cause (optional)
                  </label>
                  <input
                    id="root-cause"
                    className="input"
                    value={rootCause}
                    onChange={(e) => setRootCause(e.target.value)}
                  />
                  <div className="field-hint">
                    Recorded for post-event review, which is most of the value of having logged this.
                  </div>
                </div>
              </Card>
            )}

            {/* The recommendation sits behind a disclosure so what happened is read first. */}
            {incident.recommendation && !isClosed && (
              <details>
                <summary
                  className="t-body"
                  style={{ cursor: "pointer", color: "var(--primary)", fontWeight: 600 }}
                >
                  What does CommunityOps suggest?
                </summary>
                <div style={{ marginTop: "var(--s3)" }} className="stack-sm">
                  <p className="t-body">{incident.recommendation}</p>
                  {incident.impact_analysis && (
                    <div>
                      <div className="t-label">Impact</div>
                      <p className="t-body t-muted">{incident.impact_analysis}</p>
                    </div>
                  )}
                  {incident.dependencies.length > 0 && (
                    <div>
                      <div className="t-label">Depends on this</div>
                      <ul style={{ paddingLeft: "var(--s4)" }}>
                        {incident.dependencies.map((dependency) => (
                          <li className="t-body t-muted" key={dependency}>
                            {dependency}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {incident.backup_options.length > 0 && (
                    <div>
                      <div className="t-label">Options</div>
                      <ul style={{ paddingLeft: "var(--s4)" }}>
                        {incident.backup_options.map((option) => (
                          <li className="t-body t-muted" key={option}>
                            {option}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </details>
            )}

            <DetailList
              items={[
                { label: "Reported by", value: incident.reported_by_name },
                { label: "Assigned to", value: incident.assigned_to_name },
                { label: "Team", value: incident.team_id },
                {
                  label: "Affects",
                  value: incident.affected_resource_id
                    ? `${incident.affected_resource_type} ${incident.affected_resource_id}`
                    : "",
                },
                {
                  label: "Acknowledged",
                  value: incident.acknowledged_at ? formatRelative(incident.acknowledged_at) : "",
                },
              ]}
            />

            {/* Discussion */}
            <div>
              <div className="t-label" style={{ marginBottom: "var(--s3)" }}>
                Discussion ({detail?.comments.length ?? 0})
              </div>
              {detail && detail.comments.length > 0 ? (
                <div className="thread">
                  {detail.comments.map((message) => (
                    <Message key={message.comment_id} comment={message} />
                  ))}
                </div>
              ) : (
                <p className="t-meta">No comments yet.</p>
              )}
            </div>

            {!isClosed && (
              <Card title="Add to the discussion" padding="tight">
                <div className="field">
                  <label className="sr-only" htmlFor="new-comment">
                    Comment
                  </label>
                  <textarea
                    id="new-comment"
                    className="textarea"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="What you have seen, tried, or decided."
                  />
                </div>

                <label className="cluster" style={{ marginBottom: "var(--s3)", gap: "var(--s2)" }}>
                  <input
                    type="checkbox"
                    checked={makeTask}
                    onChange={(e) => setMakeTask(e.target.checked)}
                  />
                  <span className="t-body">Also create a task from this</span>
                </label>

                {makeTask && (
                  <div className="stack-sm" style={{ marginBottom: "var(--s3)" }}>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label className="field-label" htmlFor="task-title">
                        Task
                      </label>
                      <input
                        id="task-title"
                        className="input"
                        value={taskTitle}
                        onChange={(e) => setTaskTitle(e.target.value)}
                        placeholder="Test the backup projector before 5pm"
                      />
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label className="field-label" htmlFor="task-team">
                        Team
                      </label>
                      <select
                        id="task-team"
                        className="select"
                        value={taskTeam}
                        onChange={(e) => setTaskTeam(e.target.value)}
                      >
                        <option value="">Choose a team…</option>
                        {teams.map((team) => (
                          <option key={team.team_id} value={team.team_id}>
                            {team.name}
                          </option>
                        ))}
                      </select>
                      <div className="field-hint">
                        The task will link back to this comment, so the reasoning stays reachable.
                      </div>
                    </div>
                  </div>
                )}

                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={busy || !comment.trim() || (makeTask && (!taskTitle.trim() || !taskTeam))}
                  onClick={() => void postComment()}
                >
                  {busy ? "Posting…" : makeTask ? "Comment and create task" : "Comment"}
                </button>
              </Card>
            )}

            {incident.severity === "CRITICAL" || incident.severity === "HIGH" ? (
              <Notice tone="info">
                CommunityOps will not resolve a high or critical incident on its own. Deciding a
                problem is actually over is a judgement about the world, so it waits for a leader.
              </Notice>
            ) : null}
          </div>
        )}
      </Drawer>
    </div>
  );
}

/** One message. The agent is visually distinct from a person's observation. */
function Message({ comment }: { comment: IncidentComment }) {
  const isAgent = comment.author_type === "agent";
  const initials = (comment.author_name || "?")
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div
      className={`message${comment.parent_comment_id ? " reply" : ""}${isAgent ? " agent-message" : ""}`}
    >
      <div className={`avatar${isAgent ? " agent" : ""}`} aria-hidden="true">
        {isAgent ? "✦" : initials}
      </div>
      <div className="message-main">
        <div className="message-head">
          <span className="message-author">{comment.author_name || comment.author_id}</span>
          {isAgent && <span className="badge badge-handled">Agent</span>}
          {comment.author_role === "LEADER" && !isAgent && (
            <span className="badge badge-outline">Lead</span>
          )}
          <span className="message-time">{formatRelative(comment.created_at)}</span>
        </div>
        <div className="message-body">{comment.body}</div>
        {comment.created_task_id && (
          <div className="message-link">
            <span className="badge badge-info">Created task {comment.created_task_id}</span>
          </div>
        )}
      </div>
    </div>
  );
}
