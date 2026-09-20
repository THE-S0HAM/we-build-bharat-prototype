import { useCallback, useEffect, useMemo, useState } from "react";
import { getAttendeeOps } from "../api";
import { ApiErrorState } from "../components/ApiErrorState";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { SkeletonCard } from "../components/Skeleton";
import type { EventScopedPageProps } from "../event/EventScopedView";
import { useApiFailure } from "../session/useApiFailure";
import type { AttendeeException, AttendeeOpsResponse } from "../types";
import "./OperationalPages.css";

type ExceptionKind = "dietary" | "accommodation" | "arrival";

export function AttendeeOps({ eventId }: EventScopedPageProps) {
  const report = useApiFailure();
  const [data, setData] = useState<AttendeeOpsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<unknown>(null);
  const [selected, setSelected] = useState<ExceptionKind>("dietary");
  const load = useCallback(() => {
    setLoading(true); setFailure(null);
    getAttendeeOps(eventId).then((response) => { setData(response); setLoading(false); }, (error: unknown) => { setFailure(report(error)); setLoading(false); });
  }, [eventId, report]);
  useEffect(load, [load]);

  const exceptions = useMemo(() => data === null ? [] : [
    { id: "dietary" as const, label: "Dietary details missing", count: data.exceptions.missing_dietary_total, rows: data.exceptions.missing_dietary },
    { id: "accommodation" as const, label: "Accommodation pending", count: data.exceptions.accommodation_pending_total, rows: data.exceptions.accommodation_pending },
    { id: "arrival" as const, label: "Arrival unconfirmed", count: data.exceptions.arrival_unconfirmed_total, rows: data.exceptions.arrival_unconfirmed },
  ], [data]);
  const active = exceptions.find((entry) => entry.id === selected) ?? exceptions[0];

  return <div className="page attendee-ops">
    <PageHeader title="AttendeeOps" context="Operational readiness from aggregate registration data, with only the exceptions that need follow-up." />
    {loading && <SkeletonCard lines={4} label="Getting attendee readiness…" />}
    {failure !== null && <ApiErrorState error={failure} onRetry={load} />}
    {!loading && failure === null && data !== null && data.summary.total_registered === 0 && <EmptyState title="No attendee registrations yet." description="Readiness will appear when registrations exist for this event." />}
    {!loading && failure === null && data !== null && data.summary.total_registered > 0 && <>
      <dl className="ops-summary" aria-label="Attendee readiness summary">
        <Metric label="Registered" value={data.summary.total_registered} />
        <Metric label="Confirmed" value={data.summary.confirmed} />
        <Metric label="Checked in" value={data.summary.checked_in} />
        <Metric label="Information complete" value={`${data.summary.data_completeness_percent}%`} />
      </dl>
      <section className="page-section" aria-labelledby="readiness-heading">
        <h2 className="page-section__heading" id="readiness-heading">Readiness funnel</h2>
        <div className="ops-funnel">
          {data.funnel.map((stage) => <div className="ops-funnel__row" key={stage.stage}>
            <span><strong>{stage.stage}</strong><span className="ops-list__meta"> {stage.detail}</span></span>
            <progress max={data.summary.total_registered || 1} value={stage.count}>{stage.count}</progress>
            <span className="ops-funnel__count">{stage.count}</span>
          </div>)}
        </div>
      </section>
      <section className="page-section" aria-labelledby="exceptions-heading">
        <h2 className="page-section__heading" id="exceptions-heading">Exceptions</h2>
        <div className="ops-tabs" role="group" aria-label="Attendee exception type">
          {exceptions.map((entry) => <button key={entry.id} type="button" className={selected === entry.id ? "btn btn-primary" : "btn"} aria-pressed={selected === entry.id} onClick={() => setSelected(entry.id)}>{entry.label} ({entry.count})</button>)}
        </div>
        {active?.rows.length ? <ExceptionList rows={active.rows} /> : <EmptyState title="Nothing outstanding here." description="Every registration has what this readiness check needs." />}
      </section>
    </>}
  </div>;
}

function Metric({ label, value }: { label: string; value: number | string }) { return <div className="ops-metric"><dt>{label}</dt><dd>{value}</dd></div>; }
function ExceptionList({ rows }: { rows: AttendeeException[] }) { return <ul className="ops-list">{rows.map((row) => <li className="ops-list__item" key={row.registration_id}><p className="ops-list__title">{row.attendee_name}</p><p className="ops-list__meta">{row.registration_id}{row.ticket_type ? ` · ${row.ticket_type}` : ""}{row.nights ? ` · ${row.nights}` : ""}{row.arrival_date ? ` · ${row.arrival_date}` : ""}</p></li>)}</ul>; }
