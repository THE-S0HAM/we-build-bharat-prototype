/**
 * Check-In — "can this attendee enter?" (design.md §8.6, requirements 9.1–9.12).
 *
 * A volunteer holding a phone at the venue desk has a queue behind them and an
 * attendee in front of them who cannot find their ticket. The page is built for
 * that: one search field, one column, large controls, one primary action at a
 * time, and no operational reporting anywhere on it.
 *
 * The flow is Search → identify → verify → check in, with ticket recovery and
 * payment reconciliation as branches off it. The four-step stepper reflects what
 * has actually happened, and a branch is not progress.
 *
 * Four rules hold this page together, and each one is a rule about *not*
 * deciding things on the client:
 *
 *   1. **Verification is never bypassed and never recomputed.** Every PASS, FAIL
 *      and WARN on screen is a value from the verify response. The page decides
 *      only what is enabled, from `blockingFailures` — and a WARN is not a
 *      failure, so an attendee who has already checked in can still be completed
 *      (requirements 9.5, 9.6, 9.7).
 *   2. **Masked stays masked.** A multi-match response carries four fields per
 *      candidate, one of them an email the API masked. `MaskedCandidate` is the
 *      only candidate model this page holds, so there is no unmasked address to
 *      render and none to store (requirements 9.4, 16.8). Nothing here writes to
 *      `localStorage`, and nothing here logs an attendee.
 *   3. **Prior state is reported, not smoothed over.** `already_existed` and
 *      `was_already_checked_in` are read from the response and said out loud:
 *      a recovered ticket that already existed is not announced as newly
 *      generated, and an attendee who was already through is not announced as a
 *      fresh check-in (requirements 9.8, 9.10).
 *   4. **Reconciliation sends a transaction reference and nothing else.** There
 *      is no field on this page for a card number, a CVV or a PIN, and a created
 *      recovery case is reported as a case rather than as a resolution
 *      (requirement 9.9).
 *
 * The page holds layout and wiring only. `checkinFlow.ts` owns the flow rules,
 * `checkinService.ts` owns the typed boundary to the five endpoints, and the
 * shared components own every surface: `PageHeader`, `StatusBadge` (the one
 * status-to-colour mapper), `DataTable`, `EmptyState`, `ApiErrorState`,
 * `Skeleton*` and `formatTime`.
 */

import { useCallback, useId, useMemo, useState } from "react";

import { ApiErrorState } from "../components/ApiErrorState";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { SkeletonList } from "../components/Skeleton";
import { StatusBadge } from "../components/StatusBadge";
import type { EventScopedPageProps } from "../event/EventScopedView";
import { toApprovedCopy } from "../lib/errorCategory";
import { formatAbsoluteTime, toMachineTime } from "../lib/formatTime";
import { useApiFailure } from "../session/useApiFailure";
import type { TicketResult, VerifyQrResponse } from "../types";
import {
  NOT_EVALUATED_LABEL,
  NOT_EVALUATED_MESSAGE,
  NO_MASKED_EMAIL_LABEL,
  NO_TICKET_TYPE_LABEL,
  SEARCH_FIELD_LABELS,
  checkinSteps,
  classifySearchTerm,
  completionAvailable,
  describeProgress,
  maskedCandidatesFrom,
  requiresDisambiguation,
  singleMatchId,
  verificationRows,
  warnsAlreadyCheckedIn,
  type MaskedCandidate,
  type SearchTerm,
} from "./checkin/checkinFlow";
import {
  apiCheckinService,
  type CheckinCompletion,
  type CheckinService,
  type VerificationOutcome,
} from "./checkin/checkinService";
import "./CheckinConsole.css";

const PAGE_TITLE = "Check-In";
const PAGE_CONTEXT = "Find the attendee, see whether they can go in, and let them in.";

/** Requirement 9.11 — the idle state says what this one field accepts. */
const IDLE_TITLE = "Search to find an attendee.";
const IDLE_DESCRIPTION =
  "One field, four ways in: a registration ID like REG-2026-004821, an email address, a phone number, or a name. CommunityOps picks the matching lookup and tells you which one it used.";

