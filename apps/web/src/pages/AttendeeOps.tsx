/**
 * AttendeeOps.
 *
 * Answers: how ready are attendees operationally? A readiness funnel plus the exceptions somebody can
 * act on.
 *
 * Aggregates are the product here. Individual registrations appear only inside an exception list,
 * because the operational question is "who do we still need something from" rather than "show me
 * everyone" — and an attendee CRM is explicitly not what this is.
 *
 * Backed by `GET /events/{eventId}/attendees`, which was added for this screen: the aggregation
 * already existed in `AttendeeState` and the agent already read it, but no HTTP route exposed it. The
 * route projects that same computation rather than recomputing, so these numbers match what the agent
 * reports and what the health engine scored.
 */

import { useCallback, useEffect, useState } from "react";

import { ApiError, getAttendeeOps } from "../api";
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  Progress,
  Stat,
  Section,
  Tabs,
} from "../components/primitives";
import type { AttendeeException, AttendeeOpsResponse } from "../types";

type ExceptionTab = "dietary" | "accommodation" | "arrival";

export function AttendeeOpsPage({ eventId }: { eventId: string }) {
  const [data, setData] = useState<AttendeeOpsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [tab, setTab] = useState<ExceptionTab>("dietary");

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setData(await getAttendeeOps(eventId));
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not load attendee operations.",
      );
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!data) return <ErrorState onRetry={() => void load()} />;

  const s = data.summary;
  const e = data.exceptions;

  // The funnel's first stage is the denominator for every bar, so the widths read as proportions of
  // the whole population rather than of each other.
  const top = Math.max(1, data.funnel[0]?.count ?? 1);

  const tabs: { id: ExceptionTab; label: string; count: number; rows: AttendeeException[] }[] = [
    {
      id: "dietary",
      label: "Dietary details missing",
      count: e.missing_dietary_total,
      rows: e.missing_dietary,
    },
    {
      id: "accommodation",
      label: "Accommodation needed",
      count: e.accommodation_pending_total,
      rows: e.accommodation_pending,
    },
    {
      id: "arrival",
      label: "Arrival unconfirmed",
      count: e.arrival_unconfirmed_total,
      rows: e.arrival_unconfirmed,
    },
  ];
  const activeTab = tabs.find((t) => t.id === tab) ?? tabs[0]!;

  const completeness = s.data_completeness_percent;

  return (
    <div>
      <PageHeader
        title="AttendeeOps"
        subtitle="Operational readiness across the attendee list. Counts and exceptions, not individual records."
      />

      <div className="stat-grid" style={{ marginBottom: "var(--s5)" }}>
        <Stat
          value={s.total_registered}
          label="Registered"
          note={s.registration_target ? `target ${s.registration_target}` : undefined}
        />
        <Stat value={s.checked_in} label="Checked in" note={`${s.not_checked_in} not yet`} />
        <Stat
          value={s.accommodation_required}
          label="Need accommodation"
          tone={s.accommodation_required > 0 ? "at-risk" : undefined}
        />
        <Stat
          value={`${completeness}%`}
          label="Information complete"
          tone={completeness < 90 ? "at-risk" : "handled"}
          note={`${s.missing_information} with gaps`}
        />
      </div>

      {completeness < 90 && (
        <div style={{ marginBottom: "var(--s5)" }}>
          <Notice tone="warn">
            {s.missing_information} of {s.total_registered} registrations are missing operational
            details. Catering and accommodation counts depend on these.
          </Notice>
        </div>
      )}

      <Section title="Readiness">
        <Card>
          <div className="funnel">
            {data.funnel.map((stage) => {
              const percent = Math.round((stage.count / top) * 100);
              return (
                <div className="funnel-stage" key={stage.stage}>
                  <div className="funnel-meta">
                    <div className="funnel-stage-name">{stage.stage}</div>
                    <div className="funnel-stage-detail">{stage.detail}</div>
                  </div>
                  <div className="funnel-bar">
                    <div
                      className="funnel-bar-fill"
                      style={{ width: `${Math.max(percent, 8)}%` }}
                    >
                      {stage.count}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="t-meta" style={{ marginTop: "var(--s4)" }}>
            Each stage is a subset of the one above it. Cancelled registrations are excluded.
          </p>
        </Card>
      </Section>

      <Section title="Catering and logistics">
        <div className="split">
          <Card title="Dietary information" padding="tight">
            <div className="cluster-between" style={{ marginBottom: "var(--s3)" }}>
              <span className="t-body">
                {s.dietary_provided} provided · {s.dietary_missing} missing
              </span>
              <strong>
                {s.total_registered > 0
                  ? Math.round((s.dietary_provided / s.total_registered) * 100)
                  : 0}
                %
              </strong>
            </div>
            <Progress
              percent={
                s.total_registered > 0 ? (s.dietary_provided / s.total_registered) * 100 : 0
              }
              tone={s.dietary_missing > s.total_registered * 0.1 ? "at-risk" : "normal"}
            />
          </Card>

          <Card title="Arrivals" padding="tight">
            <div className="cluster-between" style={{ marginBottom: "var(--s3)" }}>
              <span className="t-body">
                {s.arrival_confirmed} confirmed
                {s.arrival_conflicts > 0 ? ` · ${s.arrival_conflicts} unverified` : ""}
              </span>
            </div>
            <Progress
              percent={
                s.total_registered > 0 ? (s.arrival_confirmed / s.total_registered) * 100 : 0
              }
            />
          </Card>
        </div>
      </Section>

      <Section title="Exceptions">
        <Tabs<ExceptionTab>
          tabs={tabs.map((t) => ({ id: t.id, label: t.label, count: t.count }))}
          active={tab}
          onChange={setTab}
        />

        {activeTab.rows.length === 0 ? (
          <EmptyState
            title="Nothing outstanding here"
            body="Every registration has what this stage needs."
          />
        ) : (
          <Card padding="flush">
            <ul className="rows">
              {activeTab.rows.map((row) => (
                <li className="row" key={row.registration_id}>
                  <div className="row-main">
                    <div className="row-title">{row.attendee_name}</div>
                    <div className="row-meta t-mono">{row.registration_id}</div>
                  </div>
                  <div className="row-side">
                    {row.ticket_type && (
                      <span className="badge badge-outline">{row.ticket_type}</span>
                    )}
                    {row.nights && <span className="t-meta">{row.nights}</span>}
                    {row.arrival_date && (
                      <span className="t-meta">
                        {new Date(row.arrival_date).toLocaleDateString("en-IN")}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {activeTab.count > activeTab.rows.length && (
              <div className="card-foot">
                <span className="t-meta">
                  Showing {activeTab.rows.length} of {activeTab.count}. Ask CommunityOps to prepare a
                  single message to everyone affected rather than chasing individually.
                </span>
              </div>
            )}
          </Card>
        )}
      </Section>
    </div>
  );
}
