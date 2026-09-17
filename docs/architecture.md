# OrbitOps Architecture

## Overview

OrbitOps is an AI Community Operations Agent built on AWS-native serverless services. It coordinates event operations for community organizers by automating repetitive work while keeping consequential decisions under human control.

## Fundamental Principles

1. **Deterministic systems establish facts** — registration status, payment captures, check-in eligibility are verified through database/API calls, never inferred by AI
2. **AI reasons about facts** — agents analyze operational state and recommend actions
3. **Policies control authority** — Cedar policies define what agents may do at each risk level
4. **Workflows execute process** — Step Functions orchestrate multi-step async operations
5. **Humans approve consequential actions** — HIGH_RISK actions require explicit approval

## Architecture Diagram

```
User (Web)
    │
    ▼
CloudFront / S3 (React SPA)
    │
    ▼
Amazon Cognito (Auth)
    │
    ▼
API Gateway (REST)
    │
    ▼
Lambda Handlers (Python 3.12)
    │
    ├─────────────────────────────────┐
    │                                 │
    ▼                                 ▼
DynamoDB                        EventBridge
(Operational State)             (Event Bus)
    │                                 │
    │                                 ▼
    │                          Step Functions
    │                          (Workflows)
    │                                 │
    │               ┌─────────┬──────┴──────┬─────────┐
    │               ▼         ▼             ▼         ▼
    │          SpeakerOps  TeamOps    IncidentOps  CheckInOps
    │               │         │             │         │
    │               └─────────┴──────┬──────┘         │
    │                                │                │
    │                                ▼                │
    │                        Supervisor Agent         │
    │                        (Strands + Bedrock)      │
    │                                │                │
    │                    ┌───────────┴───────────┐    │
    │                    ▼                       ▼    │
    │            Structured Tools          RAG/Knowledge
    │            (Typed Connectors)        (S3 / Bedrock KB)
    │                    │
    │      ┌─────────┬──┴──┬──────────┬─────────┐
    │      ▼         ▼     ▼          ▼         ▼
    │  Registration Payment Calendar  Email    CRM
    │  Connector   Connector Connector SES     APIs
    │
    ▼
S3 (Ticket PDFs, Knowledge Docs)
```

## Cross-Cutting Concerns

- **Cedar**: Policy enforcement at the application layer
- **CloudWatch**: Structured logging, metrics, tracing
- **Secrets Manager**: QR signing keys, API credentials
- **Audit Events**: Every consequential action logged to DynamoDB + EventBridge

## AWS Service Map

| Concern | Service | Justification |
|---------|---------|--------------|
| Identity | Cognito | Managed auth, JWT tokens, user pool |
| API | API Gateway + Lambda | Serverless, per-request billing |
| Operational DB | DynamoDB | Single-digit-ms latency, pay-per-request |
| Storage | S3 | Ticket PDFs, knowledge docs |
| Events | EventBridge | Decoupled event routing |
| Workflows | Step Functions | Long-running workflows with human-in-loop |
| AI | Bedrock + Strands | Managed LLM access, agent framework |
| Email | SES | Transactional email |
| Policy | Cedar | Fine-grained authorization |
| Secrets | Secrets Manager | Key management |
| Observability | CloudWatch | Logs, metrics, alarms |
| IaC | SAM / CloudFormation | Template-based deployment |

## Data Flow: Check-In Recovery

```
Volunteer → Search → Registration Lookup (DynamoDB)
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
           Found    Not Found    Multiple
              │          │          │
              ▼          ▼          ▼
           Verify   Payment    Disambiguate
              │     Reconcile     │
              ▼          │        ▼
           Pass?    ┌────┴────┐  More Info
            │       ▼         ▼
            ▼    Linked    Ambiguous
         Generate   │         │
         Ticket     ▼         ▼
            │    Recover   Recovery
            ▼    Ticket    Case
         S3 Upload    │
            │         ▼
            ▼      Check-in
         Pre-signed    │
         URL          ▼
            │       Audit
            ▼
         Volunteer
```

## Tenant Isolation

All data access is scoped by `organization_id` (DynamoDB partition key). Every query, whether from API handler, agent tool, or workflow step, includes the organization ID. Cedar policies additionally enforce that principals can only access resources within their organization.
