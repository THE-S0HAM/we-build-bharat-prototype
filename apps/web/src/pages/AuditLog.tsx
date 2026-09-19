/**
 * Audit log.
 *
 * The record of what happened, who caused it, and whether it was allowed. This is the screen
 * that makes the agent's authority checkable rather than a claim: a refusal appears here the
 * same way a success does, written by the same code path, so the agent cannot present a
 * flattering account of itself.
 *
 * Two distinctions are made visually because they are the ones that matter operationally:
 *
 * 1. **Agent or person.** Every entry says which. An operation nobody can attribute is not
 *    an audit trail.
 * 2. **Allowed, refused, or waiting.** `outcome: failure` on an agent entry usually means the
 *    policy engine declined, which is the system working — so it is labelled "refused"
 *    rather than dressed up as an error.
 *
 * Entries are rendered as the backend wrote them. Nothing is re-derived here, and no
 * infrastructure detail reaches the screen because the backend does not put any in the
 * record.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, formatDate, formatTime, getAuditLog, humanize } from "../api";
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Section,
  StatusBadge,
  Tabs,
} from "../components/primitives";
import type { AuditEvent, Role } from "../types";

type Filter = "all" | "agent" | "human" | "refused";

/** How many records to request. The backend caps this at 200. */
const AUDIT_LIMIT = 200;

/**
 * Outcome as a label a leader can read.
 *
 * `failure` is shown as "refused" because on an agent entry that is nearly always the policy
 * engine declining — which is the guardrail holding, not a fault. Calling it an error would
 * teach the reader to treat a working safeguard as a problem.
 */
function outcomeLabel(entry: AuditEvent): { label: string; tone: "completed" | "blocked" | "needs-decision" } {
  if (entry.outcome === "success") return { label: "Allowed", tone: "completed" };
  if (entry.outcome === "pending") return { label: "Awaiting approval", tone: "needs-decision" };
  return { label: entry.actor_type === "agent" ? "Refused" : "Failed", tone: "blocked" };
}

/**
 * Render `details` as readable pairs.
 *
 * Only scalars are shown. A nested object in the record is structural context for an
 * investigation, not something a leader reads on a timeline, and flattening it produces noise
 * that buries the entries that matter.
 */
function detailPairs(details: Record<string, unknown> | undefined): string[] {
  if (!details) return [];
  return Object.entries(details)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .slice(0, 6)
    .map(([k, v]) => `${humanize(k)}: ${String(v)}`);
}

export function AuditLogPage({ eventId, role }: { eventId: string; role: Role }) {
  const [entries, setEntries] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await getAuditLog(eventId, AUDIT_LIMIT);
      setEntries(response.audit_events);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the audit log.");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(
    () => ({
      all: entries.length,
      agent: entries.filter((e) => e.actor_type === "agent").length,
      human: entries.filter((e) => e.actor_type !== "agent").length,
      refused: entries.filter((e) => e.outcome === "failure").length,
    }),
    [entries],
  );

  const visible = useMemo(() => {
    switch (filter) {
      case "agent":
        return entries.filter((e) => e.actor_type === "agent");
      case "human":
        return entries.filter((e) => e.actor_type !== "agent");
      case "refused":
        return entries.filter((e) => e.outcome === "failure");
      default:
        return entries;
    }
  }, [entries, filter]);

  /**
   * Group by day.
   *
   * A flat list of 200 timestamps is unreadable — "was that today or last week?" is the first
   * question anyone asks of an audit entry, so the answer is a heading rather than something
   * to work out from the row.
   */
  const days = useMemo(() => {
    const grouped = new Map<string, AuditEvent[]>();
    for (const entry of visible) {
      const key = formatDate(entry.timestamp) || "Unknown date";
      const bucket = grouped.get(key);
      if (bucket) bucket.push(entry);
      else grouped.set(key, [entry]);
    }
    return [...grouped.entries()];
  }, [visible]);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div>
      <PageHeader
        title="Audit log"
        subtitle={
          role === "LEADER"
            ? "Every consequential operation, with who caused it and whether it was allowed. Refusals are recorded the same way successes are."
            : "Operations recorded for this event. You see the same record a community leader does."
        }
        actions={
          <button className="btn btn-sm" type="button" onClick={() => void load()}>
            Refresh
          </button>
        }
      />

      {entries.length === 0 ? (
        <EmptyState
          mark="—"
          title="Nothing recorded yet"
          body="Operations on this event will appear here as they happen."
        />
      ) : (
        <>
          <Tabs<Filter>
            tabs={[
              { id: "all", label: "Everything", count: counts.all },
              { id: "agent", label: "By CommunityOps", count: counts.agent },
              { id: "human", label: "By people", count: counts.human },
              { id: "refused", label: "Refused", count: counts.refused },
            ]}
            active={filter}
            onChange={setFilter}
          />

          {filter === "refused" && counts.refused === 0 && (
            <EmptyState
              title="Nothing was refused"
              body="No operation on this event was declined by policy or failed."
            />
          )}

          {days.map(([day, dayEntries]) => (
            <Section key={day} title={day}>
              <Card padding="tight">
                <ul className="timeline">
                  {dayEntries.map((entry) => {
                    const outcome = outcomeLabel(entry);
                    const pairs = detailPairs(entry.details);
                    const markerClass =
                      entry.outcome === "failure"
                        ? "failure"
                        : entry.actor_type === "agent"
                          ? "agent"
                          : "user";

                    return (
                      <li className="timeline-item" key={entry.audit_id}>
                        <span className="timeline-time">{formatTime(entry.timestamp)}</span>
                        <span className={`timeline-marker ${markerClass}`} aria-hidden="true" />
                        <div className="timeline-main">
                          <div className="cluster" style={{ gap: "var(--s2)" }}>
                            <span style={{ fontWeight: 600 }}>{humanize(entry.action)}</span>
                            <StatusBadge tone={outcome.tone} label={outcome.label} />
                            {entry.actor_type === "agent" && (
                              <span className="badge badge-outline">CommunityOps</span>
                            )}
                          </div>

                          <div className="t-meta" style={{ marginTop: 2 }}>
                            {entry.actor_type === "agent" ? "Agent" : "Person"} · {entry.actor_id}
                            {" · "}
                            {entry.resource_type}{" "}
                            <span className="t-mono">{entry.resource_id}</span>
                          </div>

                          {(entry.tool_used || entry.policy_evaluated || entry.approval_id) && (
                            <div
                              className="cluster"
                              style={{ marginTop: "var(--s2)", gap: "var(--s2)" }}
                            >
                              {entry.tool_used && (
                                <span className="chat-tool">{entry.tool_used}</span>
                              )}
                              {entry.policy_evaluated && (
                                <span className="chat-tool">
                                  policy: {entry.policy_evaluated}
                                </span>
                              )}
                              {entry.approval_id && (
                                <span className="chat-tool">{entry.approval_id}</span>
                              )}
                            </div>
                          )}

                          {pairs.length > 0 && (
                            <div className="t-meta" style={{ marginTop: "var(--s2)" }}>
                              {pairs.join(" · ")}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </Section>
          ))}

          <p className="t-meta" style={{ marginTop: "var(--s5)" }}>
            Showing the {entries.length} most recent records for this event. The audit trail is
            append-only — entries are never edited or removed.
          </p>
        </>
      )}
    </div>
  );
}
