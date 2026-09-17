import { useEffect, useState } from "react";
import { getIncidents } from "../api";
import type { Incident } from "../types";

const SEVERITY_BADGES: Record<string, string> = {
  CRITICAL: "badge-critical",
  HIGH: "badge-warning",
  MEDIUM: "badge-attention",
  LOW: "badge-completed",
};

export function IncidentCenter({ eventId }: { eventId: string }) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getIncidents(eventId)
      .then((r) => setIncidents(r.incidents))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [eventId]);

  if (loading) return <p>Loading incidents...</p>;

  return (
    <div>
      <h1 className="page-title">Incident Center</h1>
      <p className="page-subtitle">{incidents.length} incident{incidents.length !== 1 ? "s" : ""}</p>

      {incidents.length === 0 && <div className="card"><p style={{ color: "var(--color-text-muted)" }}>No active incidents. All clear.</p></div>}

      {incidents.map((inc) => (
        <div key={inc.incident_id} className="card" style={{ borderLeftWidth: 3, borderLeftColor: inc.severity === "CRITICAL" ? "var(--color-critical)" : inc.severity === "HIGH" ? "var(--color-warning)" : "var(--color-border)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <h3 style={{ fontSize: 16, marginBottom: 4 }}>{inc.title}</h3>
              <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>{inc.incident_id} · Detected {new Date(inc.detected_at).toLocaleTimeString()}</p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <span className={`badge ${SEVERITY_BADGES[inc.severity] || ""}`}>{inc.severity}</span>
              <span className="badge badge-primary">{inc.status.replace(/_/g, " ")}</span>
            </div>
          </div>

          <p style={{ marginBottom: 12 }}>{inc.description}</p>

          {inc.affected_resource_type && (
            <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginBottom: 8 }}>
              Affects: <strong>{inc.affected_resource_type}</strong> {inc.affected_resource_id}
            </p>
          )}

          {inc.recommendation && (
            <div style={{ background: "var(--color-bg)", padding: 12, borderRadius: 4, marginBottom: 12, fontSize: 14 }}>
              <strong style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Recommendation:</strong>
              <p style={{ marginTop: 4 }}>{inc.recommendation}</p>
            </div>
          )}

          {inc.backup_options.length > 0 && (
            <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>
              Backup options: {inc.backup_options.join(", ")}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
