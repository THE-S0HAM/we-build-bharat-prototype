import { useEffect, useState } from "react";
import { getApprovals, decideApproval } from "../api";
import type { Approval } from "../types";

export function ApprovalCenter({ eventId }: { eventId: string }) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getApprovals(eventId)
      .then((r) => setApprovals(r.approvals))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [eventId]);

  async function handleDecision(approvalId: string, decision: string) {
    try {
      await decideApproval(eventId, approvalId, decision, "");
      setApprovals((prev) => prev.map((a) => a.approval_id === approvalId ? { ...a, status: decision as Approval["status"] } : a));
    } catch (e) {
      console.error(e);
    }
  }

  if (loading) return <p>Loading approvals...</p>;

  const pending = approvals.filter((a) => a.status === "PENDING");
  const resolved = approvals.filter((a) => a.status !== "PENDING");

  return (
    <div>
      <h1 className="page-title">Approval Center</h1>
      <p className="page-subtitle">{pending.length} pending decision{pending.length !== 1 ? "s" : ""}</p>

      {pending.length === 0 && <div className="card"><p style={{ color: "var(--color-text-muted)" }}>No pending approvals. All clear.</p></div>}

      {pending.map((a) => (
        <div key={a.approval_id} className="card" style={{ borderLeftWidth: 3, borderLeftColor: a.risk_level === "HIGH" ? "var(--color-critical)" : a.risk_level === "MEDIUM" ? "var(--color-attention)" : "var(--color-border)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <h3 style={{ fontSize: 16, marginBottom: 4 }}>{a.title}</h3>
              <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>{a.description}</p>
            </div>
            <span className={`badge ${a.risk_level === "HIGH" ? "badge-critical" : a.risk_level === "MEDIUM" ? "badge-attention" : "badge-primary"}`}>
              {a.risk_level}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: 13, marginBottom: 16 }}>
            <div><span style={{ color: "var(--color-text-muted)" }}>Reason:</span> {a.reason}</div>
            <div><span style={{ color: "var(--color-text-muted)" }}>Agent:</span> 🤖 {a.agent_name}</div>
            <div><span style={{ color: "var(--color-text-muted)" }}>Action:</span> {a.requested_action}</div>
            <div><span style={{ color: "var(--color-text-muted)" }}>Affects:</span> {a.affected_resource_type} {a.affected_resource_id}</div>
          </div>

          {a.evidence && Object.keys(a.evidence).length > 0 && (
            <details style={{ marginBottom: 16, fontSize: 13 }}>
              <summary style={{ cursor: "pointer", color: "var(--color-text-muted)" }}>Evidence</summary>
              <pre style={{ marginTop: 8, padding: 12, background: "var(--color-bg)", borderRadius: 4, fontSize: 12, overflow: "auto" }}>
                {JSON.stringify(a.evidence, null, 2)}
              </pre>
            </details>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-success btn-sm" onClick={() => handleDecision(a.approval_id, "APPROVED")}>✓ Approve</button>
            <button className="btn btn-danger btn-sm" onClick={() => handleDecision(a.approval_id, "DECLINED")}>✗ Decline</button>
          </div>
        </div>
      ))}

      {resolved.length > 0 && (
        <div className="card">
          <div className="card-header"><span className="card-title">Resolved</span></div>
          <div className="table-container">
            <table>
              <thead><tr><th>Title</th><th>Decision</th><th>Agent</th></tr></thead>
              <tbody>
                {resolved.map((a) => (
                  <tr key={a.approval_id}>
                    <td>{a.title}</td>
                    <td><span className={`badge ${a.status === "APPROVED" ? "badge-healthy" : "badge-critical"}`}>{a.status}</span></td>
                    <td>{a.agent_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