const SEARCH_LABEL = "Registration ID, email, phone or name";
const SEARCH_HINT =
  "Type any one of them. Exact identifiers find one person; a name may bring back several to choose from.";

/** design.md §2 — one of the four Hinglish phrases, at the recovery entry. */
const RECOVERY_HEADING = "Ticket nahi mila? Koi scene nahi.";

/** design.md §2 — one of the four Hinglish phrases, at completion. */
const COMPLETION_HEADING = "Scene handled.";

const RECONCILE_HEADING = "No registration matched";
const RECONCILE_LABEL = "Transaction reference";
const RECONCILE_HINT =
  "A transaction or payment reference only. CommunityOps never asks for a card number, a CVV or a PIN, and this form does not accept one.";

/** What a search response resolved to, when it did not resolve a registration. */
type SearchOutcome =
  | { readonly kind: "candidates"; readonly candidates: readonly MaskedCandidate[]; readonly message: string }
  | { readonly kind: "none"; readonly message: string };

/** How the registration on screen came to be resolved. */
type Origin = "search" | "reconciliation";

interface Resolved {
  readonly registrationId: string;
  readonly origin: Origin;
}

/** The outcome of a reconciliation that did not resolve a registration. */
interface RecoveryCase {
  readonly kind: "case" | "unresolved";
  readonly message: string;
}

/**
 * Which request failed, so "Try again" re-runs that one and nothing else
 * (requirement 13.3).
 */
type Attempt = "search" | "verify" | "recover" | "reconcile" | "complete" | "qr";

export interface CheckinConsoleProps extends EventScopedPageProps {
  /**
   * The five check-in endpoints. Defaults to the API client; a test supplies the
   * responses it wants to assert against.
   */
  readonly service?: CheckinService;
}

