/**
 * Agent console.
 *
 * The full-height conversation, plus the two things that make it trustworthy rather than
 * impressive: what the agent is allowed to do, and what it has actually done.
 *
 * The capability panel is read from `GET /agent/capabilities`, which projects the live tool
 * registry filtered by this caller's role. It is not a hand-written list of features — if a
 * tool is added, withdrawn, or moved behind approval, this screen changes with it. That
 * matters because a capability list maintained separately from the runtime eventually lies.
 *
 * The activity feed is read from the audit log, not from a separate agent-activity store, so
 * the agent's account of itself is the same record its refusals land in.
 *
 * Fun Mode is a tone flag passed to the model. It never changes what the agent may do, and the
 * backend prompt forbids it around money, approvals, incidents and outbound text. Said plainly
 * on screen so nobody wonders whether a personality setting is also a permissions setting.
 */

import { useCallback, useEffect, useState } from "react";

import { ApiError, formatRelative, getAgentActivity, getAgentCapabilities, humanize } from "../api";
import { AgentChat } from "../components/AgentChat";
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  Section,
  Stat,
  StatusBadge,
  Tabs,
} from "../components/primitives";
import type { AgentActivityResponse, AgentCapabilities, Role } from "../types";

type Panel = "capabilities" | "activity";

export function AgentConsole({
  eventId,
  role,
  funMode,
  onToggleFunMode,
}: {
  eventId: string;
  role: Role;
  funMode: boolean;
  onToggleFunMode: () => void;
}) {
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const [activity, setActivity] = useState<AgentActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [panel, setPanel] = useState<Panel>("capabilities");

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [caps, acts] = await Promise.all([
        getAgentCapabilities(),
        // Activity is supporting context; an empty feed is better than blanking the console.
        getAgentActivity(eventId).catch(() => null),
      ]);
      setCapabilities(caps);
      setActivity(acts);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the agent console.");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState label="Reading what the agent is allowed to do…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  const approvalGated = capabilities?.requires_approval ?? [];
  const automatic = capabilities?.automatic ?? [];

  return (
    <div>
      <PageHeader
        title="Ask CommunityOps"
        subtitle="Every answer comes from a live lookup against your operational data. Consequential actions are prepared for a decision, never performed."
        actions={
          <button
            className={funMode ? "btn btn-primary btn-sm" : "btn btn-sm"}
            type="button"
            onClick={onToggleFunMode}
            aria-pressed={funMode}
          >
            Fun mode {funMode ? "on" : "off"}
          </button>
        }
      />

      {funMode && (
        <div style={{ marginBottom: "var(--s5)" }}>
          <Notice tone="info">
            Fun mode changes the agent&rsquo;s tone only. It stays plain and professional around
            money, approvals, incidents and anything sent outside your organization, and it changes
            nothing about what the agent is permitted to do.
          </Notice>
        </div>
      )}

      <div className="split">
        <Card padding="flush">
          <AgentChat
            eventId={eventId}
            role={role}
            funMode={funMode}
            onApprovalCreated={() => void load()}
          />
        </Card>

        <div className="stack">
          <Card title="What it can do">
            <Tabs<Panel>
              tabs={[
                { id: "capabilities", label: "Boundaries" },
                { id: "activity", label: "Recent", count: activity?.count ?? 0 },
              ]}
              active={panel}
              onChange={setPanel}
            />

            {panel === "capabilities" ? (
              <div className="stack">
                <div className="stat-grid">
                  <Stat
                    value={automatic.length}
                    label="Runs on its own"
                    note="reads and low-risk work"
                    tone="handled"
                  />
                  <Stat
                    value={approvalGated.length}
                    label="Needs your approval"
                    note="financial and irreversible"
                    tone="needs-decision"
                  />
                </div>

                {capabilities && capabilities.withheld_from_role.length > 0 && (
                  <Notice tone="info">
                    {capabilities.withheld_from_role.length} capabilities are withheld from your
                    role entirely. {role === "TEAM_MEMBER"
                      ? "Decisions about budget, approvals and team structure are reserved for community leaders."
                      : "These are actions no role may take."}
                  </Notice>
                )}

                <div>
                  <div className="t-label" style={{ marginBottom: "var(--s2)" }}>
                    Prepared for your decision
                  </div>
                  {approvalGated.length === 0 ? (
                    <p className="t-meta">
                      No approval-gated capabilities are available to your role.
                    </p>
                  ) : (
                    <div className="cluster">
                      {approvalGated.map((name) => (
                        <span className="chat-tool" key={name}>
                          {name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="t-label" style={{ marginBottom: "var(--s2)" }}>
                    Done without asking
                  </div>
                  <div className="cluster">
                    {automatic.map((name) => (
                      <span className="chat-tool" key={name}>
                        {name}
                      </span>
                    ))}
                  </div>
                </div>

                {capabilities && (
                  <ul className="stack-sm" style={{ paddingLeft: "var(--s5)" }}>
                    {capabilities.notes.map((note) => (
                      <li className="t-meta" key={note}>
                        {note}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <ActivityPanel activity={activity} />
            )}
          </Card>
        </div>
      </div>

      {capabilities && (
        <Section title="Every capability">
          <Card
            padding="flush"
            footer={
              <span className="t-meta">
                {capabilities.tool_count} capabilities available to your role, read from the live
                registry. Approval-gated ones create a request and stop.
              </span>
            }
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Capability</th>
                    <th>What it does</th>
                    <th>Risk</th>
                    <th>Gate</th>
                  </tr>
                </thead>
                <tbody>
                  {capabilities.tools.map((tool) => (
                    <tr key={tool.name}>
                      <td className="t-mono">{tool.name}</td>
                      <td style={{ maxWidth: 420 }}>{tool.description}</td>
                      <td>
                        <StatusBadge status={tool.risk_tier} />
                      </td>
                      <td>
                        {tool.requires_approval ? (
                          <StatusBadge tone="needs-decision" label="Needs approval" />
                        ) : tool.mutating ? (
                          <StatusBadge tone="info" label="Writes" />
                        ) : (
                          <StatusBadge tone="handled" label="Read only" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </Section>
      )}
    </div>
  );
}

/**
 * What the agent has done recently.
 *
 * Refusals are counted and shown first. An agent that has never refused anything is either
 * doing nothing consequential or is not being constrained, and the reader deserves to tell
 * which.
 */
function ActivityPanel({ activity }: { activity: AgentActivityResponse | null }) {
  if (!activity || activity.count === 0) {
    return (
      <EmptyState
        mark="—"
        title="Nothing yet"
        body="Actions CommunityOps takes on this event will appear here, read straight from the audit log."
      />
    );
  }

  return (
    <div className="stack">
      {(activity.refused_count > 0 || activity.awaiting_approval_count > 0) && (
        <div className="cluster">
          {activity.awaiting_approval_count > 0 && (
            <StatusBadge
              tone="needs-decision"
              label={`${activity.awaiting_approval_count} awaiting approval`}
            />
          )}
          {activity.refused_count > 0 && (
            <StatusBadge tone="blocked" label={`${activity.refused_count} refused`} />
          )}
        </div>
      )}

      <ul className="timeline">
        {activity.activity.slice(0, 12).map((entry) => (
          <li className="timeline-item" key={entry.audit_id}>
            <span className="timeline-time">{formatRelative(entry.timestamp)}</span>
            <span
              className={`timeline-marker ${entry.outcome === "failure" ? "failure" : "agent"}`}
              aria-hidden="true"
            />
            <div className="timeline-main">
              <div className="t-body">{entry.summary || humanize(entry.action)}</div>
              <div className="t-meta" style={{ marginTop: 2 }}>
                {entry.tool_used ? `${entry.tool_used} · ` : ""}
                {entry.resource_type} <span className="t-mono">{entry.resource_id}</span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
