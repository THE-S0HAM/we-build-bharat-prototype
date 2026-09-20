/**
 * Check-In flow logic (design.md §8.6, requirements 9.1–9.12).
 *
 * The page answers one question — "can this person go in?" — and this module
 * holds the parts of that answer which are decisions rather than markup:
 *
 *   - which single identifier field a typed search term maps to, and in the
 *     priority the endpoint documents (requirement 9.2)
 *   - the projection that keeps a masked candidate masked (requirement 16.8)
 *   - the seven fixed verification checks, read from the verify response and
 *     never computed here (requirements 9.5, 9.7)
 *   - whether completion is available, which WARN never blocks (requirement 9.6)
 *   - the four-step stepper's real progress (requirement 9.1)
 *
 * Nothing in here renders, imports React, or calls the API. It is pure, so the
 * rules above are testable as rules rather than through the DOM.
 *
 * The one rule that governs the whole module: **no verdict is invented here.**
 * Every PASS, FAIL or WARN comes from the verify response. A check the response
 * does not carry is reported as not evaluated, not as a pass.
 */

import type { SearchResult, VerificationCheck } from "../../types";

// ---------------------------------------------------------------------------
// One search field, four identifiers
// ---------------------------------------------------------------------------

/**
 * The body of `POST /events/{eventId}/checkin/search` accepts **one** of these,
 * and the backend resolves them in this order. The page presents one field
 * (requirement 9.2), so the term has to be classified into exactly one of them
 * before the request is built.
 */
export const SEARCH_FIELDS = ["registration_id", "email", "phone", "name"] as const;

export type SearchField = (typeof SEARCH_FIELDS)[number];

/** How the page tells the volunteer which lookup its one field just ran. */
export const SEARCH_FIELD_LABELS: Readonly<Record<SearchField, string>> = {
  registration_id: "registration ID",
  email: "email address",
  phone: "phone number",
  name: "name",
};

export interface SearchTerm {
  readonly field: SearchField;
  readonly value: string;
}

