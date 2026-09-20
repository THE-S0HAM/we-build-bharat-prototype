import { describe, expect, it } from "vitest";

import { consequenceFor, outcomeFor } from "./decisionConsequence";

describe("approval consequences", () => {
  it.each(["RESOLVE_INCIDENT", "SEND_SPEAKER_FOLLOWUP", "UNKNOWN_ACTION"])(
    "records approval without claiming execution for %s",
    (action) => {
      const pending = consequenceFor(action).approve;
      const approved = outcomeFor(action, "APPROVED");
      expect(`${pending} ${approved}`).toMatch(/approved|approval recorded/i);
      expect(`${pending} ${approved}`).toMatch(/did not (?:execute|resolve|send)/i);
      expect(`${pending} ${approved}`).not.toMatch(/will proceed|will send|will resolve|resum|continu/i);
    },
  );

  it("records edited approval without claiming execution", () => {
    expect(outcomeFor("SEND_SPEAKER_FOLLOWUP", "EDITED")).toBe(
      "Your edited action was approved for later execution. This decision did not execute it.",
    );
  });
});
