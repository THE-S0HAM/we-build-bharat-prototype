import {
  completeCheckin,
  recoverTicket,
  reconcilePayment,
  searchCheckin,
  verifyCheckin,
  verifyQrPayload,
} from "../../api";
import type {
  CompleteCheckinResponse,
  ReconcileResult,
  SearchResult,
  TicketResult,
  VerificationCheck,
  VerifiedRegistration,
  VerifyCheckinResponse,
  VerifyQrResponse,
} from "../../types";
import type { SearchField } from "./checkinFlow";

export type { VerifiedRegistration } from "../../types";

export interface VerificationOutcome {
  readonly registrationId: string;
  readonly allPassed: boolean;
  readonly checks: readonly VerificationCheck[];
  readonly registration: VerifiedRegistration;
}

export interface CheckinCompletion {
  readonly registrationId: string;
  readonly status: string;
  readonly checkedInAt: string;
  readonly message: string;
  readonly wasAlreadyCheckedIn: boolean;
}

export type ReconcileOutcome =
  | { readonly kind: "reconciled"; readonly registrationId: string; readonly attendeeName: string; readonly message: string }
  | { readonly kind: "case"; readonly message: string }
  | { readonly kind: "unresolved"; readonly message: string };

export interface CheckinService {
  search(eventId: string, term: { field: SearchField; value: string }): Promise<SearchResult>;
  verify(eventId: string, registrationId: string): Promise<VerificationOutcome>;
  recover(eventId: string, registrationId: string): Promise<TicketResult>;
  reconcile(eventId: string, transactionId: string): Promise<ReconcileOutcome>;
  complete(eventId: string, registrationId: string): Promise<CheckinCompletion>;
  verifyQr?(eventId: string, qrPayload: string): Promise<VerifyQrResponse>;
}

export function toVerificationOutcome(response: VerifyCheckinResponse): VerificationOutcome {
  return {
    registrationId: response.registration_id,
    allPassed: response.verification.all_passed,
    checks: response.verification.checks,
    registration: {
      ...response.registration,
      ticket_type: response.registration.ticket_type ?? "",
    },
  };
}

export function toReconcileOutcome(response: ReconcileResult): ReconcileOutcome {
  if (response.reconciled && response.registration_id?.trim()) {
    return {
      kind: "reconciled",
      registrationId: response.registration_id,
      attendeeName: response.registration?.attendee_name ?? "",
      message: response.message,
    };
  }
  return response.recovery_case_created
    ? { kind: "case", message: response.message }
    : { kind: "unresolved", message: response.message };
}

export function toCheckinCompletion(response: CompleteCheckinResponse): CheckinCompletion {
  return {
    registrationId: response.registration_id,
    status: response.status,
    checkedInAt: response.checked_in_at,
    message: response.message,
    wasAlreadyCheckedIn: response.was_already_checked_in,
  };
}

export const apiCheckinService: CheckinService = {
  search(eventId, term) {
    return searchCheckin(eventId, { [term.field]: term.value });
  },
  async verify(eventId, registrationId) {
    return toVerificationOutcome(await verifyCheckin(eventId, registrationId));
  },
  recover(eventId, registrationId) {
    return recoverTicket(eventId, registrationId);
  },
  async reconcile(eventId, transactionId) {
    return toReconcileOutcome(await reconcilePayment(eventId, transactionId));
  },
  async complete(eventId, registrationId) {
    return toCheckinCompletion(await completeCheckin(eventId, registrationId));
  },
  verifyQr(eventId, qrPayload) {
    return verifyQrPayload(eventId, qrPayload);
  },
};
