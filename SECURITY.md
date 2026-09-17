# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly.
Do not open a public issue. Contact the maintainers directly.

## Security Architecture

OrbitOps follows these security principles:

- **Authentication**: Amazon Cognito for all user authentication
- **Authorization**: Cedar policy engine for fine-grained access control
- **Least privilege**: Agents invoke narrow, typed tools — no unrestricted database or shell access
- **Tenant isolation**: All queries scoped by organizationId and eventId
- **Secrets management**: AWS Secrets Manager for all credentials
- **Audit trail**: Every consequential operation is logged with full context
- **Input validation**: Server-side validation on all API boundaries
- **Safe logging**: No PII, secrets, or payment data in logs
- **Signed artifacts**: QR codes use HMAC signatures with server-side verification
- **Temporary access**: S3 pre-signed URLs for sensitive documents

## What We Do NOT Collect

- Credit card numbers
- CVVs, PINs, or banking passwords
- Unnecessary personal payment credentials

Payment reconciliation uses only transaction/reference IDs provided by the payment system.
