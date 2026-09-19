# CommunityOps Project Conventions

## Product Identity
- Product: **CommunityOps Agent**
- Mission: AI Community Operations Agent that automates repetitive operational work for community organizers while keeping consequential decisions under human control.

## Fundamental Principles
1. **Deterministic systems establish facts** — transactional truth comes from databases/APIs, never LLMs
2. **AI reasons about facts** — agents analyze operational state and recommend actions
3. **Policies control authority** — Cedar policies define what agents may do
4. **Workflows execute process** — Step Functions orchestrate multi-step operations
5. **Humans approve consequential actions** — financial, irreversible, and high-risk actions require approval

## Architecture Rules
- AWS-native: Cognito, API Gateway, Lambda, DynamoDB, S3, EventBridge, Step Functions, Bedrock
- Infrastructure as code: AWS SAM + CloudFormation
- Agent framework: Strands Agents SDK with Amazon Bedrock
- Policy engine: Cedar
- No LLM calls for deterministic lookups (registration exists? payment captured?)
- RAG for knowledge/policies only, never for transactional truth

## Code Standards

### Python (backend services, agents, tools)
- Python 3.12+
- Type hints on all functions
- Pydantic for validation at boundaries
- Ruff for linting/formatting
- pytest for testing
- Structured logging with request context

### TypeScript (frontend)
- Strict mode
- Typed interfaces for all API contracts
- React with TypeScript
- Vite for build
- Vitest for testing

## Naming Conventions
- Domain entities: PascalCase (Registration, PaymentReference, RecoveryCase)
- Python functions/variables: snake_case
- TypeScript functions/variables: camelCase
- API routes: kebab-case (/check-in/recovery)
- DynamoDB tables: PascalCase prefix (CommunityOps-{Entity}-{Stage})
- Lambda functions: communityops-{service}-{action}-{stage}
- Event types: PascalCase (RegistrationCreated, TicketRecovered)

## Error Categories
Use explicit error types: VALIDATION_ERROR, NOT_FOUND, AMBIGUOUS_MATCH, UNAUTHORIZED, FORBIDDEN, EXTERNAL_SERVICE_ERROR, TIMEOUT, CONFLICT, DUPLICATE, POLICY_REQUIRES_APPROVAL, INTERNAL_ERROR

## Git
- Branch from `development`, PR into `development`
- Conventional commits: feat(), fix(), test(), docs()
- Never push directly to main
