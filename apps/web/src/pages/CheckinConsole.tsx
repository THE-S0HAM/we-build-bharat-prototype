import { useState } from "react";
import { searchCheckin, verifyCheckin, recoverTicket, completeCheckin, reconcilePayment } from "../api";
import type { Registration, VerificationCheck, TicketResult } from "../types";

type Step = "search" | "verify" | "recover" | "checkin" | "done";

export function CheckinConsole({ eventId }: { eventId: string }) {
  const [step, setStep] = useState<Step>("search");
  const [searchType, setSearchType] = useState("name");
  const [searchValue, setSearchValue] = useState("");
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [checks, setChecks] = useState<VerificationCheck[]>([]);
  const [ticket, setTicket] = useState<TicketResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showReconcile, setShowReconcile] = useState(false);
  const [txnRef, setTxnRef] = useState("");

  async function handleSearch() {
    setError("");
    setLoading(true);
    try {
      const result = await searchCheckin(eventId, { [searchType]: searchValue });
      if (!result.found || result.count === 0) {
        setShowReconcile(true);
        setError(result.message || "No registration found.");
        return;
      }
      if (result.requires_disambiguation) {
        setError(`${result.count} matches found. Please provide a more specific identifier.`);
        return;
      }
      setRegistration(result.registrations[0] ?? null);
      setStep("verify");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify() {
    if (!registration) return;
    setLoading(true);
    try {
      const result = await verifyCheckin(eventId, registration.registration_id);
      setChecks(result.verification.checks);
      setStep(result.verification.all_passed ? "recover" : "verify");
      if (!result.verification.all_passed) {
        setError("Verification failed. See details below.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleRecover() {
    if (!registration) return;
    setLoading(true);
    try {
      const result = await recoverTicket(eventId, registration.registration_id);
      setTicket(result);
      setStep("checkin");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ticket recovery failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleCheckin() {
    if (!registration) return;
    setLoading(true);
    try {
      await completeCheckin(eventId, registration.registration_id);
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check-in failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleReconcile() {
    if (!txnRef.trim()) return;
    setLoading(true);
    setError("");
    try {
      const result = await reconcilePayment(eventId, txnRef) as Record<string, unknown>;
      if (result.reconciled) {
        setRegistration({ registration_id: result.registration_id as string, attendee_name: (result.registration as Record<string, string>)?.attendee_name || "", attendee_email: "", attendee_phone: "", event_id: eventId, status: "CONFIRMED", payment_status: "CAPTURED", ticket_type: "GENERAL", is_checked_in: false });
        setShowReconcile(false);
        setStep("verify");
      } else {
        setError((result.message as string) || "Reconciliation could not be completed.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reconciliation failed");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setStep("search");
    setSearchValue("");
    setRegistration(null);
    setChecks([]);
    setTicket(null);
    setError("");
    setShowReconcile(false);
    setTxnRef("");
  }

  const steps: { key: Step; label: string }[] = [
    { key: "search", label: "1. Search" },
    { key: "verify", label: "2. Verify" },
    { key: "recover", label: "3. Recover Ticket" },
    { key: "checkin", label: "4. Check In" },
    { key: "done", label: "5. Done" },
  ];
  const stepIndex = steps.findIndex((s) => s.key === step);

  return (
    <div>
      <h1 className="page-title">Check-In Console</h1>
      <p className="page-subtitle">Smart ticket recovery for attendees</p>

      <div className="stepper">
        {steps.map((s, i) => (
          <div key={s.key} className={`step ${i === stepIndex ? "active" : ""} ${i < stepIndex ? "done" : ""}`}>
            {s.label}
          </div>
        ))}
      </div>

      {error && <div className="card" style={{ borderLeftColor: "var(--color-critical)", borderLeftWidth: 3 }}><p>{error}</p></div>}

      {/* Step 1: Search */}
      {step === "search" && (
        <div className="card">
          <div className="card-header"><span className="card-title">Search Registration</span></div>
          <div className="input-group">
            <select className="input" style={{ maxWidth: 180 }} value={searchType} onChange={(e) => setSearchType(e.target.value)}>
              <option value="name">Name</option>
              <option value="email">Email</option>
              <option value="phone">Phone</option>
              <option value="registration_id">Registration ID</option>
            </select>
            <input className="input" placeholder={`Search by ${searchType}...`} value={searchValue} onChange={(e) => setSearchValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSearch()} />
            <button className="btn btn-primary" onClick={handleSearch} disabled={loading || !searchValue.trim()}>
              {loading ? "Searching..." : "Search"}
            </button>
          </div>

          {showReconcile && (
            <div style={{ marginTop: 16 }}>
              <p style={{ marginBottom: 8, color: "var(--color-text-muted)", fontSize: 14 }}>
                No registration found. Enter a payment/transaction reference to attempt reconciliation:
              </p>
              <div className="input-group">
                <input className="input" placeholder="Transaction reference (e.g. TXN-KH-78901)" value={txnRef} onChange={(e) => setTxnRef(e.target.value)} />
                <button className="btn btn-primary" onClick={handleReconcile} disabled={loading || !txnRef.trim()}>
                  {loading ? "Reconciling..." : "Reconcile"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 2: Verify */}
      {step === "verify" && registration && (
        <div className="card">
          <div className="card-header"><span className="card-title">Registration Found</span></div>
          <p style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>{registration.attendee_name}</p>
          <p style={{ color: "var(--color-text-muted)", marginBottom: 16 }}>{registration.registration_id} · {registration.ticket_type}</p>

          {checks.length > 0 && (
            <ul className="check-list">
              {checks.map((c) => (
                <li key={c.name} className="check-item">
                  <span className={`check-icon check-${c.status.toLowerCase()}`}>
                    {c.status === "PASS" ? "✓" : c.status === "FAIL" ? "✗" : "⚠"}
                  </span>
                  <span>{c.message}</span>
                </li>
              ))}
            </ul>
          )}

          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button className="btn btn-primary" onClick={checks.length === 0 ? handleVerify : handleRecover} disabled={loading || (checks.length > 0 && checks.some((c) => c.status === "FAIL"))}>
              {loading ? "Processing..." : checks.length === 0 ? "Run Verification" : "Recover Ticket"}
            </button>
            <button className="btn" onClick={reset}>Start Over</button>
          </div>
        </div>
      )}

      {/* Step 3: Recover */}
      {step === "recover" && registration && (
        <div className="card">
          <div className="card-header"><span className="card-title">Verification Passed</span></div>
          <ul className="check-list">
            {checks.map((c) => (
              <li key={c.name} className="check-item">
                <span className={`check-icon check-${c.status.toLowerCase()}`}>
                  {c.status === "PASS" ? "✓" : c.status === "FAIL" ? "✗" : "⚠"}
                </span>
                <span>{c.message}</span>
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 16 }}>
            <button className="btn btn-primary" onClick={handleRecover} disabled={loading}>
              {loading ? "Generating ticket..." : "Generate Ticket"}
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Check-in */}
      {step === "checkin" && ticket && registration && (
        <div className="card">
          <div className="card-header"><span className="card-title">Ticket Ready</span></div>
          <p style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>{registration.attendee_name}</p>
          <p style={{ marginBottom: 16 }}>
            <span className="badge badge-healthy">VERIFIED</span>
            {" "}Ticket: <strong>{ticket.ticket_id}</strong>
          </p>
          {ticket.download_url && ticket.download_url !== "#" && (
            <p style={{ marginBottom: 16 }}>
              <a href={ticket.download_url} target="_blank" rel="noopener noreferrer" className="btn btn-sm">📄 Download Ticket PDF</a>
            </p>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-success" onClick={handleCheckin} disabled={loading}>
              {loading ? "Checking in..." : "✓ Complete Check-In"}
            </button>
            <button className="btn" onClick={reset}>Start Over</button>
          </div>
        </div>
      )}

      {/* Step 5: Done */}
      {step === "done" && registration && (
        <div className="card" style={{ borderLeftColor: "var(--color-healthy)", borderLeftWidth: 3 }}>
          <h2 style={{ color: "var(--color-healthy)", marginBottom: 8 }}>✓ Check-In Complete</h2>
          <p>{registration.attendee_name} — {registration.registration_id}</p>
          <button className="btn" onClick={reset} style={{ marginTop: 16 }}>Next Attendee</button>
        </div>
      )}
    </div>
  );
}
