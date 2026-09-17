# Check-In Recovery — Tasks

## Tasks

- [ ] 1. Create Registration, PaymentReference, Ticket, CheckIn, RecoveryCase domain models with Pydantic
- [ ] 2. Create DynamoDB repository for registration lookup (by regId, email, phone, name)
- [ ] 3. Create DynamoDB repository for payment reference lookup
- [ ] 4. Implement deterministic registration verification logic
- [ ] 5. Implement ticket generation service (PDF + QR with HMAC signing)
- [ ] 6. Implement S3 storage for ticket artifacts with pre-signed URLs
- [ ] 7. Create check-in search Lambda handler
- [ ] 8. Create check-in verify Lambda handler
- [ ] 9. Create check-in recover Lambda handler (with idempotency)
- [ ] 10. Create check-in reconcile Lambda handler (payment path)
- [ ] 11. Create check-in complete Lambda handler (with idempotency)
- [ ] 12. Create RecoveryCase handler for unresolved cases
- [ ] 13. Create agent tools: registration_lookup, payment_lookup, verify_registration, generate_ticket, complete_checkin
- [ ] 14. Add audit event emission for all recovery/checkin actions
- [ ] 15. Write unit tests for verification logic, ticket generation, idempotency
- [ ] 16. Write integration tests for full recovery flow (found, not found, ambiguous, external failure)
