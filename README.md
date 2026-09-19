# CommunityOps Agent

An AI Community Operations Agent that coordinates event operations for community leaders, automating repetitive work while keeping consequential decisions under human control.

## Problem

Community organizers juggle speakers, teams, attendees, check-ins, incidents, approvals, and logistics across multiple events. Most of this is manual: chasing follow-ups, resolving on-the-spot issues, reconciling registrations, and coordinating across teams. Mistakes happen when humans are overloaded.

## Solution

CommunityOps is an AI-powered operations layer. It observes operational state, retrieves trusted facts from deterministic systems, reasons about next actions, enforces policy, obtains human approval when required, executes bounded actions, and audits the result.

**Core principle:** Deterministic systems establish facts. AI reasons about the facts. Policies control what the AI may do. Workflows execute the process. Humans approve consequential actions.

## Hero Workflow: Smart Check-In Recovery

An attendee arrives at the event without a usable ticket or pass. CommunityOps handles the full recovery:

1. **Search** - Look up registration by name, email, phone, or ID
2. **Verify** - Run deterministic checks: registration status, payment captured, not cancelled/refunded
3. **Reconcile** - If registration not found, attempt payment reference reconciliation
4. **Recover Ticket** - Generate PDF ticket with signed QR code, upload to S3
5. **Check In** - Idempotent check-in with duplicate protection
6. **Audit** - Full audit trail of every step

Edge cases handled: ambiguous matches (disambiguation), cancelled/refunded registrations (rejection), external service failures (recovery case creation, not false negatives), duplicate requests (idempotency).

## Architecture

| Concern | Service |
|---------|---------|
| Identity | Amazon Cognito |
| API | API Gateway + Lambda (Python 3.12) |
| Database | DynamoDB (single-table design) |
| Storage | S3 (ticket PDFs, knowledge docs) |
| Events | EventBridge |
| Workflows | Step Functions (human-in-the-loop) |
| AI | Strands Agents SDK + Amazon Bedrock |
| Policy | Cedar |
| Frontend | React + TypeScript (Vite) |
| IaC | AWS SAM / CloudFormation |

## Agent System

| Agent | Responsibility |
|-------|---------------|
| **Supervisor** | Routes operational intent, coordinates specialists, requests human approval |
| **CheckInOps** | Ticket recovery, registration lookup, payment reconciliation, check-in |
| **SpeakerOps** | Speaker outreach, follow-ups, availability tracking |
| **TeamOps** | Task management, deadlines, dependencies, escalation |
| **AttendeeOps** | Missing information, dietary/accommodation, communication |
| **IncidentOps** | Risk detection, impact analysis, backup options, incident resolution |

## Key Design Decisions

- **No LLM for transactional truth**: Registration status, payment captures, and check-in eligibility come from DynamoDB, never from AI inference
- **Cedar policy enforcement**: Actions classified as LOW/MEDIUM/HIGH risk. HIGH-risk actions require human approval
- **Idempotent operations**: Ticket generation and check-in are safe to retry without duplicate side effects
- **Tenant isolation**: Every DynamoDB query is scoped by `organization_id` (partition key)
- **Step Functions for async workflows**: Speaker follow-up and incident response use `waitForTaskToken` for human-in-the-loop approval

## Project Structure

```
communityops/
├── apps/web/              # React + TypeScript frontend
├── agents/                # Strands Agent definitions (6 agents)
├── services/
│   ├── api/               # Lambda API handlers (events, speakers, tasks, etc.)
│   ├── checkin/            # Check-in service (search, verify, recover, reconcile)
│   ├── shared/             # Models, DynamoDB repo, audit, validation, policy
│   └── workflows/          # Step Functions Lambda handlers
├── tools/                 # Agent tool implementations (registration, payment lookup)
├── workflows/             # Step Functions ASL definitions
├── policies/cedar/        # Cedar policy files + schema
├── knowledge/seed/        # Operational knowledge documents
├── tests/unit/            # Unit tests (87 tests)
├── scripts/               # Deploy, destroy, seed scripts
├── docs/                  # Architecture, data model, security, ADRs
└── template.yaml          # AWS SAM template
```

