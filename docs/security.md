# Security Architecture

## Authentication

All API endpoints require a valid Cognito JWT (except health checks and CORS preflight).

- Users authenticate via Cognito User Pool
- Tokens validated by API Gateway Cognito Authorizer
- Token claims (sub, email, groups) extracted in Lambda handlers

## Authorization

### Cedar Policy Engine

Cedar policies define three risk levels:

| Level | Examples | Approval |
|-------|----------|----------|
| LOW | Read state, create task, draft message | Auto-allowed |
| MEDIUM | Send communication, update metadata | Allowed for ORGANIZER+ |
| HIGH | Refund, booking, speaker confirmation, cancel registration | Requires approval |

### Tenant Isolation

Every database query includes `organization_id` as the partition key. Cedar policies additionally enforce `principal.organization_id == resource.organization_id`.

## Agent Safety

- Agents invoke typed tools only — no raw database, shell, or API access
- All external content treated as untrusted
- Prompt injection cannot escalate tool permissions (tools check authorization independently)
- Agent loop enforces: Observe → Retrieve → Reason → **Policy Check** → Execute

## Data Protection

- **No secrets in code**: All credentials in Secrets Manager or environment variables
- **No PII in logs**: Email and phone masked in log output
- **No payment credentials collected**: Only transaction reference IDs
- **Pre-signed URLs**: Ticket PDFs accessible only via time-limited S3 pre-signed URLs
- **QR code signing**: HMAC-SHA256 with server-side verification

## QR Security

QR codes contain a JSON payload with registration, event, and org IDs. The payload is HMAC-signed with a secret stored in Secrets Manager. Verification recomputes the HMAC server-side using constant-time comparison. The signature is stored in DynamoDB — not in the QR code itself. This prevents forgery even if the payload structure is known.

## IAM Least Privilege

Each Lambda function has its own IAM role with only the permissions it needs:
- Read-only functions get `DynamoDBReadPolicy`
- Write functions get `DynamoDBCrudPolicy` scoped to specific tables
- Ticket generation gets S3 write access to the ticket bucket only
- Audit functions get EventBridge put access to the audit bus only
