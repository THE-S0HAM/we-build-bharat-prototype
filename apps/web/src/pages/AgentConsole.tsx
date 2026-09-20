import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { agentChat, getAgentActivity, getAgentCapabilities } from "../api";
import { ApiErrorState } from "../components/ApiErrorState";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { SkeletonCard } from "../components/Skeleton";
import type { EventScopedPageProps } from "../event/EventScopedView";
import { APPROVALS_PATH } from "../navConfig";
import { useApiFailure } from "../session/useApiFailure";
import type { AgentActivityResponse, AgentCapabilities, AgentEvidence } from "../types";
import "./OperationalPages.css";

interface Turn {
  id: number;
  role: "user" | "assistant";
  content: string;
  evidence: AgentEvidence[];
  approvalCount: number;
  failed?: boolean;
}

function actionLabel(identifier: string): string {
  const words = identifier.replace(/_/g, " ").trim().toLowerCase();
  return words === "" ? "Operational action" : words.charAt(0).toUpperCase() + words.slice(1);
}

function reviewedSummary(summary: string): string {
  return summary
    .replace(/\bAPR-[A-Za-z0-9-]+\b/g, "an approval request")
    .replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, (value) => value.replace(/_/g, " "));
}

export function AgentConsole({ eventId }: EventScopedPageProps) {
  const report = useApiFailure();
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const [activity, setActivity] = useState<AgentActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<unknown>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [sessionId, setSessionId] = useState<string>();
  const [sending, setSending] = useState(false);
  const inputId = useId();
  const sequence = useRef(0);

  const load = useCallback(() => {
    setLoading(true);
    setFailure(null);
    Promise.all([getAgentCapabilities(), getAgentActivity(eventId)]).then(
      ([caps, acts]) => {
        setCapabilities(caps);
        setActivity(acts);
        setLoading(false);
      },
      (error: unknown) => {
        setFailure(report(error));
        setLoading(false);
      },
    );
  }, [eventId, report]);

  useEffect(load, [load]);

  function send(event: FormEvent): void {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sending) return;
    const userId = sequence.current++;
    setTurns((current) => [
      ...current,
      { id: userId, role: "user", content: message, evidence: [], approvalCount: 0 },
    ]);
    setDraft("");
    setSending(true);
    agentChat({ message, event_id: eventId, session_id: sessionId }).then(
      (response) => {
        setSessionId(response.session_id);
        setTurns((current) => [
          ...current,
          {
            id: sequence.current++,
            role: "assistant",
            content: reviewedSummary(response.reply),
            evidence: response.evidence,
            approvalCount: response.approvals_created.length,
          },
        ]);
        setSending(false);
        if (response.approvals_created.length > 0) load();
      },
      (error: unknown) => {
        report(error);
        setTurns((current) => [
          ...current,
          {
            id: sequence.current++,
            role: "assistant",
            content:
              "CommunityOps could not answer that request. Your operational data was not changed.",
            evidence: [],
            approvalCount: 0,
            failed: true,
          },
        ]);
        setSending(false);
      },
    );
  }

  return (
    <div className="page agent-console">
      <PageHeader
        title="Agent"
        context="Ask CommunityOps about the current operation. Evidence and approval gates stay visible with every answer."
      />
      {loading && <SkeletonCard lines={5} label="Reading agent capabilities and activity…" />}
      {failure !== null && <ApiErrorState error={failure} onRetry={load} />}
      {!loading && failure === null && capabilities !== null && (
        <>
          <section className="card ops-chat" aria-labelledby="agent-conversation">
            <h2 className="page-section__heading" id="agent-conversation">
              Operational conversation
            </h2>
            <div
              className="ops-chat__log"
              role="log"
              aria-live="polite"
              aria-relevant="additions text"
              aria-label="Conversation"
              aria-busy={sending}
            >
              {turns.length === 0 && (
                <EmptyState
                  title="What do you need to know?"
                  description="Ask about current tasks, incidents, speakers, attendees or budget. CommunityOps uses only the capabilities available to your role."
                />
              )}
              {turns.map((turn) => (
                <div
                  key={turn.id}
                  className={turn.role === "user" ? "ops-chat__turn ops-chat__turn--user" : "ops-chat__turn"}
                >
                  <strong>{turn.role === "assistant" ? "CommunityOps" : "You"}</strong>
                  <p>{turn.content}</p>
                  {turn.approvalCount > 0 && (
                    <div className="ops-result ops-result--attention">
                      <strong>Prepared, not performed.</strong>
                      <p>
                        This action is waiting for a human decision.{" "}
                        <Link to={APPROVALS_PATH}>Review the prepared action in Approvals</Link>.
                      </p>
                    </div>
                  )}
                  {turn.evidence.length > 0 && (
                    <>
                      <p className="ops-list__meta">Evidence from verified operations</p>
                      <ul className="ops-evidence">
                        {turn.evidence.map((entry, index) => (
                          <li key={`${entry.tool}-${index}`}>
                            <strong>{actionLabel(entry.tool)}</strong>: {reviewedSummary(entry.summary)}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {turn.failed && (
                    <p className="ops-list__meta">You can retry by sending the question again.</p>
                  )}
                </div>
              ))}
              {sending && <p role="status">CommunityOps is checking the operation…</p>}
            </div>
            <form className="ops-compose" onSubmit={send}>
              <div className="form-field">
                <label className="form-label" htmlFor={inputId}>Ask CommunityOps</label>
                <textarea className="input" id={inputId} rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={sending} />
              </div>
              <button type="submit" className="btn btn-primary" disabled={sending || !draft.trim()}>Ask</button>
            </form>
          </section>
          <section className="page-section" aria-labelledby="agent-boundaries">
            <h2 className="page-section__heading" id="agent-boundaries">Capability boundaries</h2>
            <p className="page-section__description">
              {capabilities.tool_count} capabilities are available to this {capabilities.role === "LEADER" ? "leader" : "team member"} session. The backend filters this list and enforces every call.
            </p>
            <div className="ops-capabilities">
              <CapabilityList title="Automatic" items={capabilities.automatic} empty="No automatic capabilities were returned." />
              <CapabilityList title="Requires approval" items={capabilities.requires_approval} empty="No approval-gated capabilities were returned." />
              <CapabilityList title="Withheld from this role" items={capabilities.withheld_from_role} empty="Nothing else is withheld from this role." />
            </div>
          </section>
          <section className="page-section" aria-labelledby="agent-activity">
            <h2 className="page-section__heading" id="agent-activity">Recent verified activity</h2>
            {activity === null || activity.activity.length === 0 ? (
              <EmptyState title="No agent activity yet." description="Actions and refusals appear here from the audit record." />
            ) : (
              <ul className="ops-list">
                {activity.activity.map((entry) => (
                  <li className="ops-list__item" key={entry.audit_id}>
                    <p className="ops-list__title">{reviewedSummary(entry.summary)}</p>
                    <p className="ops-list__meta">
                      {entry.timestamp}
                      {entry.tool_used ? ` · ${actionLabel(entry.tool_used)}` : ""}
                      {entry.approval_id ? " · Prepared action awaiting review" : ""}
                    </p>
                    {entry.approval_id ? <Link to={APPROVALS_PATH}>Review in Approvals</Link> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function CapabilityList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div className="card">
      <h3 className="drawer-heading">{title}</h3>
      {items.length ? (
        <ul className="ops-list">{items.map((item) => <li key={item}>{actionLabel(item)}</li>)}</ul>
      ) : (
        <p className="ops-list__meta">{empty}</p>
      )}
    </div>
  );
}
