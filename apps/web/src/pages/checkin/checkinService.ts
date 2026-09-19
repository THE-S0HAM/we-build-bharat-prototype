/**
 * The typed boundary between the Check-In page and the five check-in endpoints.
 *
 * Three of the wrappers in `src/api.ts` do not describe their response:
 * `completeCheckin` and `reconcilePayment` return `Promise<unknown>`, and
 * `verifyCheckin` types its `registration` as `Record<string, string>` and omits
 * the `registration_id` the endpoint echoes. The page used to answer that with
 * `as Record<string, unknown>` casts and a hand-built `Registration` object —
 * which is how a reconciliation that returned only a name ended up presented as
 * a CONFIRMED, CAPTURED, GENERAL-ticket registration the backend never sent.
 *
 * This module replaces the casts with reading. Every `unknown` is narrowed by a
 * runtime guard before a field is touched, so a field the response does not
 * carry becomes an absent value the page can render honestly, never a fabricated
 * one. There is no `any` and no assertion here.
 *
 * It is also the page's seam for tests: `CheckinService` is an interface, the
 * default implementation is the API client, and a test supplies the responses it
 * wants to assert against without stubbing `fetch`.
 *
 * NOTE for whoever owns `src/api.ts` / `src/types.ts`: the narrowing below is a
 * client-side stand-in for response types that belong in the API layer —
 * `CompleteCheckinResponse`, `ReconcileResponse` and a `VerifyResponse` carrying
 * `registration_id` plus the four `registration` fields. Those files are not
 * edited here. Once they are typed, this module keeps its shape and loses the
 * guards.
 */

import {
  completeCheckin,
  recoverTicket,
  reconcilePayment,
  searchCheckin,
  verifyCheckin,
} from "../../api";
import type { SearchResult, TicketResult, VerificationCheck } from "../../types";
import type { SearchField } from "./checkinFlow";

// ---------------------------------------------------------------------------
// Response models the page renders from
// ---------------------------------------------------------------------------

/**
 * The attendee panel, exactly as `POST .../checkin/verify` returns it — four
 * fields and no contact details. The page renders the attendee from this rather
 * than from the search result, so what is on screen beside the checks came back
 * with the checks.
 */
export interface VerifiedRegistration {
  readonly attendee_name: string;
  readonly ticket_type: string;
  readonly status: string;
  readonly payment_status: string;
}

export interface VerificationOutcome {
  readonly registrationId: string;
  /** The response's own aggregate. The page does not recompute it. */
  readonly allPassed: boolean;
  readonly checks: readonly VerificationCheck[];
  readonly registration: VerifiedRegistration;
}

export interface CheckinCompletion {
  readonly registrationId: string;
  readonly status: string;
  /** ISO-8601, or `""` when the pre-existing check-in record carried none. */
  readonly checkedInAt: string;
  readonly message: string;
  /** `true` for a 200 over an existing check-in, `false` for a 201 (a new one). */
  readonly wasAlreadyCheckedIn: boolean;
}

/**
 * The three outcomes of `POST .../checkin/reconcile`, as the handler produces
 * them.
 *
 * `case` is kept distinct from `unresolved` because requirement 9.9 turns on it:
 * a created recovery case is reported as a case, not as a resolution. Collapsing
 * the two would lose the only signal that says so.
 */
export type ReconcileOutcome =
  | {
      readonly kind: "reconciled";
      readonly registrationId: string;
      readonly attendeeName: string;
      readonly message: string;
    }
  | { readonly kind: "case"; readonly message: string }
  | { readonly kind: "unresolved"; readonly message: string };

export interface CheckinService {
  /** One identifier, in the priority the endpoint documents. */
  search(eventId: string, term: { field: SearchField; value: string }): Promise<SearchResult>;
  verify(eventId: string, registrationId: string): Promise<VerificationOutcome>;
  recover(eventId: string, registrationId: string): Promise<TicketResult>;
  /** Transaction reference only. Card data is never a parameter here. */
  reconcile(eventId: string, transactionId: string): Promise<ReconcileOutcome>;
  complete(eventId: string, registrationId: string): Promise<CheckinCompletion>;
}

// ---------------------------------------------------------------------------
// Reading an untyped response
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** @returns the string at `key`, or `""` when the response carries none. */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];

  return typeof value === "string" ? value : "";
}

/**
 * @returns the boolean at `key`, or `false` when the response carries none.
 *
 * `false` is the safe default for all three flags this reads:
 * `was_already_checked_in`, `already_existed` and `reconciled`. Defaulting the
 * other way would claim a prior state, or a resolution, that no response
 * asserted.
 */
function readBoolean(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

// ---------------------------------------------------------------------------
// The API-backed implementation
// ---------------------------------------------------------------------------

export const apiCheckinService: CheckinService = {
  search(eventId, term) {
    // One key in the body: the endpoint takes one of four identifiers, and the
    // page classified the typed term into exactly one of them.
    return searchCheckin(eventId, { [term.field]: term.value });
  },

  async verify(eventId, registrationId) {
    const response = await verifyCheckin(eventId, registrationId);
    const registration = asRecord(response.registration);

    return {
      /* `verifyCheckin`'s declared type omits the `registration_id` the endpoint
         echoes, so the id this outcome carries is the one the request was made
         with. They are the same value: the handler validates the id, looks it up,
         and returns it unchanged. */
      registrationId,
      allPassed: response.verification.all_passed,
      checks: response.verification.checks,
      registration: {
        attendee_name: readString(registration, "attendee_name"),
        ticket_type: readString(registration, "ticket_type"),
        status: readString(registration, "status"),
        payment_status: readString(registration, "payment_status"),
      },
    };
  },

  recover(eventId, registrationId) {
    return recoverTicket(eventId, registrationId);
  },

  async reconcile(eventId, transactionId) {
    const response = asRecord(await reconcilePayment(eventId, transactionId));
    const message = readString(response, "message");

    if (readBoolean(response, "reconciled")) {
      const registrationId = readString(response, "registration_id");

      /* A reconciliation that resolved nothing identifiable is not a
         resolution, whatever the flag said. Reported as an unresolved attempt
         rather than advanced into verification with an empty id. */
      if (registrationId !== "") {
        return {
          kind: "reconciled",
          registrationId,
          // The endpoint returns `registration` with three fields and no
          // contact details. Only the name is read, and only to name the
          // person the page is about to verify.
          attendeeName: readString(asRecord(response.registration), "attendee_name"),
          message,
        };
      }
    }

    return readBoolean(response, "recovery_case_created")
      ? { kind: "case", message }
      : { kind: "unresolved", message };
  },

  async complete(eventId, registrationId) {
    const response = asRecord(await completeCheckin(eventId, registrationId));

    return {
      registrationId: readString(response, "registration_id") || registrationId,
      status: readString(response, "status"),
      checkedInAt: readString(response, "checked_in_at"),
      message: readString(response, "message"),
      // The one field that decides whether the page reports a new check-in or an
      // existing one (requirement 9.10). Read, never inferred.
      wasAlreadyCheckedIn: readBoolean(response, "was_already_checked_in"),
    };
  },
};
