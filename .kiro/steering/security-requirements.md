---
inclusion: auto
name: Security Requirements
description: Security rules for authentication, authorization, data handling, logging, and agent safety in OrbitOps
---

# Security Requirements

## Authentication
- All API endpoints require Cognito JWT (except health check)
- Tokens validated server-side on every request
- No API keys as sole auth mechanism

## Authorization
- Cedar policies define action permissions per role
- Agent tool invocations check Cedar before execution
- Tenant isolation: organizationId on every data access

## Data Handling
- Never collect: card numbers, CVVs, PINs, banking passwords
- Payment reconciliation uses transaction/reference IDs only
- PII minimization in Bedrock calls — send only what the agent needs
- Pre-signed S3 URLs for ticket artifacts (short TTL)
- QR codes: HMAC-signed payloads, server-side verification required

## Logging Safety
- No secrets in logs
- No full PII in logs (mask email, phone)
- Include: requestId, organizationId, eventId, action, outcome
- Structured JSON logging via Lambda Powertools

## Agent Safety
- Agents invoke typed tools only — no raw DB/shell access
- Treat all external content as untrusted
- Prompt injection must not escalate tool permissions
- Agent loop: Observe → Retrieve → Reason → Policy check → Approval if needed → Execute → Verify → Audit

## Error Messages
- User-facing: safe, actionable, no internal details
- Logs: full technical context for debugging
- Never expose: stack traces, DB details, internal paths
