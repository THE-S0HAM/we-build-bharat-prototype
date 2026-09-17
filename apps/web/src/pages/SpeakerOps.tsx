import { useEffect, useState } from "react";
import { getSpeakers } from "../api";
import type { Speaker } from "../types";

const STATUS_BADGES: Record<string, string> = {
  CONFIRMED: "badge-healthy",
  INVITED: "badge-primary",
  AWAITING_RESPONSE: "badge-attention",
  FOLLOWUP_SENT: "badge-attention",
  IDENTIFIED: "badge-completed",
  DECLINED: "badge-critical",
  CANCELLED: "badge-critical",
  BACKUP: "badge-primary",
};

export function SpeakerOps({ eventId }: { eventId: string }) {
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSpeakers(eventId)
      .then((r) => setSpeakers(r.speakers))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [eventId]);

  if (loading) return <p>Loading speakers...</p>;

  const confirmed = speakers.filter((s) => s.status === "CONFIRMED" && !s.is_backup);
  const pending = speakers.filter((s) => ["INVITED", "AWAITING_RESPONSE", "FOLLOWUP_SENT", "IDENTIFIED"].includes(s.status));
  const cancelled = speakers.filter((s) => ["CANCELLED", "DECLINED"].includes(s.status));
  const backups = speakers.filter((s) => s.is_backup);

  return (
    <div>
      <h1 className="page-title">Speaker Operations</h1>
      <p className="page-subtitle">{confirmed.length} confirmed · {pending.length} pending · {cancelled.length} cancelled</p>

      <div className="stats-grid">
        <div className="stat-card"><div className="stat-value" style={{ color: "var(--color-healthy)" }}>{confirmed.length}</div><div className="stat-label">Confirmed</div></div>
        <div className="stat-card"><div className="stat-value" style={{ color: "var(--color-attention)" }}>{pending.length}</div><div className="stat-label">Pending Response</div></div>
        <div className="stat-card"><div className="stat-value" style={{ color: "var(--color-critical)" }}>{cancelled.length}</div><div className="stat-label">Cancelled</div></div>
        <div className="stat-card"><div className="stat-value">{backups.length}</div><div className="stat-label">Backup Speakers</div></div>
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">All Speakers</span></div>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Speaker</th>
                <th>Topic</th>
                <th>Type</th>
                <th>Status</th>
                <th>Follow-ups</th>
                <th>Travel</th>
              </tr>
            </thead>
            <tbody>
              {speakers.map((s) => (
                <tr key={s.speaker_id}>
                  <td>
                    <strong>{s.name}</strong>
                    {s.is_backup && <span className="badge badge-primary" style={{ marginLeft: 8 }}>BACKUP</span>}
                    <br />
                    <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{s.email}</span>
                  </td>
                  <td>{s.topic}</td>
                  <td><span className="badge badge-completed">{s.session_type}</span></td>
                  <td><span className={`badge ${STATUS_BADGES[s.status] || "badge-completed"}`}>{s.status.replace(/_/g, " ")}</span></td>
                  <td>{s.followup_count > 0 ? s.followup_count : "—"}</td>
                  <td>
                    {s.travel_required && <span style={{ marginRight: 4 }}>✈</span>}
                    {s.accommodation_required && <span>🏨</span>}
                    {!s.travel_required && !s.accommodation_required && "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
