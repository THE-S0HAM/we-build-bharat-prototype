# Check-In Recovery — Requirements

## Overview
Smart ticket recovery flow for attendees who cannot present their ticket at the venue.

## User Stories

### US-1: Registration Lookup
As a volunteer, I want to search for an attendee by registration ID, email, phone, or name so that I can locate their registration quickly.

**Acceptance Criteria:**
- Search accepts: registration ID, email, phone, name
- Exact identifiers (reg ID, email, phone) return a single match
- Name search may return multiple candidates
- Multiple matches require additional identifying information — never auto-select
- Search completes within 3 seconds

### US-2: Registration Verification
As the system, I must deterministically verify a registration before allowing ticket recovery.

**Acceptance Criteria:**
- Verify: registration exists, belongs to event, status is valid, payment is valid, not cancelled, not refunded, eligible for check-in
- Each verification step produces a clear pass/fail result
- All checks are deterministic (no LLM inference)

### US-3: Ticket Recovery
As a volunteer, I want to recover/regenerate a ticket for a verified attendee so they can check in.

**Acceptance Criteria:**
- Ticket ID equals Registration ID (REG-2026-XXXXXX)
- PDF generated with event details, attendee name, QR code
- QR code is HMAC-signed, verified server-side
- Ticket stored in S3 with pre-signed URL (short TTL)
- Idempotent: repeated recovery for the same registration produces the same ticket, not duplicates

### US-4: Payment Reconciliation
As the system, when no registration is found, I must attempt to reconcile via payment reference.

**Acceptance Criteria:**
- Volunteer can enter a transaction/payment reference ID
- System never collects: card numbers, CVV, PIN, banking passwords
- If payment found and confidently linked: recover registration + generate ticket
- If payment found but ambiguous: create reconciliation exception
- If nothing found: create UNRESOLVED RecoveryCase with appropriate messaging

### US-5: Check-In Completion
As a volunteer, I want to check in an attendee after ticket recovery so they are marked as arrived.

**Acceptance Criteria:**
- Check-in is idempotent (duplicate check-in attempts do not error)
- Audit event created for every check-in
- Already-checked-in attendees show clear status without error

### US-6: Unresolved Cases
As the system, I must gracefully handle cases where recovery is not possible.

**Acceptance Criteria:**
- RecoveryCase created with status UNRESOLVED and reason code
- Reason codes: NO_MATCH, AMBIGUOUS_PAYMENT, EXTERNAL_SYSTEM_FAILURE
- Messaging: "No matching registration or payment record was found..."
- Never fabricate a registration
- Never claim certainty beyond available evidence
