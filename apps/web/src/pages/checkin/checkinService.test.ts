import { describe, expect, it } from "vitest";

import {
  toCheckinCompletion,
  toReconcileOutcome,
  toVerificationOutcome,
} from "./checkinService";

describe("check-in response adapters", () => {
  it("keeps an omitted reconciliation ticket type absent instead of inventing one", () => {
    const outcome = toVerificationOutcome({
      registration_id: "REG-1",
      verification: { all_passed: true, checks: [] },
      registration: {
        attendee_name: "Asha",
        status: "CONFIRMED",
        payment_status: "CAPTURED",
      },
    });
    expect(outcome.registration.ticket_type).toBe("");
  });

  it("fails reconciliation closed when no registration identifier is returned", () => {
    expect(toReconcileOutcome({ reconciled: true, message: "Matched" })).toEqual({
      kind: "unresolved",
      message: "Matched",
    });
  });

  it("maps authoritative completion fields without recomputing them", () => {
    expect(toCheckinCompletion({
      registration_id: "REG-1",
      status: "CHECKED_IN",
      checked_in_at: "2026-10-15T09:12:00Z",
      message: "Recorded",
      was_already_checked_in: true,
    })).toEqual({
      registrationId: "REG-1",
      status: "CHECKED_IN",
      checkedInAt: "2026-10-15T09:12:00Z",
      message: "Recorded",
      wasAlreadyCheckedIn: true,
    });
  });
});
