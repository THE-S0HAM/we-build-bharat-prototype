/**
 * Command Center.
 *
 * Answers one question before any other: does anything need me right now? And immediately after it:
 * what is CommunityOps already handling?
 *
 * Visual hierarchy is deliberate and load-bearing:
 *
 *   1. a sentence saying how many decisions need the leader
 *   2. ONE dominant decision surface — the single most consequential waiting decision
 *   3. what the agent has handled, aggregated into counts
 *   4. the constellation
 *   5. everything else, below the fold
 *
 * The temptation is a wall of metrics. That fails the product: a screen where four stat cards, three
 * charts and a task table all shout equally leaves the leader doing the triage themselves, which is
 * the work this is supposed to remove.
 *
 * Every figure comes from `GET /command-center` and `GET /agent/activity`. None is computed here.
 */

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  ApiError,
  formatInrWithSymbol,
  formatRelative,
  getAgentActivity,
  getApproval,
  getCommandCenter,
} from "../api";
import { Constellation } from "../components/Constellation";
import {
  Card,
  ErrorState,
  HealthPill,
  LoadingState,
  Notice,
  SeverityBadge,
  Stat,
  Section,
} from "../components/primitives";
import type {
  AgentActivityResponse,
  ApprovalDetailResponse,
  AttentionItem,
  CommandCenterData,
  Role,
} from "../types";

/** Where each kind of attention item lives, so a row is always navigable. */
const ROUTE_FOR: Record<AttentionItem["kind"], string> = {
  APPROVAL: "/app/approvals",
  INCIDENT: "/app/incidents",
  SPEAKER: "/app/speakers",
  TASK: "/app/teams",
  WORKLOAD: "/app/teams",
  BUDGET: "/app/budget",
};

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/**
 * Note on props: this page takes no change callback, because it commits nothing. Every action on
 * it navigates somewhere that owns the decision. The shell reads the same `/command-center`
 * response for its own counts, so there is nothing here for it to be told about.
 */
