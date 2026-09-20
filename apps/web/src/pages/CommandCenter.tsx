import { useCallback, useEffect, useState } from "react";

import {
  decideApproval,
  getApprovals,
  getAttention,
  getAuditLog,
  getBrief,
  getCommandCenter,
  getEventHealth,
  humanize,
} from "../api";
import { ApprovalActions } from "../approvals/ApprovalActions";
import {
  decisionAttribution,
  recordedAnnouncement,
  type ApprovalDecision,
  type ApprovalOutcome,
  type DecisionOutcome,
  type DecisionRequest,
} from "../approvals/decision";
import { getIdToken } from "../auth";
import { AgentStatus } from "../command/AgentStatus";
import { EventOrbit } from "../command/EventOrbit";
import {
  CALM_DESCRIPTION,
  CALM_TITLE,
  DECISION_RECORDED,
  eventsWithPendingApprovals,
  greeting,
  HANDLED_EMPTY,
  HANDLED_HEADING,
  LOADING_LABEL,
  NO_DECISION_DESCRIPTION,
  NO_DECISION_TITLE,
  nothingNeedsYou,
  ORG_WIDE_EMPTY,
  ORG_WIDE_HEADING,
  toWatchedEventViews,
  watchedEventLine,
} from "../command/commandView";
import { ApiErrorState } from "../components/ApiErrorState";
import { DecisionCard } from "../components/DecisionCard";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Skeleton, SkeletonRegion } from "../components/Skeleton";
import { useEventContext } from "../event/eventContext";
import { outcomeFor } from "../lib/decisionConsequence";
import { readDisplayName } from "../lib/displayName";
import { failurePolicy } from "../lib/errorCategory";
import { useApiFailure } from "../session/useApiFailure";
import { useSession } from "../session/sessionContext";
import type {
  Approval,
  AttentionItem,
  AuditEvent,
  CommandCenterData,
  EventHealth,
  OperationsBrief,
} from "../types";

import "./CommandCenter.css";
import "./OperationalPages.css";

/**
 * The Command Center (design.md §8.1, requirement 4).
 *
 * One question: **is anything waiting on me right now?** The page answers it in
 * four blocks, in this order, and nothing else is on it:
 *
 *   1. the greeting — the `name` claim, the active organization, and the watched
 *      event count from `summary.active_events` (requirements 4.1, 4.2);
 *   2. **one** decision surface — the oldest pending approval across watched
 *      events — or one calm sentence (requirements 4.3, 4.8, 4.11);
 *   3. the orbit, the page's single contextual visual (requirements 4.4, 4.5);
 *   4. the "CommunityOps is handling" strip for the active event, with the
 *      organization-wide feed below it, labelled as such (requirements 4.6, 4.7).
 *
 * ## What used to be here and is deliberately gone
 *
 * The stat-card grid, the event-health table and the raw recent-actions list.
 * design.md §8.1 lists a KPI wall, a stat-card grid, a chart panel and a
 * notification feed under "Not present": four numbers in a row answer "how is
 * the operation doing", which is a different question and a slower one. Summary
 * metrics now live in exactly two places — the greeting context line and the
 * visual (requirement 4.10).
 *
 * There is also **no "CommunityOps recommends" card**. The agent's reasoning is
 * reachable only behind "Why this action?", which opens the shared `Drawer`
 * (requirement 4.9). The leader sees what is being asked and what follows from
 * each answer; the reasoning is there if they want it.
 *
 * ## Where each number comes from
 *
 *   - **A13** — the headline count is `summary.active_events`, never
 *     `total_events`, because `events[]` carries ACTIVE and PUBLISHED events
 *     while `total_events` counts drafts too. A total appears only as
 *     "of N total".
 *   - **A12** — the handled strip is `GET /events/{eventId}/audit` for the
 *     *active* event, filtered to agent actors. `recent_actions` from
 *     `/command-center` is the newest ten across every event, so it is rendered
 *     below and labelled organization-wide rather than passed off as this
 *     event's work.
 *   - **A10 / A11** — the decision surface renders evidence through the
 *     allowlist in `DecisionCard`, so a figure appears only when the evidence
 *     records one and an unrecognised key is counted rather than serialized.
 *   - **A9** — post-decision copy is "Decision recorded." plus the concrete
 *     outcome. The Step Functions callback is not wired, so nothing here claims
 *     that execution continues.
 *
 * ## Four requests, four failure scopes
 *
 * `/command-center` failing is the view failing, so the shared error state
 * replaces the body with a retry that re-runs only that request. The approvals
 * lookup, the handled strip and the decision submission each keep their failure
 * inside their own region, so one broken strip never blanks the page
 * (requirement 13.8).
 */