/** `REG-2026-004821`, and any other `PREFIX-…` identifier the backend mints. */
const IDENTIFIER_SHAPE = /^[A-Za-z]{2,}-[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Enough digits to be a phone number rather than a house number in a name. */
const PHONE_SHAPE = /^\+?[\d\s().-]{6,}$/;
const DIGITS = /\d/g;
const MIN_PHONE_DIGITS = 6;

/**
 * Map a typed search term to the single field the endpoint should receive.
 *
 * Deliberately deterministic and in the documented priority order, so the same
 * term always runs the same lookup and the page can say which one it ran. The
 * classification is shown to the volunteer rather than hidden: a name that looks
 * like an identifier is a correctable mistake, not a silent wrong query.
 *
 * @returns the field and the trimmed value, or `null` when there is nothing to
 * search for.
 */
export function classifySearchTerm(raw: string): SearchTerm | null {
  const value = raw.trim();

  if (value === "") {
    return null;
  }

  if (IDENTIFIER_SHAPE.test(value)) {
    return { field: "registration_id", value };
  }

  if (value.includes("@")) {
    return { field: "email", value };
  }

  if (PHONE_SHAPE.test(value) && (value.match(DIGITS)?.length ?? 0) >= MIN_PHONE_DIGITS) {
    return { field: "phone", value };
  }

  return { field: "name", value };
}

// ---------------------------------------------------------------------------
// Masked candidates
// ---------------------------------------------------------------------------

/**
 * A multi-match candidate, carrying **only** the four fields the endpoint
 * returns for one: `registration_id`, `attendee_name`, an already-masked
 * `attendee_email` and `ticket_type` (design.md §8.6, requirement 9.4).
 *
 * The masking happens server-side in `checkin/handlers.py::_mask_email`. This
 * type is how the page is stopped from reaching for anything else: the phone
 * number, the status and the full address are not on the record the API sent,
 * and they are not on this model either, so there is nothing to unmask
 * (requirement 16.8).
 */
export interface MaskedCandidate {
  readonly registration_id: string;
  readonly attendee_name: string;
  /** Masked by the API (`p***@example.com`). Rendered as received, never widened. */
  readonly attendee_email: string;
  readonly ticket_type: string;
}

/** Copy for a candidate the API returned without a masked address. */
export const NO_MASKED_EMAIL_LABEL = "Email not shown";

/** Copy for a candidate the API returned without a ticket type. */
export const NO_TICKET_TYPE_LABEL = "Ticket type not shown";

/**
 * Project a search response into masked candidates.
 *
 * `SearchResult.registrations` is typed `Registration[]` in `src/types.ts`, but a
 * multi-match response carries the four-field candidate shape instead of a full
 * record. This projection is what makes that safe in both directions: it reads
 * only the four documented fields, so a field the response omits is never
 * touched, and a full record's unmasked address is never carried onto a
 * candidate model that gets rendered.
 */
export function maskedCandidatesFrom(result: SearchResult): readonly MaskedCandidate[] {
  return result.registrations.map((candidate) => ({
    registration_id: candidate.registration_id,
    attendee_name: candidate.attendee_name,
    attendee_email: candidate.attendee_email ?? "",
    ticket_type: candidate.ticket_type ?? "",
  }));
}

/**
 * Whether the response requires the volunteer to pick a registration.
 *
 * Read from the response's own flag, with the count as a floor: more than one
 * match is never auto-selected, which is the rule US-1 of the check-in recovery
 * spec states and requirement 9.4 repeats.
 */
export function requiresDisambiguation(result: SearchResult): boolean {
  return result.requires_disambiguation === true || result.registrations.length > 1;
}

/**
 * The single registration a search resolved, or `null` when it resolved none.
 *
 * A response that requires disambiguation resolves nothing, however many
 * candidates it carries.
 */
export function singleMatchId(result: SearchResult): string | null {
  if (!result.found || requiresDisambiguation(result)) {
    return null;
  }

  const only = result.registrations[0];

  return only === undefined || only.registration_id === "" ? null : only.registration_id;
}

// ---------------------------------------------------------------------------
// The seven fixed verification checks
// ---------------------------------------------------------------------------

/**
 * The seven check names, fixed by `services/checkin/verification.py` and listed
 * in requirement 9.5 in the order the pipeline runs them. All seven are
 * rendered, in this order, whatever order the response lists them in.
 */
export const VERIFICATION_CHECK_NAMES = [
  "registration_exists",
  "event_match",
  "registration_status",
  "payment_status",
  "not_cancelled",
  "not_refunded",
  "checkin_eligibility",
] as const;

export type VerificationCheckName = (typeof VERIFICATION_CHECK_NAMES)[number];

/**
 * What each check is asking, in words a volunteer at a desk can read. These
 * label the check; the verdict and its sentence come from the response.
 */
export const VERIFICATION_CHECK_LABELS: Readonly<Record<VerificationCheckName, string>> = {
  registration_exists: "Registration found",
  event_match: "Belongs to this event",
  registration_status: "Registration status",
  payment_status: "Payment",
  not_cancelled: "Not cancelled",
  not_refunded: "Not refunded",
  checkin_eligibility: "Check-in eligibility",
};

/**
 * Requirement 9.6, verbatim: a `checkin_eligibility` WARN is presented as this,
 * and check-in stays completable.
 */
export const ALREADY_CHECKED_IN_LABEL = "Already checked in";

/** Shown for a check the verify response did not report a result for. */
export const NOT_EVALUATED_LABEL = "Not checked";
export const NOT_EVALUATED_MESSAGE =
  "Verification stopped before this check, so CommunityOps has no result for it.";

export interface VerificationRow {
  readonly name: VerificationCheckName;
  readonly label: string;
  /**
   * The result the verify response carried, or `null` when it carried none for
   * this check. `null` is reported as not evaluated — never as a pass
   * (requirement 9.7).
   */
  readonly result: VerificationCheck | null;
  /**
   * Set only for `checkin_eligibility` at WARN, where requirement 9.6 specifies
   * the words that accompany the warning.
   */
  readonly headline: string | null;
}

/**
 * The seven rows to render, in the fixed order, each carrying the result the
 * response gave it.
 *
 * The response is the only source of a verdict. A check the response omits — the
 * pipeline returns early when no registration record was provided — renders as
 * not evaluated, because the alternative is the UI deciding an unrun check
 * passed.
 */
export function verificationRows(
  checks: readonly VerificationCheck[],
): readonly VerificationRow[] {
  return VERIFICATION_CHECK_NAMES.map((name) => {
    const result = checks.find((check) => check.name === name) ?? null;

    return {
      name,
      label: VERIFICATION_CHECK_LABELS[name],
      result,
      headline:
        name === "checkin_eligibility" && result?.status === "WARN"
          ? ALREADY_CHECKED_IN_LABEL
          : null,
    };
  });
}

/**
 * Results the response reported that a check-in cannot proceed through.
 *
 * FAIL only. A WARN is a warning: `checkin_eligibility` returns it for an
 * attendee who has already checked in, and that attendee still walks in
 * (requirement 9.6). Anything the response did not report is not a failure
 * either — it is an unknown, and this function does not turn unknowns into
 * verdicts.
 */
export function blockingFailures(
  checks: readonly VerificationCheck[],
): readonly VerificationCheck[] {
  return checks.filter((check) => check.status === "FAIL");
}

/**
 * Whether check-in may be completed for this verify response.
 *
 * Requires a response — verification is never bypassed — and no FAIL in it.
 */
export function completionAvailable(checks: readonly VerificationCheck[] | null): boolean {
  if (checks === null || checks.length !== VERIFICATION_CHECK_NAMES.length) {
    return false;
  }

  const expected = new Set<string>(VERIFICATION_CHECK_NAMES);
  const seen = new Set<string>();

  for (const check of checks) {
    if (!expected.has(check.name) || seen.has(check.name)) {
      return false;
    }
    seen.add(check.name);

    if (check.name === "checkin_eligibility") {
      if (check.status === "PASS") continue;
      if (check.status === "WARN" && check.message.toLowerCase().includes("already checked in")) {
        continue;
      }
      return false;
    }

    if (check.status !== "PASS") {
      return false;
    }
  }

  return VERIFICATION_CHECK_NAMES.every((name) => seen.has(name));
}

/** Whether the response warned that this attendee has already been through. */
export function warnsAlreadyCheckedIn(checks: readonly VerificationCheck[]): boolean {
  return checks.some(
    (check) => check.name === "checkin_eligibility" && check.status === "WARN",
  );
}

// ---------------------------------------------------------------------------
// The four-step stepper
// ---------------------------------------------------------------------------

/**
 * The four steps of design.md §8.6 — "Search → resolve/disambiguate → verify →
 * complete, with recovery and reconciliation as branches". Recovery and
 * reconciliation are deliberately absent: a branch is not progress.
 */
export const CHECKIN_STEPS = ["Search", "Identify", "Verify", "Check in"] as const;

export type CheckinStepLabel = (typeof CHECKIN_STEPS)[number];

export type CheckinStepState = "done" | "current" | "upcoming";

export interface CheckinStep {
  readonly label: CheckinStepLabel;
  readonly state: CheckinStepState;
  /** 1-based, for the stepper's text alternative (requirement 15.12). */
  readonly position: number;
}

/**
 * What has actually happened. Every field is an observed fact — a response
 * arrived, a candidate was picked — so the stepper cannot run ahead of the flow
 * (requirement 9.1).
 */
export interface CheckinProgress {
  /** Masked candidates are on screen, waiting for an explicit selection. */
  readonly choosing: boolean;
  /** A registration is resolved: a single match, a pick, or a reconciliation. */
  readonly resolved: boolean;
  /** A verify response has been received for it. */
  readonly verified: boolean;
  /** A complete response has been received — new check-in or pre-existing. */
  readonly completed: boolean;
}

export function checkinSteps(progress: CheckinProgress): readonly CheckinStep[] {
  const { choosing, resolved, verified, completed } = progress;

  const states: readonly CheckinStepState[] = [
    resolved || choosing ? "done" : "current",
    resolved ? "done" : choosing ? "current" : "upcoming",
    verified ? "done" : resolved ? "current" : "upcoming",
    completed ? "done" : verified ? "current" : "upcoming",
  ];

  return CHECKIN_STEPS.map((label, index) => ({
    label,
    state: states[index] ?? "upcoming",
    position: index + 1,
  }));
}

/**
 * The stepper's text alternative (requirement 15.12): the same progress the
 * visual carries, stated in words and counts.
 */
export function describeProgress(steps: readonly CheckinStep[]): string {
  const current = steps.find((step) => step.state === "current");
  const done = steps.filter((step) => step.state === "done").length;

  if (current === undefined) {
    return `All ${steps.length} steps complete.`;
  }

  return `Step ${current.position} of ${steps.length}: ${current.label}. ${done} of ${steps.length} complete.`;
}
