import { useId, useState, type ReactNode } from "react";

import { readEvidence, unrecognisedEvidenceNote } from "../lib/approvalEvidence";
import { consequenceFor } from "../lib/decisionConsequence";
import { formatAbsoluteTime, formatRelativeTime, toMachineTime } from "../lib/formatTime";
import { humaniseUnknownValue } from "../lib/unknownValue";
import type { Approval } from "../types";
import { Drawer } from "./Drawer";
import { RiskIndicator } from "./RiskIndicator";
import { StatusBadge } from "./StatusBadge";
import "./DecisionCard.css";

/**
 * `DecisionCard` — the product's one decision surface (design.md §7, §8.1, §8.7).
 *
 * The Command Center renders exactly one of these, for the oldest pending
 * approval across watched events (requirement 4.3); Approvals renders a queue of
 * them. Identical markup in both places is the point: a decision must never look
 * like two different things.
 *
 * ## What is on the card, and what is behind the affordance
 *
 * Requirement 4.9 is explicit — on the Command Center the agent's *reasoning* is
 * reachable only through "Why this action?", which opens the shared `Drawer`.
 * There is deliberately **no** prominent "CommunityOps recommends" card: the
 * leader sees what is being asked, what it affects and what follows from each
 * answer, and reaches for the reasoning if they want it.
 *
 * So the card carries: operational state, risk, the action's own title, what
 * CommunityOps is asking to do, what it affects, the consequence of each answer,
 * the framing line, and the actions. The drawer carries the proposal text, the
 * reason, the allowlisted evidence and the timing. Approvals shows the reason on
 * the card as well (§8.7), which is what `showReasonInline` is for.
 *
 * ## What it refuses to render
 *
 *   - **Anything outside `Approval` in `src/types.ts`.** The interface is the
 *     security allowlist (A8): `task_token` and `workflow_execution_id` are not
 *     modelled, so they cannot reach this component, let alone the DOM.
 *   - **Raw evidence.** Rows come from `readEvidence`, which renders an
 *     allowlist and counts the rest (A11). No `JSON.stringify`, anywhere.
 *   - **A figure nothing recorded.** The financial line renders only when
 *     `evidence` carries a recognised amount field (A10).
 *
 * The card holds no mutation state. Submitting a decision belongs to the
 * `actions` slot, so there is one place in the product where a decision is sent.
 */

/** §15.2: the exact affordance wording for opening the reasoning behind an action. */
export const WHY_THIS_ACTION = "Why this action?";

/** §1.2: the decision framing line, used on this surface and on Approvals. */
const DECISION_FRAMING = "Faisla aapka.";

/** §8.7 attribution: CommunityOps prepared it, the person decides it. */
const AGENT_ATTRIBUTION = "CommunityOps prepared this action";

export interface DecisionCardProps {
  readonly approval: Approval;

  /**
   * The decision controls. Supplied by the page so that submitting a decision
   * stays in one component rather than being re-implemented per surface.
   */
  readonly actions?: ReactNode;

  /**
   * Render the agent's reason on the card itself. Off by default, because the
   * Command Center may only show it behind "Why this action?" (requirement 4.9).
   * Approvals turns it on (§8.7).
   */
  readonly showReasonInline?: boolean;

  /** Reference point for relative time; pass it to keep rendering deterministic. */
  readonly now?: Date;
}

