# Check-In Recovery — Design

## Flow

```
Volunteer opens Check-in Recovery
        │
        ▼
Search (regId / email / phone / name)
        │
        ├── Found (single) ──▶ Verify registration
        ├── Found (multiple) ──▶ Request additional info
        └── Not found ──▶ Payment reconciliation path
                              │
                              ├── Payment found + linked ──▶ Recover registration
                              ├── Payment found + ambiguous ──▶ Reconciliation exception
                              └── Payment not found ──▶ UNRESOLVED RecoveryCase
```

## Components

### API Endpoints (Lambda)
- `POST /events/{eventId}/checkin/search` — Search by identifiers
- `POST /events/{eventId}/checkin/verify` — Run verification checks
- `POST /events/{eventId}/checkin/recover` — Generate/recover ticket
- `POST /events/{eventId}/checkin/reconcile` — Payment-based reconciliation
- `POST /events/{eventId}/checkin/complete` — Mark check-in complete

### Tools (Agent-callable)
- `registration_lookup` — Query registration by various identifiers
- `payment_lookup` — Query payment by transaction reference
- `verify_registration` — Run deterministic verification checks
- `generate_ticket` — Create PDF + QR, store in S3
- `complete_checkin` — Mark attendee as checked in

### Data
- **Registration** — DynamoDB, keyed by (orgId, eventId#regId)
- **PaymentReference** — DynamoDB, keyed by (orgId, transactionRef)
- **Ticket** — DynamoDB metadata + S3 artifact
- **CheckIn** — DynamoDB, keyed by (orgId, eventId#regId)
- **RecoveryCase** — DynamoDB, status-tracked unresolved cases

### QR Signing
- HMAC-SHA256 with event-scoped secret from Secrets Manager
- Payload: `{regId, eventId, orgId, timestamp}`
- Verification: recompute HMAC server-side, compare, check expiry

### Idempotency
- Ticket generation: check if ticket already exists for regId before generating
- Check-in: upsert with condition — if already CHECKED_IN, return success without side effects
- Recovery case: deduplicate by (orgId, eventId, searchCriteria hash)

## Error Handling
- External system unavailable: return EXTERNAL_SERVICE_ERROR, create retry-eligible RecoveryCase
- Ambiguous match: return AMBIGUOUS_MATCH with candidates, never auto-select
- Already checked in: return success with existing check-in timestamp
