/**
 * Accurate approval consequences for a decision endpoint that records authority
 * but does not execute or resume the requested action.
 */

import { readTableEntry } from "./unknownValue";

export interface DecisionConsequence {
  readonly approve: string;
  readonly decline: string;
}

export const GENERIC_CONSEQUENCE: DecisionConsequence = {
  approve: "Approval recorded for later execution. This decision did not execute the action.",
  decline: "Decline decision recorded. The action is not approved for execution.",
};

export const EDITED_OUTCOME =
  "Your edited action was approved for later execution. This decision did not execute it.";

const CONSEQUENCES: Readonly<Record<string, DecisionConsequence>> = {
  RESOLVE_INCIDENT: {
    approve:
      "Incident resolution approved for later execution. This decision did not resolve the incident.",
    decline: "Decline decision recorded. This incident resolution is not approved for execution.",
  },
  SEND_SPEAKER_FOLLOWUP: {
    approve:
      "Speaker follow-up approved for later execution. This decision did not send the follow-up.",
    decline: "Decline decision recorded. This follow-up is not approved to be sent.",
  },
};

export function consequenceFor(requestedAction: string): DecisionConsequence {
  return readTableEntry(CONSEQUENCES, requestedAction) ?? GENERIC_CONSEQUENCE;
}

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