/** The decision region's heading, used as its accessible name. */
const DECISION_REGION_LABEL = "Needs your decision";

/** The handled strip's scope sentence, completed with the active event's name. */
function handledDescription(eventName: string | null): string {
  return eventName === null
    ? "The newest actions CommunityOps has taken for the active event."
    : `The newest actions CommunityOps has taken for ${eventName}.`;
}

/** Requirement 4.7 — the label says organization-wide, and so does the sentence. */
function orgWideDescription(organizationId: string): string {
  return `The newest actions across every event in ${organizationId}, not just this one.`;
}

/**
 * The loading shape: the same three blocks the page resolves into (design.md
 * §8.1, requirement 13.1). The greeting's context line has its own placeholder
 * in the header, so nothing moves when the data lands.
 */
function CommandCenterSkeleton() {
  return (
    <SkeletonRegion label={LOADING_LABEL}>
      <div className="command-center__skeleton">
        <Skeleton shape="block" />
        <Skeleton shape="block" />
        <Skeleton shape="block" />
      </div>
    </SkeletonRegion>
  );
}

/**
 * The recorded decision, in place of the action row (requirement 13.11).
 *
 * "Decision recorded." plus the concrete outcome, and no third sentence claiming
 * the workflow resumes (A9). The attribution names both parties: CommunityOps
 * prepared it, the person decided it (requirement 5.8).
 */
function DecisionResult({
  requestedAction,
  decision,
}: {
  readonly requestedAction: string;
  readonly decision: ApprovalDecision;
}) {
  return (
    <div className="command-center__result">
      <p className="command-center__result-headline">{DECISION_RECORDED}</p>
      <p className="command-center__result-outcome">{outcomeFor(requestedAction, decision)}</p>
      <p className="command-center__result-attribution">{decisionAttribution(decision)}</p>
    </div>
  );
}

