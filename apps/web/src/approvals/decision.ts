/**
 * The words Approvals uses about a decision, in one place.
 *
 * Every sentence in this module is reviewed copy from requirement 5 and
 * design.md §8.7. Two constraints shape all of it, and both come from the
 * repository rather than from preference:
 *
 *   1. **Human authority stays explicit.** CommunityOps *prepares* an action; a
 *      person decides it. Nothing here says "CommunityOps decided", and every
 *      post-decision sentence names the user as the decider (requirement 5.8).
 *
 *   2. **No continuation claim** (A9). `approvals_handler._decide_approval`
 *      records the decision and never calls `SendTaskSuccess` or
 *      `SendTaskFailure`, so the Step Functions execution waiting on the task
 *      token does **not** resume when a decision is recorded. Copy that said
 *      "CommunityOps will continue from here" would be false. So the approved
 *      outcome is requirement 5.7's own sentence — "CommunityOps will proceed
 *      with this action." — and nothing in this module promises a side effect
 *      that the callback would be responsible for delivering. The declined
 *      outcome is safe to state concretely, because declining means nothing
 *      happens, and that is true today: "CommunityOps will not send this
 *      follow-up."
 *
 * Continuation phrasing becomes available the day the callback is wired, and
 * this is the one file that has to change for it.
 */

import { readTableEntry } from "../lib/unknownValue";
import type { Approval } from "../types";

/**
 * The three decisions `PUT /events/{eventId}/approvals/{approvalId}` accepts.
 *
 * Derived from `Approval["status"]` rather than retyped, so a backend status
 * this union names and the contract drops is a compile error here.
 */
export type ApprovalDecision = Extract<
  Approval["status"],
  "APPROVED" | "DECLINED" | "EDITED"
>;

/**
 * One decision, as the user expressed it.
 *
 * `editedAction` is a single free-text string because that is the whole of the
 * contract: `_decide_approval` accepts `decision="EDITED"` plus one
 * `edited_action`, and `Approval.edited_action` is a plain string (A4). There is
 * no per-field shape to model, so none is invented here.
 */
export interface DecisionRequest {
  readonly decision: ApprovalDecision;
  readonly notes: string;
  readonly editedAction?: string;
}

/**
 * What the page did with a submitted decision, told back to the action row.
 *
 * `settled` means the page has taken the card over — it is showing the recorded
 * decision, or the "already decided elsewhere" replacement, or the visitor is on
 * their way back to sign-in. `retryable` means the card stays decidable and the
 * action row should unlock and explain the failure.
 */
export type DecisionOutcome =
  | { readonly kind: "settled" }
  | { readonly kind: "retryable"; readonly error: unknown };

/**
 * What has happened to a queued approval in this session.
 *
 * `decided` is the recorded decision, shown in place of the action row
 * (requirements 5.7, 13.11). `unavailable` is an approval that stopped being a
 * decision surface — the 409 that means somebody else got there first
 * (requirement 5.6). Absent means still pending, still decidable.
 */
export type ApprovalOutcome =
  | { readonly kind: "decided"; readonly decision: ApprovalDecision }
  | { readonly kind: "unavailable"; readonly error: unknown };

/* --- Canonical labels (requirement 12.8, design.md §15.2) ----------------- */

export const APPROVE_LABEL = "Approve";
export const EDIT_LABEL = "Edit";
export const DECLINE_LABEL = "Decline";

/* --- Framing and structural copy ----------------------------------------- */

/** Rendered once, as the queue's framing line (requirement 5.13). */
export const QUEUE_FRAMING = "Faisla aapka.";

/** Requirement 5.12. */
export const EMPTY_QUEUE_TITLE = "Nothing needs your decision.";

/** Requirement 5.7. */
export const DECISION_RECORDED = "Decision recorded.";

/** Requirement 5.8. The agent prepared it; the person decides it. */
export const PREPARED_BY_COMMUNITYOPS = "CommunityOps prepared this action.";