export function CommandCenter({
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
  const [data, setData] = useState<CommandCenterData | null>(null);
  const [activity, setActivity] = useState<AgentActivityResponse | null>(null);
  const [focus, setFocus] = useState<ApprovalDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const overview = await getCommandCenter();
      setData(overview);

      // The agent activity feed is supporting context, so a failure there must not blank the page.
      getAgentActivity(eventId)
        .then(setActivity)
        .catch(() => setActivity(null));

      // Pull the full detail of the single most consequential waiting decision, because the
      // dominant surface needs its amount and budget impact, and the overview carries only a summary.
      const topApproval = overview.attention_items.find((item) => item.kind === "APPROVAL");
      if (topApproval) {
        const targetEvent = topApproval.event_id ?? eventId;
        getApproval(targetEvent, topApproval.resource_id)
          .then(setFocus)
          .catch(() => setFocus(null));
      } else {
        setFocus(null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the command center.");
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

  const summary = data.summary;
  const attention = data.attention_items;
  const decisions = attention.filter((item) => item.kind === "APPROVAL");
  const activeEvent = data.events.find((e) => e.event_id === eventId) ?? data.events[0];

  // "Handled" is deliberately a short list of aggregate counts. Itemising what the agent did would
  // recreate the inbox this page exists to avoid.
  const handled = [
    { count: activity?.count ?? 0, label: "agent actions logged" },
    { count: activity?.awaiting_approval_count ?? 0, label: "prepared for your decision" },
    { count: summary.overdue_tasks, label: "overdue tasks being chased" },
    { count: summary.unresponsive_speakers, label: "speaker follow-ups drafted" },
  ].filter((item) => item.count > 0);

  const nothingNeedsMe = attention.length === 0;

  return (
    <div>
      {/* 1. Context ------------------------------------------------------- */}
      <header style={{ marginBottom: "var(--s5)" }}>
        <h1 className="t-display" style={{ marginBottom: "var(--s2)" }}>
          {greeting()}.
        </h1>
        <p className="t-body t-muted" style={{ maxWidth: "58ch", fontSize: 16 }}>
          {nothingNeedsMe ? (
            <>
              Nothing needs you right now. CommunityOps is keeping things moving.
              {funMode && " Abhi koi drama nahi. 😌"}
            </>
          ) : (
            <>
              <strong style={{ color: "var(--text)" }}>
                {decisions.length > 0
                  ? `${decisions.length} ${decisions.length === 1 ? "decision needs" : "decisions need"} you.`
                  : `${attention.length} ${attention.length === 1 ? "item needs" : "items need"} your attention.`}
              </strong>{" "}
              Everything else is being handled.
              {funMode && decisions.length > 0 && " Tension lene ka nahi, action lene ka. 😄"}
            </>
          )}
        </p>
      </header>

      {/* 2. The one dominant decision ------------------------------------ */}
      {focus?.approval && focus.approval.status === "PENDING" && (
        <div style={{ marginBottom: "var(--s5)" }}>
          <DominantDecision
            detail={focus}
            onOpen={() => navigate("/app/approvals")}
          />
        </div>
      )}

      {/* When something needs attention but it is not a decision, name it rather than
          leaving the page to imply everything is fine. */}
      {!focus && !nothingNeedsMe && (
        <div style={{ marginBottom: "var(--s5)" }}>
          <Notice tone="warn">
            No decision is waiting, but {attention.length}{" "}
            {attention.length === 1 ? "item needs" : "items need"} attention — see below.
          </Notice>
        </div>
      )}

      {nothingNeedsMe && (
        <div style={{ marginBottom: "var(--s5)" }}>
          <Notice tone="ok">
            No approvals waiting, no open incidents needing a decision, and no overdue work. The
            agent will surface anything that changes.
          </Notice>
        </div>
      )}

      {/* 3. Handled ------------------------------------------------------- */}
      {handled.length > 0 && (
        <div style={{ marginBottom: "var(--s5)" }}>
          <div className="handled">
            <div className="handled-head">
              <span aria-hidden="true">✓</span> CommunityOps is handling
            </div>
            <ul className="handled-list">
              {handled.map((item) => (
                <li className="handled-item" key={item.label}>
                  <span className="handled-count">{item.count}</span>
                  <span>{item.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* 4. Event context ------------------------------------------------- */}
      <div className="split">
        <div className="stack">
          {activeEvent && (
            <Card
              title={activeEvent.name}
              action={
                <HealthPill band={activeEvent.health_band} score={activeEvent.health_score} />
              }
            >
              {activeEvent.health_reasons.length > 0 ? (
                <div className="stack-sm">
                  <div className="t-label">Why this band</div>
                  <ul style={{ paddingLeft: "var(--s5)" }}>
                    {activeEvent.health_reasons.slice(0, 4).map((reason) => (
                      <li className="t-body t-muted" key={reason}>
                        {reason}
                      </li>
                    ))}
                  </ul>
                  <p className="t-meta" style={{ marginTop: "var(--s2)" }}>
                    The score is computed from operational state, not estimated.
                  </p>
                </div>
              ) : (
                <p className="t-body t-muted">No operational risks detected for this event.</p>
              )}
            </Card>
          )}

          {data.events.length > 0 && (
            <Constellation
              events={data.events}
              activeEventId={eventId}
              onSelect={() => navigate("/app")}
            />
          )}
        </div>

        <div className="stack">
          <div className="stat-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Stat
              value={summary.pending_approvals}
              label="Waiting on you"
              tone={summary.pending_approvals > 0 ? "needs-decision" : undefined}
            />
            <Stat
              value={summary.open_incidents}
              label="Open incidents"
              tone={summary.critical_incidents > 0 ? "blocked" : undefined}
              note={summary.critical_incidents > 0 ? `${summary.critical_incidents} critical` : undefined}
            />
            <Stat
              value={summary.overdue_tasks}
              label="Overdue tasks"
              tone={summary.overdue_tasks > 0 ? "overdue" : undefined}
            />
            <Stat
              value={formatInrWithSymbol(summary.budget_remaining_inr)}
              label="Budget remaining"
            />
          </div>

          <Card title="Fun mode" padding="tight">
            <div className="cluster-between">
              <span className="t-meta">
                Occasional light encouragement. Never on money, approvals or incidents.
              </span>
              <button
                className={`btn btn-sm${funMode ? " btn-primary" : ""}`}
                onClick={onToggleFunMode}
                type="button"
                aria-pressed={funMode}
              >
                {funMode ? "On" : "Off"}
              </button>
            </div>
          </Card>
        </div>
      </div>

      {/* 5. Everything else, below the fold ------------------------------ */}
      {attention.length > 0 && (
        <Section title={`Needs attention (${attention.length})`}>
          <Card padding="flush">
            <ul className="rows">
              {attention.map((item, index) => (
                <li key={`${item.kind}-${item.resource_id}-${index}`}>
                  <button
                    className="row"
                    type="button"
                    onClick={() => navigate(ROUTE_FOR[item.kind] ?? "/app")}
                  >
                    <SeverityBadge severity={item.severity} />
                    <div className="row-main">
                      <div className="row-title">{item.title}</div>
                      <div className="row-meta">{item.detail}</div>
                    </div>
                    <div className="row-side">
                      <span className="badge badge-outline">{item.kind}</span>
                      <span className="row-chevron" aria-hidden="true">
                        ›
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      )}

      {activity && activity.activity.length > 0 && (
        <Section
          title="Recent agent activity"
          action={
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => navigate("/app/audit")}>
              Full audit log
            </button>
          }
        >
          <Card padding="flush">
            <ul className="rows">
              {activity.activity.slice(0, 6).map((entry) => (
                <li className="row" key={entry.audit_id}>
                  <div className="row-main">
                    <div className="row-title">{entry.summary}</div>
                    <div className="row-meta">
                      {entry.tool_used ? `${entry.tool_used} · ` : ""}
                      {formatRelative(entry.timestamp)}
                    </div>
                  </div>
                  {entry.outcome === "pending" && (
                    <span className="badge badge-needs-decision">Awaiting you</span>
                  )}
                  {entry.outcome === "failure" && (
                    <span className="badge badge-cannot-automate">Refused</span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      )}

      {role === "TEAM_MEMBER" && (
        <div style={{ marginTop: "var(--s5)" }}>
          <Notice tone="info">
            You are signed in as a team member, so you see your assigned events and teams.
            Approvals, budget and the audit log are reserved for community leaders.
          </Notice>
        </div>
      )}
    </div>
  );
}

/**
 * The dominant decision surface.
 *
 * One decision, its cost, and its effect on the budget. The buttons deliberately live on the
 * Approvals page rather than here: a decision worth this much visual weight deserves the full
 * evidence beside it, and approving from a summary card invites approving without reading.
 */
function DominantDecision({
  detail,
  onOpen,
}: {
  detail: ApprovalDetailResponse;
  onOpen: () => void;
}) {
  const approval = detail.approval;
  const projection = detail.budget_projection;

  return (
    <div className="decision">
      <div className="decision-strip">
        <span aria-hidden="true">●</span> Needs your decision
      </div>
      <div className="decision-body">
        <h2 className="decision-title">{approval.title}</h2>
        <div className="decision-context">
          {approval.requested_by_name || approval.agent_name || "CommunityOps"} ·{" "}
          {formatRelative(approval.requested_at)}
          {approval.budget_category ? ` · ${approval.budget_category}` : ""}
        </div>

        {approval.amount_inr ? (
          <>
            <div className="decision-amount">{formatInrWithSymbol(approval.amount_inr)}</div>
            <p className="t-meta" style={{ marginBottom: "var(--s4)" }}>
              estimated commitment
            </p>
          </>
        ) : null}

        {/* The impact string comes from the backend's own projection, so the figure shown here is
            the figure approving will produce. */}
        {projection && (
          <div className="decision-impact">
            <strong>If you approve:</strong> remaining budget{" "}
            {formatInrWithSymbol(projection.current_remaining)} →{" "}
            {formatInrWithSymbol(projection.projected_remaining)}
            {!projection.affordable && (
              <>
                <br />
                <span style={{ color: "var(--status-blocked)" }}>
                  Not affordable as things stand: {projection.blockers.join(" ")}
                </span>
              </>
            )}
          </div>
        )}

        {approval.agent_recommendation && (
          <p className="t-body t-muted" style={{ marginBottom: "var(--s4)" }}>
            {approval.agent_recommendation}
          </p>
        )}

        <div className="decision-actions">
          <button className="btn btn-primary" type="button" onClick={onOpen}>
            Review and decide
          </button>
        </div>

        <p className="decision-attribution">
          CommunityOps prepared this action. Nothing has been committed — the decision is yours.
        </p>
      </div>
    </div>
  );
}
