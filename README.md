# OrbitOps — CommunityOps Agent

An AI Community Operations Agent that continuously coordinates event operations for community leaders and organizers, automating repetitive work while keeping consequential decisions under human control.

## What This Is

OrbitOps is an operational intelligence layer for community-led events. It helps organizers manage multiple events, teams, speakers, volunteers, attendees, registrations, logistics, deadlines, approvals, incidents, and communication — without chasing everyone manually.

**Core principle:** Deterministic systems establish facts. AI reasons about the facts. Policies control what the AI may do. Workflows execute the process. Humans approve consequential actions.

## Architecture

- **Frontend**: React + TypeScript (S3 + CloudFront)
- **Identity**: Amazon Cognito
- **API**: API Gateway + Lambda (Python 3.12)
- **Database**: DynamoDB
- **Events**: EventBridge
- **Workflows**: Step Functions
- **AI Agents**: Strands Agents SDK + Amazon Bedrock
- **Policy**: Cedar
- **Infrastructure**: AWS SAM + CloudFormation

## Agent System

| Agent | Responsibility |
|-------|---------------|
| **Supervisor** | Routes operational intent, coordinates specialists, requests human approval |
| **CheckInOps** | Ticket recovery, registration lookup, payment reconciliation, check-in flow |
| **SpeakerOps** | Speaker outreach, follow-ups, availability tracking, requirements collection |
| **TeamOps** | Task decomposition, assignment, deadlines, escalation, dependency tracking |
| **AttendeeOps** | Missing information, dietary/accommodation requirements, communication |
| **IncidentOps** | Risk detection, context analysis, backup options, incident resolution |

## Key Workflows

- **Smart Ticket Recovery**: Attendee can't show ticket → registration lookup → payment reconciliation → ticket regeneration → QR verification → check-in
- **Speaker Follow-up**: Invite → wait → follow-up → policy check → approval if needed → send → extract response → update state
- **Incident Response**: Detect risk → analyze context → identify backups → recommend action → human approval → execute → audit

## Project Structure

```
orbitops/
├── apps/web/              # React frontend
├── services/              # Lambda handlers (API, checkin, tickets, etc.)
├── agents/                # Strands agent definitions
├── tools/                 # Agent tool implementations
├── workflows/             # Step Functions definitions
├── policies/cedar/        # Cedar policy files
├── knowledge/seed/        # RAG seed documents
├── infrastructure/sam/    # SAM template resources
├── scripts/               # Deploy, destroy, seed scripts
├── tests/                 # Unit, integration, workflow, agent, security
└── docs/                  # Architecture, data model, security, ADRs
```

## Getting Started

### Prerequisites

- Python 3.12+
- Node.js 20+
- AWS CLI v2 configured
- AWS SAM CLI

### Local Development

```bash
# Install dependencies
pip install -r requirements.txt
npm install --prefix apps/web

# Run frontend dev server
npm run dev --prefix apps/web

# Run tests
pytest tests/
npm test --prefix apps/web
```

### Deploy

```bash
./scripts/deploy.sh --stage dev
```

### Destroy

```bash
./scripts/destroy.sh --stage dev
```

## Documentation

- [Architecture](docs/architecture.md)
- [Agent Architecture](docs/agent-architecture.md)
- [Data Model](docs/data-model.md)
- [Security](docs/security.md)
- [Deployment](docs/deployment.md)
- [Development Guide](docs/development.md)
- [Testing](docs/testing.md)
- [Integrations](docs/integrations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture Decision Records](docs/decisions/)

## License

MIT — see [LICENSE](LICENSE)
