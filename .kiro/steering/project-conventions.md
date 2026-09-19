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
- Agent runtime: Bedrock Converse tool-use loop over a shared, framework-neutral tool
  registry. The Strands Agents SDK factories consume the same registry, so tools are
  defined once. Rationale in `.kiro/specs/community-operations-platform/design.md` D-1.
- Policy: Cedar files are the declarative specification; `services/shared/policy.py` is
  the runtime enforcement engine. A unit test binds them so they cannot drift.
- No LLM calls for deterministic lookups (registration exists? payment captured?)
- RAG is NOT implemented. Do not describe document search as retrieval-augmented.

## Roles and Authorization
- Two roles: `LEADER` (organization-wide operational authority) and `TEAM_MEMBER`
  (assigned events, own teams, own tasks).
- Role comes from Cognito groups. Groups prefixed `ORG-` are organization memberships;
  `LEADER` and `TEAM_MEMBER` are roles. Team membership is authoritative in DynamoDB.
- Every handler and every agent tool runs the same chain:
  `resolve_principal` → `authorize_organization` → `require_role` / `authorize_scope`
  → `evaluate_policy` → execute → `create_audit_event`.
- Fail closed. An unknown action is treated as HIGH risk and requires approval.
- Prompt content can never widen a principal's authorization.

## Money
- Budget amounts are integer rupees in DynamoDB Number attributes. Never floats.
- Budget invariants are enforced by conditional atomic `ADD` writes, never by
  read-modify-write.
- The backend computes authoritative financial state. The agent may only explain it.

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
- Policy action names: PascalCase verbs (CreateInternalTask, ApproveExpenditure)
- Audit actions: SCREAMING_SNAKE (TASK_CREATED, BUDGET_COMMITTED)
- Agent tool names: snake_case (get_budget, prepare_speaker_followup)

## DynamoDB Item Rules
- Every item carries `entity_type`. List queries filter on it because SK prefixes
  overlap.
- `PK = organization_id`. Event-scoped SKs start `EVENT#{eventId}#`; per-user data
  starts `USER#{userId}#` so it never collides with event listings.
- Any status embedded in an index sort key MUST be rewritten when the status changes.
  Prefer deriving volatile status (OVERDUE) at read time.

## Error Categories
Use explicit error types: VALIDATION_ERROR, NOT_FOUND, AMBIGUOUS_MATCH, UNAUTHORIZED, FORBIDDEN, EXTERNAL_SERVICE_ERROR, TIMEOUT, CONFLICT, DUPLICATE, POLICY_REQUIRES_APPROVAL, INTERNAL_ERROR

## Git
- Branch from `development`, PR into `development`
- Conventional commits: feat(), fix(), test(), docs()
- Never push directly to main