function OperationalState({
  health,
  brief,
}: {
  readonly health: EventHealth;
  readonly brief: OperationsBrief;
}) {
  const priorities = brief.recommended_priority.slice(0, 3);
  const reviewSummary = brief.decisions_required === 0 && brief.high_risk_items === 0
    ? "No decisions or high-risk items need review."
    : `${brief.decisions_required} ${brief.decisions_required === 1 ? "decision" : "decisions"} and ${brief.high_risk_items} high-risk ${brief.high_risk_items === 1 ? "item" : "items"} need review.`;

  return (
    <div className="command-center__operational-state">
      <p className="page-section__description">
        <strong>{humanize(health.health_band)}.</strong> {health.health_summary}
      </p>
      <p className="page-section__description">
        CommunityOps is progressing {brief.tasks_progressing} {brief.tasks_progressing === 1 ? "task" : "tasks"}. {reviewSummary}
      </p>
      {priorities.length === 0 ? (
        <p className="page-section__empty">No recommended priorities right now.</p>
      ) : (
        <ol className="ops-list" aria-label="Recommended priorities">
          {priorities.map((priority) => (
            <li className="ops-list__item" key={priority}>{priority}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

function mostConsequentialApproval(approvals: readonly Approval[]): Approval | null {
  const severity: Record<Approval["risk_level"], number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  return [...approvals]
    .filter((approval) => approval.status === "PENDING")
    .sort((left, right) => Number(Boolean(right.amount_inr)) - Number(Boolean(left.amount_inr)) || severity[right.risk_level] - severity[left.risk_level] || (right.amount_inr ?? 0) - (left.amount_inr ?? 0))[0] ?? null;
}

export function CommandCenter() {
  const { activeEvent, activeEventId, setActiveEvent } = useEventContext();
  const { user } = useSession();
  const canDecide = user?.role === "LEADER";
  const report = useApiFailure();

  const [overview, setOverview] = useState<CommandCenterData | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewFailure, setOverviewFailure] = useState<unknown>(null);
  const [overviewToken, setOverviewToken] = useState(0);

  const [approval, setApproval] = useState<Approval | null>(null);
  const [approvalFailure, setApprovalFailure] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<ApprovalOutcome | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const [handled, setHandled] = useState<readonly AuditEvent[]>([]);
  const [handledLoading, setHandledLoading] = useState(false);
  const [handledFailure, setHandledFailure] = useState<unknown>(null);
  const [attention, setAttention] = useState<readonly AttentionItem[]>([]);
  const [attentionLoading, setAttentionLoading] = useState(false);
  const [attentionFailure, setAttentionFailure] = useState<unknown>(null);
  const [attentionToken, setAttentionToken] = useState(0);
  const [handledToken, setHandledToken] = useState(0);

  const [health, setHealth] = useState<EventHealth | null>(null);
  const [brief, setBrief] = useState<OperationsBrief | null>(null);
  const [operationalLoading, setOperationalLoading] = useState(false);
  const [operationalFailure, setOperationalFailure] = useState<unknown>(null);
  const [operationalToken, setOperationalToken] = useState(0);

  const [displayName, setDisplayName] = useState<string | null>(null);

  /** Re-runs `/command-center` and the approvals lookup behind it, only. */
  const reloadOverview = useCallback(() => {
    setOverviewToken((token) => token + 1);
  }, []);

  /** Re-runs the handled strip's audit request, only (requirement 13.3). */
  const reloadHandled = useCallback(() => {
    setHandledToken((token) => token + 1);
  }, []);

  const reloadAttention = useCallback(() => {
    setAttentionToken((token) => token + 1);
  }, []);

  const reloadOperationalState = useCallback(() => {
    setOperationalToken((token) => token + 1);
  }, []);

  // The name in the greeting. The token is read for the claim and discarded
  // immediately; nothing here holds or logs it (requirement 16.9).
  useEffect(() => {
    let cancelled = false;

    void getIdToken().then(
      (token) => {
        if (!cancelled) setDisplayName(readDisplayName(token));
      },
      () => {
        // No name to greet with, so the page name is rendered instead (A2).
      },
    );

    return () => {
      cancelled = true;
    };
  }, []);

  // The view, and then the one decision it may carry.
  useEffect(() => {
    let cancelled = false;

    setOverviewLoading(true);
    setOverviewFailure(null);
    setApproval(null);
    setApprovalFailure(null);
    setOutcome(null);

    void (async () => {
      let data: CommandCenterData;

      try {
        data = await getCommandCenter();
      } catch (error: unknown) {
        if (cancelled) return;
        setOverviewFailure(report(error));
        setOverviewLoading(false);
        return;
      }

      if (cancelled) return;
      setOverview(data);
      setOverviewLoading(false);

      // Only events the response says have a pending approval are asked for
      // one, so a calm operation issues no second request at all.
      const sources = eventsWithPendingApprovals(data.events);

      if (sources.length === 0) return;

      const settled = await Promise.allSettled(
        sources.map((event) => getApprovals(event.event_id)),
      );

      if (cancelled) return;

      const pending = settled.flatMap((result) =>
        result.status === "fulfilled" ? result.value.approvals : [],
      );
      const selected = mostConsequentialApproval(pending);

      if (selected !== null) {
        setApproval(selected);
        return;
      }

      // Nothing to show *and* something failed: the region says so rather than
      // reporting a calm operation it cannot vouch for (requirement 13.8).
      const rejection = settled.find((result) => result.status === "rejected");

      if (rejection !== undefined) {
        setApprovalFailure(report(rejection.reason));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [overviewToken, report]);

  // The handled strip, for the active event (requirement 4.6, A12).
  useEffect(() => {
    if (activeEventId === null) {
      setHandled([]);
      setHandledLoading(false);
      setHandledFailure(null);
      return;
    }

    let cancelled = false;

    setHandledLoading(true);
    setHandledFailure(null);

    void getAuditLog(activeEventId).then(
      (page) => {
        if (cancelled) return;
        setHandled(page.audit_events);
        setHandledLoading(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        setHandledFailure(report(error));
        setHandledLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [activeEventId, handledToken, report]);

  useEffect(() => {
    if (activeEventId === null) { setAttention([]); setAttentionLoading(false); setAttentionFailure(null); return; }
    let active = true;
    setAttentionLoading(true);
    setAttentionFailure(null);
    getAttention(activeEventId).then(
      (result) => { if (active) { setAttention(result.attention_items); setAttentionLoading(false); } },
      (error: unknown) => { if (active) { setAttention([]); setAttentionFailure(report(error)); setAttentionLoading(false); } },
    );
    return () => { active = false; };
  }, [activeEventId, attentionToken, report]);

  useEffect(() => {
    if (activeEventId === null) {
      setHealth(null);
      setBrief(null);
      setOperationalLoading(false);
      setOperationalFailure(null);
      return;
    }

    let active = true;
    setOperationalLoading(true);
    setOperationalFailure(null);
    setHealth(null);
    setBrief(null);

    Promise.all([getEventHealth(activeEventId), getBrief(activeEventId)]).then(
      ([nextHealth, nextBrief]) => {
        if (!active) return;
        setHealth(nextHealth);
        setBrief(nextBrief);
        setOperationalLoading(false);
      },
      (error: unknown) => {
        if (!active) return;
        setOperationalFailure(report(error));
        setOperationalLoading(false);
      },
    );

    return () => { active = false; };
  }, [activeEventId, operationalToken, report]);

  /**
   * Submit one decision.
   *
   * `ApprovalActions` guarantees a single request per user action and locks the
   * controls until this resolves. What is decided here is what happens to the
   * card afterwards:
   *
   *   - **settled** — the decision was recorded, or the failure means this is no
   *     longer a decision surface (already decided elsewhere, no access, the
   *     record is gone). The action row is replaced in place.
   *   - **retryable** — a transient failure. The card stays decidable and the
   *     action row explains itself.
   */
  async function decide(request: DecisionRequest): Promise<DecisionOutcome> {
    if (approval === null) return { kind: "settled" };

    try {
      await decideApproval(
        approval.event_id,
        approval.approval_id,
        request.decision,
        request.notes,
        request.editedAction,
      );
    } catch (error: unknown) {
      const reported = report(error);

      // `null` is an ended session: the guard is already returning the visitor
      // to sign-in and requirement 1.8 allows no notification on the way.
      if (reported === null) return { kind: "settled" };

      if (failurePolicy(error).retryable) {
        return { kind: "retryable", error: reported };
      }

      setOutcome({ kind: "unavailable", error: reported });
      return { kind: "settled" };
    }

    // The card's own status badge moves with the decision, so "Decision
    // recorded." never sits above a badge still reading "Needs your decision".
    setApproval({ ...approval, status: request.decision });
    setOutcome({ kind: "decided", decision: request.decision });
    setAnnouncement(recordedAnnouncement(approval.title, request.decision));

    return { kind: "settled" };
  }

  const watched = overview === null ? [] : toWatchedEventViews(overview.events);

  const contextLine = overviewLoading ? (
    <Skeleton shape="line" width="narrow" />
  ) : overview === null ? undefined : (
    <>
      <span className="command-center__organization">{overview.organization_id}</span>
      <span className="command-center__watched">{watchedEventLine(overview.summary)}</span>
    </>
  );

  return (
    <div className="page command-center">
      <PageHeader title={greeting(displayName)} context={contextLine} />

      {/* Decision results are announced here (requirement 15.8). The region is
          in the DOM from first render so it is already being observed when the
          sentence arrives. */}
      <p className="command-center__announcement" role="status" aria-live="polite">
        {announcement}
      </p>

      {overviewLoading ? (
        <CommandCenterSkeleton />
      ) : overviewFailure !== null ? (
        /* The view itself did not load. "Try again" re-runs this request only. */
        <ApiErrorState error={overviewFailure} onRetry={reloadOverview} />
      ) : (
        <>
          <section className="command-center__decision" aria-label={DECISION_REGION_LABEL}>
            {approval !== null ? (
              <DecisionCard
                approval={approval}
                actions={
                  outcome === null ? (
                    canDecide ? <ApprovalActions
                      requestedAction={approval.requested_action}
                      onDecide={decide}
                    /> : <p className="page-section__description">A community leader must decide this request.</p>
                  ) : outcome.kind === "decided" ? (
                    <DecisionResult
                      requestedAction={approval.requested_action}
                      decision={outcome.decision}
                    />
                  ) : (
                    /* Already decided elsewhere, or otherwise no longer ours to
                       decide. `role="alert"` on the error announces it. */
                    <ApiErrorState error={outcome.error} context="action" />
                  )
                }
              />
            ) : approvalFailure !== null ? (
              <ApiErrorState error={approvalFailure} onRetry={reloadOverview} />
            ) : nothingNeedsYou(watched) ? (
              /* Requirement 4.8 — calm, and not blank: the handled strip below
                 shows what CommunityOps has been doing. */
              <EmptyState title={CALM_TITLE} description={CALM_DESCRIPTION} />
            ) : (
              <EmptyState title={NO_DECISION_TITLE} description={NO_DECISION_DESCRIPTION} />
            )}
          </section>

          <EventOrbit
            events={watched}
            activeEventId={activeEventId}
            onSelect={setActiveEvent}
          />

          <AgentStatus
            heading={HANDLED_HEADING}
            description={handledDescription(activeEvent?.name ?? null)}
            events={handled}
            loading={handledLoading}
            failure={handledFailure}
            onRetry={reloadHandled}
            emptyMessage={HANDLED_EMPTY}
          />

          <section className="page-section" aria-labelledby="command-attention-heading">
            <h2 className="page-section__heading" id="command-attention-heading">Attention after the top decision</h2>
            {attentionLoading ? <Skeleton shape="line" /> : attentionFailure !== null ? <ApiErrorState error={attentionFailure} onRetry={reloadOverview} /> : attention.length === 0 ? <p className="page-section__empty">Nothing else needs attention for this event.</p> : <ul className="ops-list">{attention.filter((item) => item.resource_id !== approval?.approval_id).map((item) => <li className="ops-list__item" key={`${item.kind}-${item.resource_id}`}><p className="ops-list__title">{item.title}</p><p className="ops-list__meta">{item.severity} · {item.detail}</p></li>)}</ul>}
          </section>

          {overview === null ? null : (
            <AgentStatus
              heading={ORG_WIDE_HEADING}
              description={orgWideDescription(overview.organization_id)}
              events={overview.recent_actions}
              facets={["agent", "person", "system"]}
              emptyMessage={ORG_WIDE_EMPTY}
            />
          )}
        </>
      )}
    </div>
  );
}
