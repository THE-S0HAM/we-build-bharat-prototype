/**
 * One prepared action, and what happens to it (design.md §8.7, requirement 5.2).
 *
 * The card answers the page's question — "what needs my decision, and what
 * happens if I approve it?" — in a fixed order: who prepared it, what it would
 * do, why, what it affects, what the evidence states, and then the decision.
 *
 * Three things it deliberately does not do:
 *
 *   - **It does not render evidence.** `readEvidence` reads the object against an
 *     allowlist and this file renders that result, so an unknown key — a
 *     `task_token`, a `workflow_execution_id`, a field added tomorrow — reaches
 *     the page as part of a count and never as text (A8, A11, properties 10, 11).
 *   - **It does not invent a figure.** The financial line renders only when the
 *     evidence states an amount (A10, property 12).
 *   - **It does not map anything to a colour.** Status goes through
 *     `StatusBadge`, risk through `RiskIndicator` — the only two components
 *     allowed to (requirement 12.5).
 *
 * `requested_action` is shown verbatim rather than prettified. It is the string
 * the Edit field is pre-filled with and the string `edited_action` replaces, so
 * showing a friendlier rewrite here would mean the user compared one thing and
 * submitted another.
 */

import { useId } from "react";

import { ApiErrorState } from "../components/ApiErrorState";
import { RiskIndicator } from "../components/RiskIndicator";
import { StatusBadge } from "../components/StatusBadge";
import { formatAbsoluteTime, formatRelativeTime, toMachineTime } from "../lib/formatTime";
import type { Approval } from "../types";
import { ApprovalActions } from "./ApprovalActions";
import {
  consequenceLine,
  DECISION_IS_YOURS,
  DECISION_RECORDED,
  decisionAttribution,
  decisionOutcome,
  PREPARED_BY_COMMUNITYOPS,
  type ApprovalOutcome,
  type DecisionOutcome,
  type DecisionRequest,
} from "./decision";
import {
  financialConsequenceLine,
  readEvidence,
  unrecognisedEvidenceNotice,
} from "./evidence";

import "./ApprovalCard.css";

/** The evidence section heading. Named for what it is *for*, not for the field. */
const EVIDENCE_HEADING = "What this is based on";

/**
 * ## Heading levels
 *
 * The card's title is an `<h2>` and the evidence section an `<h3>`. `PageHeader`
 * renders the page's only `<h1>` and the queue section is named by `aria-label`
 * rather than by a heading, so a card title at `<h3>` would leave the page with
 * an `<h1>` followed by an `<h3>` — a skipped level, and requirement 15.1 asks
 * for a single descending order. `DecisionCard`, the same surface on the Command
 * Center, already titles itself `<h2>` for the same reason.
 */

export interface ApprovalCardProps {
  readonly approval: Approval;

  /** Absent while the approval is still pending and still decidable. */
  readonly outcome: ApprovalOutcome | null;

  readonly onDecide: (request: DecisionRequest) => Promise<DecisionOutcome>;
  readonly canDecide: boolean;
}

