import { useEffect, useState } from "react";
import { getTasks } from "../api";
import type { Task } from "../types";

const PRIORITY_BADGES: Record<string, string> = {
  CRITICAL: "badge-critical",
  HIGH: "badge-warning",
  MEDIUM: "badge-attention",
  LOW: "badge-completed",
};

const STATUS_BADGES: Record<string, string> = {
  PENDING: "badge-primary",
  IN_PROGRESS: "badge-attention",
  BLOCKED: "badge-critical",
  OVERDUE: "badge-critical",
  COMPLETED: "badge-healthy",
  CANCELLED: "badge-completed",
};

const TEAMS = [
  { id: "TEAM-marketing", name: "Marketing" },
  { id: "TEAM-registration", name: "Registration" },
  { id: "TEAM-speakers", name: "Speaker Management" },
  { id: "TEAM-venue", name: "Venue & Logistics" },
  { id: "TEAM-volunteers", name: "Volunteers" },
  { id: "TEAM-tech", name: "Technical Operations" },
];

export function TaskBoard({ eventId }: { eventId: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTeam, setSelectedTeam] = useState("ALL");

  useEffect(() => {
    // Fetch tasks from all teams (using mock which returns all)
    Promise.all(TEAMS.map((t) => getTasks(eventId, t.id).then((r) => r.tasks)))
      .then((results) => setTasks(results.flat()))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [eventId]);

  if (loading) return <p>Loading tasks...</p>;

  const filtered = selectedTeam === "ALL" ? tasks : tasks.filter((t) => t.team_id === selectedTeam);
  const overdue = tasks.filter((t) => t.status === "OVERDUE");
  const blocked = tasks.filter((t) => t.status === "BLOCKED");

  return (
    <div>
      <h1 className="page-title">Task Board</h1>
      <p className="page-subtitle">{tasks.length} tasks across {TEAMS.length} teams</p>

      <div className="stats-grid">
        <div className="stat-card"><div className="stat-value" style={{ color: "var(--color-critical)" }}>{overdue.length}</div><div className="stat-label">Overdue</div></div>
        <div className="stat-card"><div className="stat-value" style={{ color: "var(--color-attention)" }}>{blocked.length}</div><div className="stat-label">Blocked</div></div>
        <div className="stat-card"><div className="stat-value">{tasks.filter((t) => t.status === "IN_PROGRESS").length}</div><div className="stat-label">In Progress</div></div>
        <div className="stat-card"><div className="stat-value" style={{ color: "var(--color-healthy)" }}>{tasks.filter((t) => t.status === "COMPLETED").length}</div><div className="stat-label">Completed</div></div>
      </div>

      <div style={{ marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className={`btn btn-sm ${selectedTeam === "ALL" ? "btn-primary" : ""}`} onClick={() => setSelectedTeam("ALL")}>All Teams</button>
        {TEAMS.map((t) => (
          <button key={t.id} className={`btn btn-sm ${selectedTeam === t.id ? "btn-primary" : ""}`} onClick={() => setSelectedTeam(t.id)}>{t.name}</button>
        ))}
      </div>

      <div className="card">
        <div className="table-container">
          <table>
            <thead>
              <tr><th>Task</th><th>Team</th><th>Priority</th><th>Status</th><th>Due</th><th>Dependencies</th></tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.task_id}>
                  <td>
                    <strong>{t.title}</strong>
                    <br /><span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{t.task_id}</span>
                  </td>
                  <td>{TEAMS.find((tm) => tm.id === t.team_id)?.name || t.team_id}</td>
                  <td><span className={`badge ${PRIORITY_BADGES[t.priority] || ""}`}>{t.priority}</span></td>
                  <td><span className={`badge ${STATUS_BADGES[t.status] || ""}`}>{t.status}</span></td>
                  <td style={{ fontSize: 13 }}>{t.due_date ? new Date(t.due_date).toLocaleString("en-IN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                  <td>{t.depends_on.length > 0 ? t.depends_on.join(", ") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
