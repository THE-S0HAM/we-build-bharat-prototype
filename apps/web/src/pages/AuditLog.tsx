import { useEffect, useState } from "react";
import { getAuditLog } from "../api";
import type { AuditEvent } from "../types";

export function AuditLog({ eventId }: { eventId: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAuditLog(eventId)
      .then((r) => setEvents(r.audit_events))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [eventId]);

  if (loading) return <p>Loading audit log...</p>;

  return (
    <div>
      <h1 className="page-title">Audit Log</h1>
      <p className="page-subtitle">Every consequential operation, traced end-to-end</p>

      <div className="card">
        <ul className="timeline">
          {events.map((e) => (
            <li key={e.audit_id} className="timeline-item">
              <span className="timeline-time">{formatTimestamp(e.timestamp)}</span>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 2 }}>
                  <span className="timeline-action" style={{ fontWeight: 500 }}>{humanize(e.action)}</span>
                  <span className={`badge ${e.outcome === "success" ? "badge-healthy" : "badge-critical"}`} style={{ fontSize: 10 }}>{e.outcome}</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                  {e.actor_type === "agent" ? "🤖" : "👤"} {e.actor_id}
                  {" · "}
                  <span className="timeline-resource">{e.resource_type}</span> {e.resource_id}
                  {e.tool_used && <span> · Tool: {e.tool_used}</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>

        {events.length === 0 && <p style={{ color: "var(--color-text-muted)" }}>No audit events recorded yet.</p>}
      </div>
    </div>
  );
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function humanize(action: string): string {
  return action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