export function CheckinConsole({ eventId, service = apiCheckinService }: CheckinConsoleProps) {
  const report = useApiFailure();

  /* The search term is page state and survives every failure: requirement 9.12
     is explicit that a failed request retains it, so the volunteer never retypes
     a registration ID because the network dropped. */
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);

  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verification, setVerification] = useState<VerificationOutcome | null>(null);

  const [recovering, setRecovering] = useState(false);
  const [ticket, setTicket] = useState<TicketResult | null>(null);

  const [transactionId, setTransactionId] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const [recoveryCase, setRecoveryCase] = useState<RecoveryCase | null>(null);

  const [completing, setCompleting] = useState(false);
  const [completion, setCompletion] = useState<CheckinCompletion | null>(null);
  const [qrPayload, setQrPayload] = useState("");
  const [qrChecking, setQrChecking] = useState(false);
  const [qrResult, setQrResult] = useState<VerifyQrResponse | null>(null);

  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);

  /** Requirement 15.8 — results are announced, not only rendered. */
  const [announcement, setAnnouncement] = useState("");

  const searchFieldId = useId();
  const searchHintId = useId();
  const transactionFieldId = useId();
  const transactionHintId = useId();
  const qrFieldId = useId();

  const term = useMemo<SearchTerm | null>(() => classifySearchTerm(query), [query]);

  const busy = searching || verifying || recovering || reconciling || completing || qrChecking;

  /** Hold a failure and record which request produced it. */
  const fail = useCallback(
    (which: Attempt, error: unknown) => {
      const held = report(error);

      setAttempt(held === null ? null : which);
      setFailure(held);
    },
    [report],
  );

  const runVerify = useCallback(
    (registrationId: string) => {
      setVerifying(true);
      setFailure(null);

      service.verify(eventId, registrationId).then(
        (result) => {
          setVerifying(false);
          setVerification(result);
          setAnnouncement(describeVerification(result));
        },
        (error: unknown) => {
          setVerifying(false);
          fail("verify", error);
        },
      );
    },
    [eventId, fail, service],
  );

  /**
   * A registration is resolved. Verification follows immediately and without
   * being asked for: it is the answer to the page's question, and a desk with a
   * queue should not need a second tap to get it.
   */
  const resolve = useCallback(
    (registrationId: string, origin: Origin) => {
      setResolved({ registrationId, origin });
      setOutcome(null);
      setRecoveryCase(null);
      setVerification(null);
      setTicket(null);
      runVerify(registrationId);
    },
    [runVerify],
  );

  const runSearch = useCallback(() => {
    if (term === null) return;

    setSearching(true);
    setFailure(null);
    setOutcome(null);
    setRecoveryCase(null);

    service.search(eventId, term).then(
      (result) => {
        setSearching(false);

        const matched = singleMatchId(result);

        if (matched !== null) {
          // Requirement 9.3: a single match advances to verification.
          setAnnouncement("One registration matched. Running verification.");
          resolve(matched, "search");
          return;
        }

        if (requiresDisambiguation(result)) {
          // Requirement 9.4: candidates are offered, never auto-selected.
          const candidates = maskedCandidatesFrom(result);

          setOutcome({
            kind: "candidates",
            candidates,
            message: toApprovedCopy(
              result.message,
              "More than one person matches. Pick the right registration.",
            ),
          });
          setAnnouncement(
            `${candidates.length} registrations match. Pick the right one — CommunityOps will not choose for you.`,
          );
          return;
        }

        setOutcome({
          kind: "none",
          message: toApprovedCopy(
            result.message,
            "No registration matched that search. You can try a payment reference instead.",
          ),
        });
        setAnnouncement("No registration matched that search.");
      },
      (error: unknown) => {
        setSearching(false);
        fail("search", error);
      },
    );
  }, [eventId, fail, resolve, service, term]);

  const runRecover = useCallback(() => {
    if (resolved === null) return;

    setRecovering(true);
    setFailure(null);

    service.recover(eventId, resolved.registrationId).then(
      (result) => {
        setRecovering(false);
        setTicket(result);
        setAnnouncement(describeTicket(result));
      },
      (error: unknown) => {
        setRecovering(false);
        fail("recover", error);
      },
    );
  }, [eventId, fail, resolved, service]);

  const runReconcile = useCallback(() => {
    const reference = transactionId.trim();

    if (reference === "") return;

    setReconciling(true);
    setFailure(null);
    setRecoveryCase(null);

    service.reconcile(eventId, reference).then(
      (result) => {
        setReconciling(false);

        if (result.kind === "reconciled") {
          setAnnouncement(
            `Payment matched ${result.attendeeName === "" ? "a registration" : result.attendeeName}. Running verification.`,
          );
          resolve(result.registrationId, "reconciliation");
          return;
        }

        /* Requirement 9.9: a created recovery case is a case. It is not a
           reconciliation, and nothing advances on the strength of it. */
        setRecoveryCase({
          kind: result.kind,
          message: toApprovedCopy(
            result.message,
            "No matching registration or payment record was found.",
          ),
        });
        setAnnouncement(
          result.kind === "case"
            ? "Not resolved. A recovery case has been opened for this attendee."
            : "Not resolved. No payment record matched that reference.",
        );
      },
      (error: unknown) => {
        setReconciling(false);
        fail("reconcile", error);
      },
    );
  }, [eventId, fail, resolve, service, transactionId]);

  const runComplete = useCallback(() => {
    if (resolved === null) return;

    setCompleting(true);
    setFailure(null);

    service.complete(eventId, resolved.registrationId).then(
      (result) => {
        setCompleting(false);
        setCompletion(result);
        setAnnouncement(describeCompletion(result));
      },
      (error: unknown) => {
        setCompleting(false);
        fail("complete", error);
      },
    );
  }, [eventId, fail, resolved, service]);

  const runQr = useCallback(() => {
    const payload = qrPayload.trim();
    if (!payload || !service.verifyQr) return;
    setQrChecking(true); setQrResult(null); setFailure(null);
    service.verifyQr(eventId, payload).then(
      (result) => { setQrResult(result); setQrChecking(false); setAnnouncement(`Valid ticket for ${result.attendee_name}. Run registration verification before completing check-in.`); },
      (error: unknown) => { setQrChecking(false); fail("qr", error); },
    );
  }, [eventId, fail, qrPayload, service]);

  const startOver = useCallback(() => {
    setQuery("");
    setSearching(false);
    setOutcome(null);
    setResolved(null);
    setVerifying(false);
    setVerification(null);
    setRecovering(false);
    setTicket(null);
    setTransactionId("");
    setReconciling(false);
    setRecoveryCase(null);
    setCompleting(false);
    setCompletion(null);
    setQrPayload("");
    setQrResult(null);
    setQrChecking(false);
    setFailure(null);
    setAttempt(null);
    setAnnouncement("Ready for the next attendee.");
  }, []);

  /** Re-run only the request that failed. */
  const retry = useMemo<(() => void) | undefined>(() => {
    switch (attempt) {
      case "search":
        return runSearch;
      case "verify":
        return resolved === null ? undefined : () => runVerify(resolved.registrationId);
      case "recover":
        return runRecover;
      case "reconcile":
        return runReconcile;
      case "complete":
        return runComplete;
      case "qr":
        return runQr;
      default:
        return undefined;
    }
  }, [attempt, resolved, runComplete, runQr, runReconcile, runRecover, runSearch, runVerify]);

  const steps = useMemo(
    () =>
      checkinSteps({
        choosing: outcome?.kind === "candidates",
        resolved: resolved !== null,
        verified: verification !== null,
        completed: completion !== null,
      }),
    [completion, outcome, resolved, verification],
  );

  const rows = useMemo(
    () => (verification === null ? [] : verificationRows(verification.checks)),
    [verification],
  );

  const canComplete = completionAvailable(verification?.checks ?? null);
  const alreadyThrough = verification !== null && warnsAlreadyCheckedIn(verification.checks);

  const candidateColumns = useMemo<readonly DataTableColumn<MaskedCandidate>[]>(
    () => [
      {
        key: "attendee_name",
        header: "Name",
        rowHeader: true,
        cell: (candidate) => candidate.attendee_name,
      },
      {
        key: "registration_id",
        header: "Registration",
        cell: (candidate) => candidate.registration_id,
      },
      {
        key: "attendee_email",
        header: "Email (masked)",
        cell: (candidate) =>
          candidate.attendee_email === "" ? NO_MASKED_EMAIL_LABEL : candidate.attendee_email,
      },
      {
        // Primary at every width, unlike the secondary columns on SpeakerOps and
        // IncidentOps. A `secondary` column is one whose value the page's drawer
        // still shows at narrow widths; this list has no drawer — the row action
        // selects a registration rather than opening one — so hiding the ticket
        // type below `--bp-md` would simply lose one of the four masked fields the
        // API returned (requirement 9.4). Check-In is also the one mobile-first
        // flow in the product, so the narrow width is its primary width.
        key: "ticket_type",
        header: "Ticket",
        cell: (candidate) =>
          candidate.ticket_type === "" ? NO_TICKET_TYPE_LABEL : candidate.ticket_type,
      },
    ],
    [],
  );

  return (
    <div className="page checkin">
      <PageHeader title={PAGE_TITLE} context={PAGE_CONTEXT} />

      {/* The page's one contextual visual: four steps, real progress, no dashboard. */}
      <nav className="checkin-stepper" aria-label="Check-in progress">
        <ol className="checkin-stepper__list">
          {steps.map((step) => (
            <li
              className="checkin-stepper__step"
              key={step.label}
              data-state={step.state}
              aria-current={step.state === "current" ? "step" : undefined}
            >
              <span className="checkin-stepper__position">{step.position}</span>
              <span className="checkin-stepper__label">{step.label}</span>
            </li>
          ))}
        </ol>
        {/* Requirement 15.12: the visual's progress, stated in words and counts. */}
        <p className="checkin-stepper__alt">{describeProgress(steps)}</p>
      </nav>

      {/* Requirement 15.8. Always present, so a result is announced rather than
          the region itself being announced as it appears. */}
      <p className="checkin__announcement" role="status" aria-live="polite">
        {announcement}
      </p>

      {completion === null && resolved === null && service.verifyQr && (
        <section className="card checkin-card" aria-labelledby="checkin-qr-heading">
          <h2 className="checkin-card__heading" id="checkin-qr-heading">Verify a ticket QR payload</h2>
          <p className="checkin-note">Verification happens on the server against the ticket signature. A valid QR identifies the registration but does not complete check-in.</p>
          <form className="checkin-search" onSubmit={(event) => { event.preventDefault(); runQr(); }}>
            <label className="form-label" htmlFor={qrFieldId}>Scanned QR payload</label>
            <div className="checkin-field__row">
              <textarea className="input checkin-field__input" id={qrFieldId} rows={2} value={qrPayload} onChange={(event) => setQrPayload(event.target.value)} />
              <button className="btn" type="submit" disabled={qrChecking || !qrPayload.trim()}>{qrChecking ? "Verifying…" : "Verify QR"}</button>
            </div>
          </form>
          {qrResult && <div className="checkin-ticket" role="status"><p className="checkin-ticket__outcome">Valid ticket for {qrResult.attendee_name}.</p><p className="checkin-attendee__meta">{qrResult.registration_id} · {qrResult.ticket_status}</p><button type="button" className="btn btn-primary" onClick={() => resolve(qrResult.registration_id, "search")}>Run entry verification</button></div>}
        </section>
      )}

      {completion === null && resolved === null && (
        <section className="card checkin-card" aria-labelledby="checkin-search-heading">
          <h2 className="checkin-card__heading" id="checkin-search-heading">
            Find the attendee
          </h2>

          <form
            className="checkin-search"
            onSubmit={(formEvent) => {
              formEvent.preventDefault();
              runSearch();
            }}
          >
            <label className="form-label checkin-field__label" htmlFor={searchFieldId}>
              {SEARCH_LABEL}
            </label>
            <p className="form-hint checkin-field__hint" id={searchHintId}>
              {SEARCH_HINT}
            </p>
            <div className="checkin-field__row">
              <input
                className="input checkin-field__input"
                id={searchFieldId}
                aria-describedby={searchHintId}
                autoComplete="off"
                value={query}
                onChange={(inputEvent) => {
                  setQuery(inputEvent.target.value);
                }}
              />
              <button
                className="btn btn-primary checkin-field__submit"
                type="submit"
                disabled={term === null || busy}
              >
                {searching ? "Searching…" : "Search"}
              </button>
            </div>
            {term !== null && (
              <p className="checkin-search__lookup">
                CommunityOps will look this up by {SEARCH_FIELD_LABELS[term.field]}.
              </p>
            )}
          </form>

          {searching && (
            <SkeletonList items={2} label="Looking for a matching registration…" />
          )}

          {!searching && outcome === null && failure === null && (
            <EmptyState title={IDLE_TITLE} description={IDLE_DESCRIPTION} />
          )}

          {!searching && outcome?.kind === "candidates" && (
            <section className="checkin-candidates" aria-labelledby="checkin-candidates-heading">
              <h3 className="checkin-subheading" id="checkin-candidates-heading">
                Pick the right registration
              </h3>
              <p className="checkin-note">
                {outcome.message} Email addresses are shown masked, exactly as the registration
                system returned them. CommunityOps will not choose for you.
              </p>
              <DataTable
                label="Matching registrations"
                columns={candidateColumns}
                rows={outcome.candidates}
                rowKey={(candidate) => candidate.registration_id}
                rowAction={{
                  label: "Use this one",
                  header: "Select",
                  onSelect: (candidate) => {
                    resolve(candidate.registration_id, "search");
                  },
                  accessibleLabel: (candidate) =>
                    `Use registration ${candidate.registration_id} for ${candidate.attendee_name}`,
                }}
              />
            </section>
          )}

          {!searching && outcome?.kind === "none" && (
            <section className="checkin-reconcile" aria-labelledby="checkin-reconcile-heading">
              <h3 className="checkin-subheading" id="checkin-reconcile-heading">
                {RECONCILE_HEADING}
              </h3>
              <p className="checkin-note">{outcome.message}</p>

              <form
                className="checkin-search"
                onSubmit={(formEvent) => {
                  formEvent.preventDefault();
                  runReconcile();
                }}
              >
                <label className="form-label checkin-field__label" htmlFor={transactionFieldId}>
                  {RECONCILE_LABEL}
                </label>
                <p className="form-hint checkin-field__hint" id={transactionHintId}>
                  {RECONCILE_HINT}
                </p>
                <div className="checkin-field__row">
                  <input
                    className="input checkin-field__input"
                    id={transactionFieldId}
                    aria-describedby={transactionHintId}
                    autoComplete="off"
                    value={transactionId}
                    onChange={(inputEvent) => {
                      setTransactionId(inputEvent.target.value);
                    }}
                  />
                  <button
                    className="btn checkin-field__submit"
                    type="submit"
                    disabled={transactionId.trim() === "" || busy}
                  >
                    {reconciling ? "Checking the payment record…" : "Check payment reference"}
                  </button>
                </div>
              </form>

              {recoveryCase !== null && (
                <div className="checkin-case">
                  <p className="checkin-case__title">
                    {recoveryCase.kind === "case"
                      ? "Recovery case opened. This is not resolved."
                      : "Not resolved, and no recovery case was opened."}
                  </p>
                  <p className="checkin-note">{recoveryCase.message}</p>
                  <StatusBadge domain="operational" status="CANNOT_BE_AUTOMATED" />
                </div>
              )}
            </section>
          )}
        </section>
      )}

      {completion === null && resolved !== null && (
        <>
          <section className="card checkin-card" aria-labelledby="checkin-verify-heading">
            <h2 className="checkin-card__heading" id="checkin-verify-heading">
              Verification
            </h2>

            <p className="checkin-attendee__name">
              {verification === null || verification.registration.attendee_name === ""
                ? resolved.registrationId
                : verification.registration.attendee_name}
            </p>
            <p className="checkin-attendee__meta">
              {resolved.registrationId}
              {verification !== null && verification.registration.ticket_type !== "" && (
                <> · {verification.registration.ticket_type}</>
              )}
              {resolved.origin === "reconciliation" && <> · found by payment reference</>}
            </p>

            {verifying && (
              <SkeletonList items={7} label="Running the seven verification checks…" />
            )}

            {verification !== null && (
              <>
                <ol className="checkin-checks">
                  {rows.map((row) => (
                    <li className="checkin-check" key={row.name} data-check-name={row.name}>
                      <span className="checkin-check__label">{row.label}</span>
                      {row.result === null ? (
                        <span className="checkin-check__unknown">{NOT_EVALUATED_LABEL}</span>
                      ) : (
                        <StatusBadge
                          domain="verification"
                          status={row.result.status}
                          detail={row.headline ?? undefined}
                        />
                      )}
                      <p className="checkin-check__message">
                        {row.result === null ? NOT_EVALUATED_MESSAGE : row.result.message}
                      </p>
                    </li>
                  ))}
                </ol>

                {/* The verdict the page acts on, in words. A WARN is not in it. */}
                <p className="checkin-verdict">
                  {canComplete
                    ? alreadyThrough
                      ? "Every check that matters passed. This attendee has already been through once — check-in is still available."
                      : "Every check passed. This attendee can go in."
                    : "A check failed. CommunityOps cannot let this attendee in on these records."}
                </p>
              </>
            )}

            <div className="checkin-actions">
              <button
                className="btn btn-primary"
                type="button"
                onClick={runComplete}
                disabled={!canComplete || busy}
              >
                {completing ? "Checking in…" : "Complete check-in"}
              </button>
              <button className="btn" type="button" onClick={startOver} disabled={busy}>
                Search someone else
              </button>
            </div>
          </section>

          <section className="card checkin-card" aria-labelledby="checkin-recover-heading">
            <h2 className="checkin-card__heading" id="checkin-recover-heading">
              {RECOVERY_HEADING}
            </h2>
            <p className="checkin-note">
              CommunityOps can regenerate this attendee&apos;s ticket. Doing it twice never creates a
              second ticket.
            </p>

            {ticket === null ? (
              <div className="checkin-actions">
                <button
                  className="btn"
                  type="button"
                  onClick={runRecover}
                  disabled={!canComplete || busy}
                >
                  {recovering ? "Recovering the ticket…" : "Recover ticket"}
                </button>
              </div>
            ) : (
              <div className="checkin-ticket">
                {/* Requirement 9.8: which of the two actually happened. */}
                <p className="checkin-ticket__outcome">{describeTicket(ticket)}</p>
                <p className="checkin-attendee__meta">Ticket {ticket.ticket_id}</p>
                {isDownloadable(ticket.download_url) && (
                  /* Plain `.btn`: one button height on the page (requirement
                     12.11), and a target a thumb can hit (requirement 14.6). */
                  <a
                    className="btn"
                    href={ticket.download_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open the ticket
                  </a>
                )}
              </div>
            )}
          </section>
        </>
      )}

      {completion !== null && (
        <section className="card checkin-complete" aria-labelledby="checkin-complete-heading">
          <h2 className="checkin-complete__title" id="checkin-complete-heading">
            {COMPLETION_HEADING}
          </h2>
          <p className="checkin-complete__line">{describeCompletion(completion)}</p>
          <p className="checkin-attendee__meta">
            {completion.registrationId} ·{" "}
            <time dateTime={toMachineTime(completion.checkedInAt) ?? undefined}>
              {formatAbsoluteTime(completion.checkedInAt)}
            </time>
          </p>
          <StatusBadge domain="operational" status="HANDLED" />
          <div className="checkin-actions">
            <button className="btn btn-primary" type="button" onClick={startOver}>
              Next attendee
            </button>
          </div>
        </section>
      )}

      {/* Requirement 9.12 and 13.5: category-mapped copy, the masked candidates
          alongside it when the failure is an ambiguous match, and the search term
          still in the field above. */}
      {failure !== null && (
        <ApiErrorState
          error={failure}
          onRetry={retry}
          context={attempt === "search" || attempt === "verify" ? "view" : "action"}
        >
          {outcome?.kind === "candidates" ? (
            <ul className="checkin-candidates__fallback">
              {outcome.candidates.map((candidate) => (
                <li key={candidate.registration_id}>
                  {candidate.attendee_name} · {candidate.registration_id} ·{" "}
                  {candidate.attendee_email === "" ? NO_MASKED_EMAIL_LABEL : candidate.attendee_email}
                </li>
              ))}
            </ul>
          ) : undefined}
        </ApiErrorState>
      )}
    </div>
  );
}

