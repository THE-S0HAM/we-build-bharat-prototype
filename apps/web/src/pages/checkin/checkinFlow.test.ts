/**
 * The Check-In flow rules, tested as rules (requirements 9.1–9.7, 16.8).
 *
 * These are the decisions the page must not get wrong and must not make up:
 * which lookup one field runs, what a masked candidate carries, which of the
 * seven checks rendered with which verdict, and whether a warning blocks a
 * person from walking in. All of it is pure, so none of it needs a DOM.
 */

import { describe, expect, it } from "vitest";

import type { Registration, SearchResult, VerificationCheck } from "../../types";
import {
  ALREADY_CHECKED_IN_LABEL,
  VERIFICATION_CHECK_NAMES,
  blockingFailures,
  checkinSteps,
  classifySearchTerm,
  completionAvailable,
  describeProgress,
  maskedCandidatesFrom,
  requiresDisambiguation,
  singleMatchId,
  verificationRows,
  warnsAlreadyCheckedIn,
} from "./checkinFlow";

const EVENT_ID = "EVT-devcon-2026";

function registration(overrides: Partial<Registration> = {}): Registration {
  return {
    registration_id: "REG-2026-004821",
    event_id: EVENT_ID,
    attendee_name: "Priya Sharma",
    attendee_email: "priya.sharma@example.com",
    attendee_phone: "+919876543210",
    status: "CONFIRMED",
    payment_status: "CAPTURED",
    ticket_type: "GENERAL",
    is_checked_in: false,
    ...overrides,
  };
}

function searchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return { found: true, count: 1, registrations: [registration()], ...overrides };
}

const ALL_PASS: readonly VerificationCheck[] = VERIFICATION_CHECK_NAMES.map((name) => ({
  name,
  status: "PASS",
  message: `${name} ok`,
}));

function withCheck(
  name: string,
  status: VerificationCheck["status"],
  message: string,
): readonly VerificationCheck[] {
  return ALL_PASS.map((check) => (check.name === name ? { name, status, message } : check));
}

describe("one field, four identifiers (requirement 9.2)", () => {
  it("resolves each identifier shape to the field the endpoint expects", () => {
    expect(classifySearchTerm("REG-2026-004821")?.field).toBe("registration_id");
    expect(classifySearchTerm("priya.sharma@example.com")?.field).toBe("email");
    expect(classifySearchTerm("+91 98765 43210")?.field).toBe("phone");
    expect(classifySearchTerm("Priya Sharma")?.field).toBe("name");
  });

  it("trims the value and refuses a term with nothing in it", () => {
    expect(classifySearchTerm("  Priya Sharma  ")).toEqual({
      field: "name",
      value: "Priya Sharma",
    });
    expect(classifySearchTerm("   ")).toBeNull();
  });
});

describe("masked candidates stay masked (requirements 9.4, 16.8)", () => {
  it("projects only the four fields the API returns for a candidate", () => {
    const candidates = maskedCandidatesFrom(
      searchResult({
        count: 2,
        requires_disambiguation: true,
        registrations: [
          registration({ attendee_email: "p***@example.com" }),
          registration({ registration_id: "REG-2026-004899", attendee_email: "p***@example.net" }),
        ],
      }),
    );

    // Exactly four keys. The phone number and the statuses on the fixture record
    // have nowhere to go, so nothing downstream can render them.
    expect(Object.keys(candidates[0] ?? {}).sort()).toEqual([
      "attendee_email",
      "attendee_name",
      "registration_id",
      "ticket_type",
    ]);
    expect(candidates[0]?.attendee_email).toBe("p***@example.com");
    expect(JSON.stringify(candidates)).not.toContain("+919876543210");
  });

  it("never auto-selects when more than one registration matches", () => {
    const ambiguous = searchResult({
      count: 2,
      requires_disambiguation: true,
      registrations: [registration(), registration({ registration_id: "REG-2026-004899" })],
    });

    expect(requiresDisambiguation(ambiguous)).toBe(true);
    expect(singleMatchId(ambiguous)).toBeNull();
  });

  it("resolves a single match to its registration id (requirement 9.3)", () => {
    expect(singleMatchId(searchResult())).toBe("REG-2026-004821");
    expect(singleMatchId(searchResult({ found: false, count: 0, registrations: [] }))).toBeNull();
  });
});

