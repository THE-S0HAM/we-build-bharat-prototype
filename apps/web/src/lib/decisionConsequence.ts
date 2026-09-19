/**
 * What happens if a decision is taken — in words, from the typed contract only.
 *
 * `Approval.requested_action` is the only field that says what CommunityOps is
 * asking to do (`RESOLVE_INCIDENT`, `SEND_SPEAKER_FOLLOWUP` — the two the
 * workflows and the seed write today), so the consequence line is a lookup on
 * it and nothing else. Nothing here reads `evidence`, invents a figure, or
 * describes a side effect the backend does not perform.
 *
 * Two rules from design.md constrain this table:
 *
 *   - **A9 — approving does not resume the workflow.** `_decide_approval` writes
 *     status and audit; it never calls `SendTaskSuccess`. So post-decision copy
 *     is "Decision recorded." plus the concrete outcome, and no sentence here
 *     claims that a workflow continues or that work has already happened.
 *   - **§15.2 agent voice.** CommunityOps speaks in its own name. Never "the
 *     agent", never "the system".
 *
 * A `requested_action` outside the table gets the generic pair rather than a
 * guess: `apiFetch` asserts response shapes rather than validating them, so a
 * new backend action reaches this module as an unknown string.
 */

import { readTableEntry } from "./unknownValue";

export interface DecisionConsequence {
  /** What becomes true if the leader approves. */
  readonly approve: string;
  /** What becomes true if the leader declines. */
  readonly decline: string;
}

/**
 * The generic pair, used for any action this module does not recognise. The
 * wording is deliberately the widest true statement available: it names the
 * direction of the decision without describing work nothing has confirmed.
 */
export const GENERIC_CONSEQUENCE: DecisionConsequence = {
  approve: "CommunityOps will proceed with this action.",
  decline: "CommunityOps will not proceed with this action.",
};

/**
 * The outcome of an adjusted approval, and the same sentence for every action.
 *
 * It says "recorded" and stops there on purpose. `api.ts::decideApproval` sends
 * `{decision, notes}` and carries no `edited_action` field yet, so the adjusted
 * wording is recorded with the decision rather than replacing the action the
 * approval names. Claiming CommunityOps will proceed with the adjusted action
 * would describe something the request has not asked for (A4, A9).
 */
export const EDITED_OUTCOME = "Your adjusted wording is recorded with this decision.";

const CONSEQUENCES: Readonly<Record<string, DecisionConsequence>> = {
  RESOLVE_INCIDENT: {
    approve: "CommunityOps will proceed with this incident resolution.",
    decline: "CommunityOps will not act on this incident.",
  },
  SEND_SPEAKER_FOLLOWUP: {
    approve: "CommunityOps will send this follow-up.",
    decline: "CommunityOps will not send this follow-up.",
  },
};

/** The consequence pair for an approval's `requested_action`. */
export function consequenceFor(requestedAction: string): DecisionConsequence {
  return readTableEntry(CONSEQUENCES, requestedAction) ?? GENERIC_CONSEQUENCE;
}

/**
 * The sentence that follows "Decision recorded." once a decision resolves
 * (A9, requirement 5.7).
 */
export function outcomeFor(
  requestedAction: string,
  decision: "APPROVED" | "DECLINED" | "EDITED",
): string {
  const consequence = consequenceFor(requestedAction);

  switch (decision) {
    case "APPROVED":
      return consequence.approve;
    case "DECLINED":
      return consequence.decline;
    case "EDITED":
      return EDITED_OUTCOME;
  }
}
