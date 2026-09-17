# ADR-002: Ticket ID Equals Registration ID

## Status
Accepted

## Context
When an attendee loses their ticket and requests recovery, the system generates a new ticket. If ticket IDs were independent from registration IDs, recovery could accidentally create parallel identities — leading to duplicate check-ins, reconciliation confusion, and audit gaps.

## Decision
Ticket ID always equals Registration ID. Example: REG-2026-004821 is both the registration and the ticket.

## Rationale
- **No duplicate identities**: recovery produces the same ticket, not a new one
- **Idempotent**: repeated recovery requests return the existing ticket
- **Simple reconciliation**: one ID traces from registration through payment, ticket, and check-in
- **Audit clarity**: every event in the audit trail references the same ID

## Consequences
- Ticket generation checks for existing ticket before creating
- If a registration is cancelled and a new one created, it gets a new reg/ticket ID
- External ticket systems that use independent IDs would need an adapter
