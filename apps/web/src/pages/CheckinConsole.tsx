/**
 * Check-in console.
 *
 * The one screen a volunteer uses under pressure, with a queue behind the desk. Everything here
 * is shaped by that: one question at a time, the current step unmistakable, and the primary
 * action always the biggest thing on screen.
 *
 * The five-step flow is unchanged from the working implementation — search, verify, recover,
 * check in, done — because it maps to the backend's five endpoints and each step is a real
 * deterministic decision, not a wizard for its own sake. What changed is the presentation and
 * three correctness details:
 *
 * 1. **Disambiguation is a choice, not an error.** A name search matching several people used to
 *    show "provide a more specific identifier" and stop. The backend already returns the
 *    candidates with masked emails; now the volunteer picks one. Asking someone to retype a name
 *    they have already typed, while a queue waits, is the kind of dead end that gets a tool
 *    abandoned.
 *
 * 2. **A failed reconciliation is an answer.** `reconciled: false` arrives as HTTP 200 because the
 *    backend has determined the reference cannot be verified and has opened a recovery case. It
 *    is reported as a finding with a next step, not as a failure of the app.
 *
 * 3. **Verification failures are never overridable.** When a check fails, there is no button
 *    that proceeds anyway. The fallback is a recovery case, which is what the backend models.
 *
 * No AI is involved in any of this. Every check is a deterministic lookup, which is exactly why
 * a volunteer can rely on the answer.
 */

import { useState } from "react";

import {
  ApiError,
  completeCheckin,
  recoverTicket,
  reconcilePayment,
  searchCheckin,
  verifyCheckin,
} from "../api";
import { Card, EmptyState, Notice, PageHeader, StatusBadge } from "../components/primitives";
import type {
  RegistrationMatch,
  TicketResult,
  VerificationCheck,
  VerifiedRegistration,
} from "../types";

type Step = "search" | "verify" | "recover" | "checkin" | "done";

const STEPS: { key: Step; label: string }[] = [
  { key: "search", label: "Find" },
  { key: "verify", label: "Verify" },
  { key: "recover", label: "Ticket" },
  { key: "checkin", label: "Check in" },
  { key: "done", label: "Done" },
];

type SearchField = "name" | "email" | "phone" | "registration_id";

const SEARCH_FIELDS: { id: SearchField; label: string; placeholder: string }[] = [
  { id: "name", label: "Name", placeholder: "Kavya Nair" },
  { id: "email", label: "Email", placeholder: "kavya@example.com" },
  { id: "phone", label: "Phone", placeholder: "+91 98765 43210" },
  { id: "registration_id", label: "Registration ID", placeholder: "REG-00042" },
];

/** Check marks. Kept text-only so they survive any font and read in a screen reader. */
function checkMark(status: VerificationCheck["status"]): string {
  return status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "!";
}

function checkColor(status: VerificationCheck["status"]): string {
  return status === "PASS"
    ? "var(--status-completed)"
    : status === "FAIL"
      ? "var(--status-blocked)"
      : "var(--status-at-risk)";
}