export function ApprovalCard({ approval, outcome, onDecide, canDecide }: ApprovalCardProps) {
  const titleId = useId();
  const evidence = readEvidence(approval.evidence);
  const requestedAt = toMachineTime(approval.requested_at);

  // An approval somebody else decided is no longer a decision surface, so the
  // card keeps its title for context and says what happened (requirement 5.6).
  if (outcome?.kind === "unavailable") {
    return (
      <article className="card approval-card approval-card--settled" aria-labelledby={titleId}>
        <h2 className="approval-card__title" id={titleId}>
          {approval.title}
        </h2>
        <ApiErrorState error={outcome.error} context="action" />
      </article>
    );
  }

  return (
    <article className="card approval-card" aria-labelledby={titleId}>
      <div className="approval-card__head">
        <div className="approval-card__heading">
          <h2 className="approval-card__title" id={titleId}>
            {approval.title}
          </h2>
          {outcome === null ? (
            <p className="approval-card__prepared">
              {PREPARED_BY_COMMUNITYOPS} {DECISION_IS_YOURS}
            </p>
          ) : null}
        </div>

        <div className="approval-card__signals">
          <StatusBadge
            domain="approval"
            status={outcome === null ? approval.status : outcome.decision}
          />
          <RiskIndicator level={approval.risk_level} />
        </div>
      </div>

      <p className="approval-card__description">{approval.description}</p>

      <dl className="approval-card__facts">
        <div className="approval-card__fact">
          <dt className="approval-card__fact-label">Prepared action</dt>
          <dd className="approval-card__fact-value">
            <code className="approval-card__action">{approval.requested_action}</code>
          </dd>
        </div>
        <div className="approval-card__fact">
          <dt className="approval-card__fact-label">Why</dt>
          <dd className="approval-card__fact-value">{approval.reason}</dd>
        </div>
        <div className="approval-card__fact">
          <dt className="approval-card__fact-label">Agent</dt>
          <dd className="approval-card__fact-value">{approval.agent_name}</dd>
        </div>
        <div className="approval-card__fact">
          <dt className="approval-card__fact-label">Affects</dt>
          <dd className="approval-card__fact-value">
            {approval.affected_resource_type} {approval.affected_resource_id}
          </dd>
        </div>
        <div className="approval-card__fact">
          <dt className="approval-card__fact-label">Waiting since</dt>
          <dd className="approval-card__fact-value">
            {/* One formatter for every timestamp in the product, with the
                absolute time on the element itself (design.md §7.1). */}
            <time
              dateTime={requestedAt ?? undefined}
              title={formatAbsoluteTime(approval.requested_at)}
            >
              {formatRelativeTime(approval.requested_at)}
            </time>
          </dd>
        </div>
      </dl>

      {evidence.rows.length === 0 && evidence.unrecognisedCount === 0 ? null : (
        <section className="approval-card__evidence">
          <h3 className="approval-card__evidence-heading">{EVIDENCE_HEADING}</h3>

          {evidence.rows.length === 0 ? null : (
            <dl className="approval-card__evidence-rows">
              {evidence.rows.map((row) => (
                <div className="approval-card__fact" key={row.key}>
                  <dt className="approval-card__fact-label">{row.label}</dt>
                  <dd className="approval-card__fact-value">{row.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {/* Every key that is not allowlisted, represented by its count and by
              nothing else (requirement 5.9). */}
          {evidence.unrecognisedCount === 0 ? null : (
            <p className="approval-card__evidence-rest">
              {unrecognisedEvidenceNotice(evidence.unrecognisedCount)}
            </p>
          )}
        </section>
      )}

      {/* Only when the evidence states a figure (requirement 5.10, A10). */}
      {evidence.amount === null ? null : (
        <p className="approval-card__financial">{financialConsequenceLine(evidence.amount)}</p>
      )}

      {outcome === null && !canDecide ? (
        <p className="approval-card__consequence">A community leader must decide this request. Your role can review its status but cannot approve, edit or decline it.</p>
      ) : outcome === null ? (
        <>
          <p className="approval-card__consequence">
            {consequenceLine(approval.requested_action)}
          </p>
          <ApprovalActions
            requestedAction={approval.requested_action}
            onDecide={onDecide}
          />
        </>
      ) : (
        /* The action row, replaced in place by the result (requirement 13.11).
           No continuation claim: the outcome sentence states what will and will
           not happen, and nothing says the execution resumes (A9). */
        <div className="approval-card__result">
          <p className="approval-card__result-headline">{DECISION_RECORDED}</p>
          <p className="approval-card__result-outcome">
            {decisionOutcome(outcome.decision, approval.requested_action)}
          </p>
          <p className="approval-card__result-attribution">
            {decisionAttribution(outcome.decision)}
          </p>
        </div>
      )}
    </article>
  );
}
