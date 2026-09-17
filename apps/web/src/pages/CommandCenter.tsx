import { useEffect, useState } from "react";
import { getCommandCenter } from "../api";
import type { CommandCenterData } from "../types";

export function CommandCenter() {
  const [data, setData] = useState<CommandCenterData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCommandCenter()
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p>Loading command center...</p>;
  if (!data) return <p>Failed to load command center data.</p>;

  const s = data.summary;

  return (
    <div>
      <h1 className="page-title">Command Center</h1>
      <p className="page-subtitle">What needs your attention right now</p>

      <div className="stats-grid">
        <StatCard value={s.active_events} label="Active Events" />
        <StatCard value={s.pending_approvals} label="Pending Approvals" color="attention" />
        <StatCard value={s.critical_incidents} label="Critical Incidents" color="critical" />
        <StatCard value={s.overdue_tasks} label="Overdue Tasks" color="warning" />
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Event Health</span>
        </div>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Status</th>
                <th>Approvals</th>
                <th>Incidents</th>
                <th>Overdue</th>
                <th>Blocked</th>
                <th>Tasks</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.event_id}>
                  <td><strong>{e.name}</strong></td>
                  <td><span className={`badge badge-${e.status === "ACTIVE" ? "healthy" : "completed"}`}>{e.status}</span></td>
                  <td>{e.pending_approvals > 0 ? <span className="badge badge-attention">{e.pending_approvals}</span> : "—"}</td>
                  <td>{e.critical_incidents > 0 ? <span className="badge badge-critical">{e.critical_incidents}</span> : "—"}</td>
                  <td>{e.overdue_tasks > 0 ? <span className="badge badge-warning">{e.overdue_tasks}</span> : "—"}</td>
                  <td>{e.blocked_tasks > 0 ? <span className="badge badge-attention">{e.blocked_tasks}</span> : "—"}</td>
                  <td>{e.total_tasks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Recent Agent Actions</span>
        </div>
        <ul className="timeline">
          {data.recent_actions.map((a) => (
            <li key={a.audit_id} className="timeline-item">
              <span className="timeline-time">{formatTime(a.timestamp)}</span>
              <span className="timeline-action">{humanizeAction(a.action)}</span>
              <span className="timeline-actor">{a.actor_type === "agent" ? `🤖 ${a.actor_id}` : `👤 ${a.actor_id}`}</span>
              <span className="timeline-resource">{a.resource_type} {a.resource_id}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function StatCard({ value, label, color }: { value: number; label: string; color?: string }) {
  const colorVar = color ? `var(--color-${color})` : "var(--color-text)";
  return (
    <div className="stat-card">
      <div className="stat-value" style={{ color: colorVar }}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function humanizeAction(action: string): string {
  return action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