export function DecisionCard({
  approval,
  actions,
  showReasonInline = false,
  now,
}: DecisionCardProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const headingId = useId();

  const consequence = consequenceFor(approval.requested_action);
  const evidence = readEvidence(approval.evidence);
  const evidenceNote = unrecognisedEvidenceNote(evidence.unrecognisedCount);
  const requestedAction =
    humaniseUnknownValue(approval.requested_action) ?? "Action not named";
  const machineTime = toMachineTime(approval.requested_at);
  const reason = approval.reason.trim();

  return (
    <section className="card decision-card" aria-labelledby={headingId}>
      <div className="decision-card__states">
        {/* The only component that maps a status to a colour (requirement 12.5).
            A pending approval reads "Needs your decision" — never "Pending". */}
        <StatusBadge domain="approval" status={approval.status} />
        <RiskIndicator level={approval.risk_level} />
      </div>

      <h2 className="decision-card__title" id={headingId}>
        {approval.title}
      </h2>

      <p className="decision-card__attribution">
        <span>{AGENT_ATTRIBUTION}</span>
        <span className="decision-card__agent">{approval.agent_name}</span>
        <time
          className="decision-card__time"
          dateTime={machineTime ?? undefined}
          title={formatAbsoluteTime(approval.requested_at)}
        >
          {formatRelativeTime(approval.requested_at, now ?? new Date())}
        </time>
      </p>

      <dl className="decision-card__facts">
        <div className="decision-card__fact">
          <dt>Requested action</dt>
          <dd>{requestedAction}</dd>
        </div>

        <div className="decision-card__fact">
          <dt>Affects</dt>
          <dd>
            {approval.affected_resource_type} {approval.affected_resource_id}
          </dd>
        </div>

        {/* A10: present only when `evidence` recorded an amount. There is no
            branch in this component that can produce a figure otherwise. */}
        {evidence.financial === null ? null : (
          <div className="decision-card__fact">
            <dt>{evidence.financial.label}</dt>
            <dd>{evidence.financial.value}</dd>
          </div>
        )}
      </dl>

      {/* Both answers, stated before either is taken: this is the whole of
          "what happens if I approve it?" (§8.7). Neither sentence claims the
          workflow resumes — it does not (A9). */}
      <div className="decision-card__consequence">
        <p>
          <span className="decision-card__consequence-label">Approve</span>
          {consequence.approve}
        </p>
        <p>
          <span className="decision-card__consequence-label">Decline</span>
          {consequence.decline}
        </p>
      </div>

      {showReasonInline && reason !== "" ? (
        <p className="decision-card__reason">{reason}</p>
      ) : null}

      <p className="decision-card__framing">{DECISION_FRAMING}</p>

      <div className="decision-card__actions">
        <button
          type="button"
          className="btn decision-card__why"
          onClick={() => setReasoningOpen(true)}
        >
          {WHY_THIS_ACTION}
        </button>

        {actions}
      </div>

      <Drawer
        open={reasoningOpen}
        onClose={() => setReasoningOpen(false)}
        title={WHY_THIS_ACTION}
        description={approval.title}
      >
        <div className="decision-reasoning">
          <section className="decision-reasoning__block">
            <h3>What CommunityOps proposes</h3>
            <p>{approval.description}</p>
          </section>

          {reason === "" ? null : (
            <section className="decision-reasoning__block">
              <h3>Why CommunityOps proposes it</h3>
              <p>{reason}</p>
            </section>
          )}

          <section className="decision-reasoning__block">
            <h3>Evidence</h3>
            {evidence.rows.length === 0 ? (
              <p>No evidence rows were recorded with this action.</p>
            ) : (
              <dl className="decision-reasoning__evidence">
                {evidence.rows.map((row) => (
                  <div className="decision-reasoning__row" key={row.key}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {/* A11: counted, never serialized. */}
            {evidenceNote === null ? null : (
              <p className="decision-reasoning__note">{evidenceNote}</p>
            )}
          </section>

          <section className="decision-reasoning__block">
            <h3>Affected resource</h3>
            <p>
              {approval.affected_resource_type} {approval.affected_resource_id}
            </p>
          </section>

          <section className="decision-reasoning__block">
            <h3>Requested</h3>
            {/* The absolute timestamp lives in the drawer (§7.1). */}
            <p>{formatAbsoluteTime(approval.requested_at)}</p>
          </section>
        </div>
      </Drawer>
    </section>
  );
}