export function CheckinConsole({ eventId }: { eventId: string }) {
  const [step, setStep] = useState<Step>("search");

  const [searchField, setSearchField] = useState<SearchField>("name");
  const [searchValue, setSearchValue] = useState("");
  const [candidates, setCandidates] = useState<RegistrationMatch[]>([]);

  const [match, setMatch] = useState<RegistrationMatch | null>(null);
  const [verified, setVerified] = useState<VerifiedRegistration | null>(null);
  const [checks, setChecks] = useState<VerificationCheck[]>([]);
  const [ticket, setTicket] = useState<TicketResult | null>(null);
  const [alreadyCheckedIn, setAlreadyCheckedIn] = useState(false);

  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [notFound, setNotFound] = useState(false);
  const [recoveryCase, setRecoveryCase] = useState<string | undefined>();
  const [transactionRef, setTransactionRef] = useState("");

  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const failedChecks = checks.filter((c) => c.status === "FAIL");

  function fail(err: unknown, fallback: string) {
    setProblem(err instanceof ApiError ? err.message : fallback);
  }

  function reset() {
    setStep("search");
    setSearchValue("");
    setCandidates([]);
    setMatch(null);
    setVerified(null);
    setChecks([]);
    setTicket(null);
    setAlreadyCheckedIn(false);
    setProblem(undefined);
    setNotFound(false);
    setRecoveryCase(undefined);
    setTransactionRef("");
  }

  async function runSearch() {
    const value = searchValue.trim();
    if (!value) return;
    setBusy(true);
    setProblem(undefined);
    setNotFound(false);
    setCandidates([]);
    setRecoveryCase(undefined);
    try {
      const result = await searchCheckin(eventId, { [searchField]: value });

      if (!result.found || result.count === 0) {
        // Not an error: the lookup worked and the answer is "nobody". The payment-reference
        // path is the backend's designed fallback, so it is offered right here.
        setNotFound(true);
        setProblem(result.message);
        return;
      }

      if (result.requires_disambiguation) {
        setCandidates(result.registrations);
        return;
      }

      const only = result.registrations[0];
      if (!only) {
        setNotFound(true);
        return;
      }
      setMatch(only);
      setStep("verify");
    } catch (err) {
      fail(err, "The search could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  async function runVerify(registrationId: string) {
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await verifyCheckin(eventId, registrationId);
      setChecks(result.verification.checks);
      setVerified(result.registration);
      if (result.verification.all_passed) setStep("recover");
    } catch (err) {
      fail(err, "Verification could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  async function runRecover() {
    if (!match) return;
    setBusy(true);
    setProblem(undefined);
    try {
      setTicket(await recoverTicket(eventId, match.registration_id));
      setStep("checkin");
    } catch (err) {
      fail(err, "The ticket could not be issued.");
    } finally {
      setBusy(false);
    }
  }

  async function runCheckin() {
    if (!match) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await completeCheckin(eventId, match.registration_id);
      setAlreadyCheckedIn(result.was_already_checked_in);
      setStep("done");
    } catch (err) {
      fail(err, "Check-in could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  async function runReconcile() {
    const reference = transactionRef.trim();
    if (!reference) return;
    setBusy(true);
    setProblem(undefined);
    setRecoveryCase(undefined);
    try {
      const result = await reconcilePayment(eventId, reference);
      if (result.reconciled && result.registration_id) {
        setMatch({
          registration_id: result.registration_id,
          attendee_name: result.registration?.attendee_name ?? "",
          ticket_type: result.registration?.ticket_type,
        });
        setNotFound(false);
        setStep("verify");
        return;
      }
      // The reference was checked and could not be verified. That is a result the volunteer
      // needs to read and hand on, not a failure to retry.
      setProblem(result.message || "That reference could not be matched to a registration.");
      if (result.recovery_case_created) {
        setRecoveryCase(
          "A recovery case has been opened. The registration team can resolve it without holding up the queue.",
        );
      }
    } catch (err) {
      fail(err, "Reconciliation could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  const activeField = SEARCH_FIELDS.find((f) => f.id === searchField)!;

  return (
    <div>
      <PageHeader
        title="Check-in desk"
        subtitle="Find an attendee, confirm their registration is genuine, and issue a ticket. Every check is a direct lookup — nothing here is inferred."
        actions={
          step !== "search" && (
            <button className="btn btn-sm" type="button" onClick={reset}>
              Next attendee
            </button>
          )
        }
      />

      <div className="lifecycle" style={{ marginBottom: "var(--s5)" }} aria-label="Progress">
        {STEPS.map((s, index) => (
          <div key={s.key} style={{ display: "flex", alignItems: "center" }}>
            {index > 0 && <span className="lifecycle-line" aria-hidden="true" />}
            <span
              className={`lifecycle-step ${
                index < stepIndex ? "done" : index === stepIndex ? "current" : ""
              }`}
              aria-current={index === stepIndex ? "step" : undefined}
            >
              <span className="lifecycle-dot" aria-hidden="true" />
              {s.label}
            </span>
          </div>
        ))}
      </div>

      {problem && (
        <div style={{ marginBottom: "var(--s4)" }}>
          <Notice tone={notFound || recoveryCase ? "warn" : "error"}>{problem}</Notice>
        </div>
      )}
      {recoveryCase && (
        <div style={{ marginBottom: "var(--s4)" }}>
          <Notice tone="info">{recoveryCase}</Notice>
        </div>
      )}

      {/* ---------------------------------------------------------------- Step 1 */}
      {step === "search" && (
        <div className="stack">
          <Card title="Who is at the desk?">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void runSearch();
              }}
            >
              <div className="input-row">
                <div className="field" style={{ minWidth: 170 }}>
                  <label className="field-label" htmlFor="checkin-field">
                    Search by
                  </label>
                  <select
                    id="checkin-field"
                    className="select"
                    value={searchField}
                    onChange={(e) => {
                      setSearchField(e.target.value as SearchField);
                      setCandidates([]);
                    }}
                  >
                    {SEARCH_FIELDS.map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field grow">
                  <label className="field-label" htmlFor="checkin-value">
                    {activeField.label}
                  </label>
                  <input
                    id="checkin-value"
                    className="input"
                    placeholder={activeField.placeholder}
                    value={searchValue}
                    onChange={(e) => setSearchValue(e.target.value)}
                    autoFocus
                  />
                </div>
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={busy || !searchValue.trim()}
                >
                  {busy ? "Searching…" : "Search"}
                </button>
              </div>
              <p className="field-hint" style={{ marginTop: "var(--s2)" }}>
                An exact identifier finds one person immediately. A name may match several — you
                will be asked which.
              </p>
            </form>
          </Card>

          {/* Several matches: pick the right person rather than retyping. */}
          {candidates.length > 0 && (
            <Card
              title={`${candidates.length} people match that`}
              padding="flush"
              footer={
                <span className="t-meta">
                  Email addresses are partly hidden until you confirm who this is.
                </span>
              }
            >
              <ul className="rows">
                {candidates.map((candidate) => (
                  <li className="row" key={candidate.registration_id}>
                    <div className="row-main">
                      <div className="row-title">{candidate.attendee_name}</div>
                      <div className="row-meta">
                        <span className="t-mono">{candidate.registration_id}</span>
                        {candidate.attendee_email ? ` · ${candidate.attendee_email}` : ""}
                        {candidate.ticket_type ? ` · ${candidate.ticket_type}` : ""}
                      </div>
                    </div>
                    <div className="row-side">
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setMatch(candidate);
                          setCandidates([]);
                          setStep("verify");
                        }}
                      >
                        This one
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* Nobody found: the payment-reference fallback. */}
          {notFound && (
            <Card title="Try a payment reference">
              <p className="t-body" style={{ marginBottom: "var(--s4)" }}>
                If they paid but no registration was created, the transaction reference from their
                receipt or bank message can be matched instead.
              </p>
              <form
                className="input-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void runReconcile();
                }}
              >
                <div className="field grow">
                  <label className="field-label" htmlFor="checkin-txn">
                    Transaction reference
                  </label>
                  <input
                    id="checkin-txn"
                    className="input"
                    placeholder="TXN-KH-78901"
                    value={transactionRef}
                    onChange={(e) => setTransactionRef(e.target.value)}
                  />
                </div>
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={busy || !transactionRef.trim()}
                >
                  {busy ? "Checking…" : "Check payment"}
                </button>
              </form>
              <p className="field-hint" style={{ marginTop: "var(--s2)" }}>
                Reference numbers only. Never ask for a card number, CVV or PIN — CommunityOps does
                not accept them.
              </p>
            </Card>
          )}
        </div>
      )}

      {/* ---------------------------------------------------------------- Step 2 */}
      {step === "verify" && match && (
        <Card title="Confirm this registration">
          <div style={{ marginBottom: "var(--s4)" }}>
            <div className="t-section" style={{ marginBottom: 2 }}>
              {match.attendee_name || verified?.attendee_name || "Registration"}
            </div>
            <div className="t-meta">
              <span className="t-mono">{match.registration_id}</span>
              {(verified?.ticket_type || match.ticket_type) &&
                ` · ${verified?.ticket_type || match.ticket_type}`}
            </div>
          </div>

          {checks.length === 0 ? (
            <>
              <p className="t-body" style={{ marginBottom: "var(--s4)" }}>
                Seven checks run against the registration and payment records: that it exists, is
                for this event, is confirmed, is paid, is not cancelled or refunded, and has not
                already been used.
              </p>
              <button
                className="btn btn-primary"
                type="button"
                disabled={busy}
                onClick={() => void runVerify(match.registration_id)}
              >
                {busy ? "Checking…" : "Run the checks"}
              </button>
            </>
          ) : (
            <>
              <CheckList checks={checks} />

              {failedChecks.length > 0 ? (
                <div style={{ marginTop: "var(--s4)" }}>
                  <Notice tone="error">
                    This registration cannot be checked in.{" "}
                    {failedChecks.map((c) => c.message).join(" ")} There is no override — this needs
                    the registration team.
                  </Notice>
                  <div className="cluster" style={{ marginTop: "var(--s4)" }}>
                    <button className="btn" type="button" onClick={reset}>
                      Start over
                    </button>
                  </div>
                </div>
              ) : (
                <div className="cluster" style={{ marginTop: "var(--s4)" }}>
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={busy}
                    onClick={() => void runRecover()}
                  >
                    {busy ? "Working…" : "Issue the ticket"}
                  </button>
                  <button className="btn btn-ghost" type="button" onClick={reset}>
                    Start over
                  </button>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {/* ---------------------------------------------------------------- Step 3 */}
      {step === "recover" && match && (
        <Card title="Everything checks out">
          <div style={{ marginBottom: "var(--s4)" }}>
            <div className="t-section" style={{ marginBottom: 2 }}>
              {verified?.attendee_name || match.attendee_name}
            </div>
            <div className="cluster">
              <StatusBadge tone="completed" label="Verified" />
              {verified?.ticket_type && (
                <span className="badge badge-outline">{verified.ticket_type}</span>
              )}
            </div>
          </div>

          <CheckList checks={checks} />

          <div className="cluster" style={{ marginTop: "var(--s4)" }}>
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy}
              onClick={() => void runRecover()}
            >
              {busy ? "Issuing…" : "Issue the ticket"}
            </button>
            <button className="btn btn-ghost" type="button" onClick={reset}>
              Start over
            </button>
          </div>
        </Card>
      )}

      {/* ---------------------------------------------------------------- Step 4 */}
      {step === "checkin" && match && ticket && (
        <Card title="Ticket ready">
          <div style={{ marginBottom: "var(--s4)" }}>
            <div className="t-section" style={{ marginBottom: 2 }}>
              {verified?.attendee_name || match.attendee_name}
            </div>
            <div className="t-meta">
              Ticket <span className="t-mono">{ticket.ticket_id}</span>
              {ticket.already_existed && " · reissued, not duplicated"}
            </div>
          </div>

          {ticket.download_url && ticket.download_url !== "#" && (
            <p style={{ marginBottom: "var(--s4)" }}>
              <a
                className="btn btn-sm"
                href={ticket.download_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open the ticket
              </a>
            </p>
          )}

          <Notice tone="info">
            Hand over the ticket, then record the check-in. Recording twice is harmless — the
            backend keeps one check-in per registration.
          </Notice>

          <div className="cluster" style={{ marginTop: "var(--s4)" }}>
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy}
              onClick={() => void runCheckin()}
            >
              {busy ? "Recording…" : "Check them in"}
            </button>
            <button className="btn btn-ghost" type="button" onClick={reset}>
              Start over
            </button>
          </div>
        </Card>
      )}

      {/* ---------------------------------------------------------------- Step 5 */}
      {step === "done" && match && (
        <EmptyState
          mark="✓"
          title={alreadyCheckedIn ? "Already checked in" : "Checked in"}
          body={
            alreadyCheckedIn
              ? `${verified?.attendee_name || match.attendee_name} was already recorded as checked in. Nothing was duplicated.`
              : `${verified?.attendee_name || match.attendee_name} is in. Recorded against ${match.registration_id}.`
          }
          action={
            <button className="btn btn-primary" type="button" onClick={reset}>
              Next attendee
            </button>
          }
        />
      )}
    </div>
  );
}

/** The verification results, in the order the backend ran them. */
function CheckList({ checks }: { checks: VerificationCheck[] }) {
  return (
    <ul className="stack-sm" style={{ listStyle: "none" }}>
      {checks.map((check) => (
        <li key={check.name} className="cluster" style={{ gap: "var(--s3)", alignItems: "start" }}>
          <span
            aria-hidden="true"
            style={{
              color: checkColor(check.status),
              fontWeight: 700,
              width: 14,
              flexShrink: 0,
              textAlign: "center",
            }}
          >
            {checkMark(check.status)}
          </span>
          <span className="t-body grow">
            <span className="sr-only">{check.status}: </span>
            {check.message}
          </span>
        </li>
      ))}
    </ul>
  );
}