describe("the seven checks come from the response (requirements 9.5, 9.7)", () => {
  it("renders all seven names in the fixed order, whatever order the response used", () => {
    const shuffled = [...ALL_PASS].reverse();

    expect(verificationRows(shuffled).map((row) => row.name)).toEqual([
      ...VERIFICATION_CHECK_NAMES,
    ]);
  });

  it("reports a check the response omitted as not evaluated, never as a pass", () => {
    const early: readonly VerificationCheck[] = [
      { name: "registration_exists", status: "FAIL", message: "No registration record provided" },
    ];
    const rows = verificationRows(early);

    expect(rows[0]?.result?.status).toBe("FAIL");
    expect(rows.slice(1).every((row) => row.result === null)).toBe(true);
    expect(rows.some((row) => row.result?.status === "PASS")).toBe(false);
  });

  it("carries each result's own message", () => {
    const rows = verificationRows(withCheck("payment_status", "FAIL", "Payment is still pending"));

    expect(rows.find((row) => row.name === "payment_status")?.result?.message).toBe(
      "Payment is still pending",
    );
  });
});

describe("a warning is not a failure (requirement 9.6)", () => {
  const warned = withCheck("checkin_eligibility", "WARN", "Attendee has already checked in");

  it("presents a checkin_eligibility WARN as \"Already checked in\"", () => {
    const row = verificationRows(warned).find((entry) => entry.name === "checkin_eligibility");

    expect(row?.result?.status).toBe("WARN");
    expect(row?.headline).toBe(ALREADY_CHECKED_IN_LABEL);
    expect(warnsAlreadyCheckedIn(warned)).toBe(true);
  });

  it("keeps completion available through the warning, and withholds it on a failure", () => {
    expect(blockingFailures(warned)).toHaveLength(0);
    expect(completionAvailable(warned)).toBe(true);

    expect(completionAvailable(withCheck("not_refunded", "FAIL", "Payment has been refunded"))).toBe(
      false,
    );
  });

  it("never allows completion without a verify response at all", () => {
    // Verification is not bypassable: no response means no completion.
    expect(completionAvailable(null)).toBe(false);
  });
});

describe("the four-step stepper reflects real progress (requirement 9.1)", () => {
  const idle = { choosing: false, resolved: false, verified: false, completed: false };

  it("walks Search → Identify → Verify → Check in as each thing actually happens", () => {
    expect(checkinSteps(idle).map((step) => step.state)).toEqual([
      "current",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);

    expect(checkinSteps({ ...idle, choosing: true }).map((step) => step.state)).toEqual([
      "done",
      "current",
      "upcoming",
      "upcoming",
    ]);

    expect(checkinSteps({ ...idle, resolved: true }).map((step) => step.state)).toEqual([
      "done",
      "done",
      "current",
      "upcoming",
    ]);

    expect(
      checkinSteps({ ...idle, resolved: true, verified: true }).map((step) => step.state),
    ).toEqual(["done", "done", "done", "current"]);

    expect(
      checkinSteps({ choosing: false, resolved: true, verified: true, completed: true }).map(
        (step) => step.state,
      ),
    ).toEqual(["done", "done", "done", "done"]);
  });

  it("states the same progress in words and counts (requirement 15.12)", () => {
    expect(describeProgress(checkinSteps(idle))).toBe(
      "Step 1 of 4: Search. 0 of 4 complete.",
    );
    expect(
      describeProgress(
        checkinSteps({ choosing: false, resolved: true, verified: true, completed: true }),
      ),
    ).toBe("All 4 steps complete.");
  });
});