## Getting Started

### Prerequisites

- Python 3.12+
- Node.js 20+
- AWS CLI v2 configured
- AWS SAM CLI

### Local Development

```bash
# Install Python dependencies
pip install -e ".[dev]"

# Install frontend dependencies
npm install --prefix apps/web

# Run backend tests
pytest tests/unit/ -v

# Frontend checks
npm run typecheck --prefix apps/web
npm run lint --prefix apps/web
npm test --prefix apps/web
npm run build --prefix apps/web
```

### Frontend configuration

Copy `apps/web/.env.example` to `apps/web/.env.local` and fill it in.

To run the console against a deployed backend, set `VITE_API_URL`,
`VITE_COGNITO_USER_POOL_ID` and `VITE_COGNITO_CLIENT_ID` from the stack outputs.
The signed-in user must belong to the Cognito group matching `VITE_ORG_ID`, or
the API returns `403`.

For local UI work without a backend, set `VITE_USE_MOCK=true`. Mock data is
opt-in only and the console shows a "Demo Mode" badge while it is active. It is
never used as a fallback: if a real API is configured and fails, the console
surfaces the error instead of showing fabricated operational data.

### Deploy to AWS

```bash
./scripts/deploy.sh --stage dev
```

The script excludes `apps/web/node_modules` from the Lambda artifact while
building. Every function uses `CodeUri: .` so that `services`, `tools` and
`agents` resolve as top-level packages, and SAM's Python builder copies the
whole `CodeUri` tree with no exclude mechanism of its own.

`requirements.txt` exists solely for SAM's Python builder and lists the subset
of `pyproject.toml` dependencies the deployed handlers actually import.
`pyproject.toml` remains the authoritative dependency configuration.

### Seed demo data

```bash
python scripts/seed-demo.py --table CommunityOps-Main-dev --region ap-south-1
```

Each organization needs a Cognito group named after its organization ID, and
users must be added to the groups they may access:

```bash
aws cognito-idp create-group --user-pool-id <pool-id> \
    --group-name ORG-wemakedev --region ap-south-1
aws cognito-idp admin-add-user-to-group --user-pool-id <pool-id> \
    --username <email> --group-name ORG-wemakedev --region ap-south-1
```

### Validate against a deployed stack

```bash
python scripts/live-e2e-test.py \
    --api-url <api-url> --user-pool-id <pool-id> --client-id <client-id> \
    --username <email> --password-file <path>
```

This exercises the deployed API end to end: the check-in recovery path, its
edge cases, idempotency, QR signature verification, cross-tenant isolation and
the approval flow. It uses no mocks or local fixtures.

## Documentation

- [Architecture](docs/architecture.md)
- [Agent Architecture](docs/agent-architecture.md)
- [Data Model](docs/data-model.md)
- [Security](docs/security.md)
- [Architecture Decision Records](docs/decisions/)

## AI Tools Disclosure

- **Amazon Bedrock** (Claude Sonnet) — powers agent reasoning via Strands Agents SDK
- **Kiro** (AI development environment) — used during development for code generation, review, and debugging

## Known Limitations

- The QR signing key falls back to a hardcoded development value. It is not yet
  supplied to the Lambda functions from Secrets Manager, so QR signatures in the
  deployed dev stage are not backed by a managed secret.
- Cedar policy files define the authorization model, but risk classification is
  evaluated in Python at runtime rather than by a Cedar engine; production would
  use Amazon Verified Permissions.
- Organization membership is carried by Cognito groups, which must be
  provisioned per organization. There is no self-service organization onboarding.
- The agent definitions under `agents/` are not yet invoked by any deployed
  Lambda, so the Strands and Bedrock dependencies are deliberately excluded from
  the deployment artifact. Recommendations in the seeded data are rule-based.
- RAG/Knowledge Base integration is defined but not connected to Bedrock
  Knowledge Bases.
- The Step Functions state machines are deployed but have not been executed
  end to end against live data.
- The console is a single-event view scoped to one organization at a time.
- Lambda logs are plain text; the structured `extra` fields attached to log
  records are not emitted because no JSON formatter is configured.

## License

MIT — see [LICENSE](LICENSE)