/** The second half of the pending attribution, so authority is never implied. */
export const DECISION_IS_YOURS = "The decision is yours.";

/** A4 — the exact copy the edit field is framed with. */
export const EDIT_FIELD_LABEL = "Adjust the action CommunityOps will take";

/** Requirement 5.4 — a note is required, and it is on the record. */
export const DECLINE_NOTE_LABEL = "Why are you declining?";
export const AUDIT_TRAIL_NOTICE = "Your note is recorded in the audit trail.";

/* --- Outcomes ------------------------------------------------------------- */

/** Requirement 5.7's approved sentence, verbatim. Claims no continuation (A9). */
const PROCEED = "CommunityOps will proceed with this action.";

const PROCEED_EDITED = "CommunityOps will proceed with the action as you edited it.";

/** The generic decline outcome, for a requested action with no specific wording. */
const WILL_NOT_PROCEED = "CommunityOps will not take this action.";

/**
 * Concrete decline outcomes for the requested actions the backend issues today
 * (`SEND_SPEAKER_FOLLOWUP` and `RESOLVE_INCIDENT` are the two the seed data and
 * the workflows produce). An action outside this table falls back to the generic
 * sentence rather than to a guess about what declining prevents.
 */
const DECLINE_OUTCOMES: Readonly<Record<string, string>> = {
  SEND_SPEAKER_FOLLOWUP: "CommunityOps will not send this follow-up.",
  RESOLVE_INCIDENT: "CommunityOps will not resolve this incident.",
  ASSIGN_BACKUP_SPEAKER: "CommunityOps will not assign this backup speaker.",
  ESCALATE_TASK: "CommunityOps will not escalate this task.",
};

/** What declining this action prevents, stated concretely where that is known. */
export function declinedOutcome(requestedAction: string): string {
  return readTableEntry(DECLINE_OUTCOMES, requestedAction) ?? WILL_NOT_PROCEED;
}

/** The outcome sentence shown beside "Decision recorded." (requirement 5.7). */
export function decisionOutcome(
  decision: ApprovalDecision,
  requestedAction: string,
): string {
  switch (decision) {
    case "APPROVED":
      return PROCEED;
    case "EDITED":
      return PROCEED_EDITED;
    case "DECLINED":
      return declinedOutcome(requestedAction);
  }
}

/**
 * The consequence line on a pending card (requirement 5.2): both outcomes, so
 * the user can see what each choice does before choosing.
 */
export function consequenceLine(requestedAction: string): string {
  return `If you approve, ${PROCEED} If you decline, ${declinedOutcome(requestedAction)}`;
}

/** Past-tense attribution to the user, never to the product. */
const DECIDED_BY_YOU: Record<ApprovalDecision, string> = {
  APPROVED: "You approved it.",
  EDITED: "You approved it with your edits.",
  DECLINED: "You declined it.",
};

/** Requirement 5.8 — who prepared it, and who decided it. */
export function decisionAttribution(decision: ApprovalDecision): string {
  return `${PREPARED_BY_COMMUNITYOPS} ${DECIDED_BY_YOU[decision]}`;
}

/* --- Announcements (requirement 15.8) ------------------------------------ */

const ANNOUNCED_VERB: Record<ApprovalDecision, string> = {
  APPROVED: "approved",
  EDITED: "approved with edits",
  DECLINED: "declined",
};

/**
 * What the live region says when a decision lands.
 *
 * Deliberately worded differently from the card's own result text: the region is
 * a second copy of the same news in the DOM, and two elements carrying identical
 * text would make "the outcome is on screen" ambiguous to a reader and to a test.
 */
export function recordedAnnouncement(title: string, decision: ApprovalDecision): string {
  return `Recorded: you ${ANNOUNCED_VERB[decision]} "${title}".`;
}

/** The same, for a decision that had already been taken elsewhere (5.6). */
export function alreadyDecidedAnnouncement(title: string): string {
  return `"${title}" was already decided elsewhere, so the queue has been refreshed.`;
}