/** Only a real link is offered as one. The mock fixture returns `"#"`. */
function isDownloadable(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Requirement 9.8 — newly generated or already existing, read from
 * `already_existed` and never smoothed into one sentence.
 */
function describeTicket(result: TicketResult): string {
  return result.already_existed
    ? "This ticket already existed. A fresh download link is ready — no second ticket was created."
    : "A new ticket has been generated.";
}

/**
 * Requirement 9.10 — an existing check-in is reported as one. `checked_in_at` is
 * the time the response gave, which for an existing record is when they actually
 * arrived, not now.
 */
function describeCompletion(result: CheckinCompletion): string {
  const at = formatAbsoluteTime(result.checkedInAt);

  return result.wasAlreadyCheckedIn
    ? `This attendee was already checked in at ${at}. No new check-in was recorded — they can go in.`
    : `Checked in at ${at}.`;
}

/** What the verify response said, for the announcement (requirement 15.8). */
function describeVerification(result: VerificationOutcome): string {
  const failed = result.checks.filter((check) => check.status === "FAIL").length;

  if (failed > 0) {
    return `Verification finished: ${failed} of ${result.checks.length} checks failed. This attendee cannot be checked in.`;
  }

  return warnsAlreadyCheckedIn(result.checks)
    ? `Verification finished: all ${result.checks.length} checks clear, with a warning that this attendee has already checked in. Check-in is still available.`
    : `Verification finished: all ${result.checks.length} checks passed.`;
}
