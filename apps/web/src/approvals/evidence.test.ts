/**
 * Approval evidence — allowlist in, three things out.
 *
 * `evidence` is an unstructured dict written by whichever agent raised the
 * approval, and `_list_approvals` returns raw DynamoDB items — so it can carry
 * the Step Functions `task_token` and `workflow_execution_id` (A8). The page used
 * to render `JSON.stringify(evidence)`. These tests hold the replacement to its
 * contract: recognised keys become labelled rows, one recognised amount becomes
 * the financial line, and everything else is a count and nothing more.
 *
 * **Validates: Requirements 5.9, 5.10, 16.5, 16.6**
 */

import { describe, expect, it } from "vitest";

import {
  financialConsequenceLine,
  readEvidence,
  unrecognisedEvidenceNotice,
  type EvidenceAmount,
} from "./evidence";

/**
 * The amount the evidence stated, narrowed by a check rather than by a non-null
 * assertion — this file holds no casts, like the source it exercises.
 */
function statedAmount(evidence: unknown): EvidenceAmount {
  const { amount } = readEvidence(evidence);

  if (amount === null) {
    throw new Error("The evidence was expected to state an amount.");
  }

  return amount;
}

describe("recognised keys (requirement 5.9)", () => {
  it("renders them as labelled rows, in a fixed order whatever order they arrived in", () => {
    const view = readEvidence({ followup_count: 2, speaker_id: "SPK-002" });

    expect(view.rows).toEqual([
      { key: "speaker_id", label: "Speaker", value: "SPK-002" },
      { key: "followup_count", label: "Follow-ups already sent", value: "2" },
    ]);
    expect(view.unrecognisedCount).toBe(0);
  });
});

describe("unrecognised keys (requirements 5.9, 16.5, 16.6)", () => {
  it("represents them solely by a count, naming neither key nor value", () => {
    const view = readEvidence({
      incident_id: "INC-001",
      // The two fields the workflows write onto the APPROVAL item (A8). Neither
      // is modelled, so neither can be read, rendered, logged or persisted — both
      // land in the count.
      task_token: "AAAAKgAAAAIAAAAAAAAAAf9jExampleTaskToken",
      workflow_execution_id: "arn:aws:states:ap-south-1:123456789012:execution:x",
      notes_from_agent: "free text nobody reviewed",
    });

    expect(view.rows).toEqual([{ key: "incident_id", label: "Incident", value: "INC-001" }]);
    expect(view.unrecognisedCount).toBe(3);

    const notice = unrecognisedEvidenceNotice(view.unrecognisedCount);
    expect(notice).toContain("3 more fields");
    for (const leak of ["task_token", "workflow_execution_id", "arn:", "free text"]) {
      expect(notice).not.toContain(leak);
    }
  });

  it("counts a nested object rather than serializing it (Property 11)", () => {
    const view = readEvidence({ search_criteria: { email: "priya@example.com" } });

    expect(view.rows).toEqual([]);
    expect(view.unrecognisedCount).toBe(1);
    expect(unrecognisedEvidenceNotice(1)).not.toContain("priya@example.com");
  });

  it("resolves a missing or non-object evidence value instead of throwing", () => {
    for (const value of [undefined, null, "INC-001", []]) {
      expect(readEvidence(value)).toEqual({ rows: [], unrecognisedCount: 0, amount: null });
    }
  });
});

describe("the financial line (requirement 5.10, A10)", () => {
  it("is absent when the evidence states no amount", () => {
    // The two seeded approvals. Neither carries a figure, so neither gets a line.
    expect(readEvidence({ incident_id: "INC-001", backup_speaker: "SPK-005" }).amount).toBeNull();
    expect(readEvidence({ speaker_id: "SPK-002", followup_count: 2 }).amount).toBeNull();
  });

  it("renders the stated figure, and only the stated figure", () => {
    const evidence = { speaker_id: "SPK-002", estimated_cost_inr: 12500 };
    const view = readEvidence(evidence);

    expect(view.amount).toEqual({ key: "estimated_cost_inr", amount: 12500, currency: "INR" });

    const line = financialConsequenceLine(statedAmount(evidence));
    expect(line).toContain("Financial commitment if you approve:");
    expect(line).toContain("12,500");

    // The amount is consumed by the line, so it is neither a row nor a count.
    expect(view.rows.map((row) => row.key)).toEqual(["speaker_id"]);
    expect(view.unrecognisedCount).toBe(0);
  });

  it("does not invent a currency, and does not read a figure out of prose", () => {
    const amount = statedAmount({ amount: 4000 });
    expect(amount).toEqual({ key: "amount", amount: 4000, currency: null });
    expect(financialConsequenceLine(amount)).toContain(
      "The evidence does not state a currency.",
    );

    const vague = readEvidence({ amount: "about twelve thousand" });
    expect(vague.amount).toBeNull();
    expect(vague.unrecognisedCount).toBe(1);
  });
});
