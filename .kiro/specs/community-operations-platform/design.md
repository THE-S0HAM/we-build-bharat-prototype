# CommunityOps — Community Operations Platform Design

This design extends the existing implementation. It adds no parallel architecture and
replaces no working component.

## 1. What already exists and is kept

| Component | State | Action |
|---|---|---|
| SAM template, single REST API, Cognito authorizer | working | extend with new functions and routes |
| `MainTable` / `AuditTable` single-table design, one `GSI1` | working | reuse, add SK prefixes and a second GSI |
| `DynamoDBRepository` | working | extend with atomic `ADD`, conditional writes, pagination, batch write |
| `tenancy.authorize_organization` | working | keep; add `Principal` resolution on top |
| `audit.create_audit_event` | working | reuse unchanged for every new mutation |
| `api_response.success` / `error` + `ErrorCategory` | working | reuse |
| `policy.evaluate_policy` risk tiers, fail-closed | working | expand action catalogue, add resource scope |
| Check-in recovery, ticket service, HMAC QR | working | reuse; add admin verify/revoke on top |
| Speaker follow-up + incident response state machines | defined, never started | wire an entry point |
| React console, design tokens, Cognito SRP sign-in | working | extend, do not rewrite |
| Cedar policy files | specification, not the runtime engine | keep as specification, add a test that binds them to the code |

## 2. Decisions

### D-1 Agent runtime: boto3 Bedrock Converse tool-use loop, Strands-compatible

The six `agents/*/agent.py` factories construct a Strands `Agent` but nothing calls them,
and `requirements.txt` deliberately excludes `strands-agents` because `CodeUri: .` copies
the whole dependency tree into all fourteen functions (measured at 86 MB previously).

Decision: implement the runtime as a thin Bedrock **Converse** tool-use loop
(`agents/runtime.py`) using `boto3`, which is already in the Lambda runtime, so the
deployed artifact gains no weight. The tool registry is framework-neutral: each tool
exposes a JSON schema plus a Python callable, which is exactly what both Converse
`toolConfig` and Strands tool specs need. The Strands factories are rewired to consume
the same registry, so they stop being fiction and become an alternative front end for
identical tools when the dependency is installed locally.

Consequence: the operations chat works on AWS today, and the Strands path is a real,
tested adapter rather than a claim.

### D-2 Cedar is the specification; `policy.py` is the enforcement engine

`policies/cedar/communityops.cedar` and `ACTION_RISK_LEVELS` had drifted: four actions
existed in one and not the other. Introducing `cedarpy` at runtime reintroduces the
bundle problem and gives a second authorization model.

Decision: `policy.py` stays the single runtime authority. The Cedar files are maintained
as the declarative specification and a unit test parses the `.cedar` file and the schema
and asserts they enumerate exactly the actions the code knows, with matching risk tiers.
Drift becomes a test failure instead of a silent divergence.

### D-3 Money is integer rupees

`PaymentReference.amount` is a string today. Budget arithmetic must be exact and
comparable. All budget fields are DynamoDB Numbers holding whole rupees, read back as
`Decimal` and coerced to `int` at the boundary. No floats anywhere in the money path.
The existing `PaymentReference.amount` string is left untouched to avoid a migration.

### D-4 Budget invariants use optimistic concurrency, not a conditional `ADD`

The intended design was an atomic `ADD` guarded by
`ConditionExpression: allocated + :amount <= total_budget`. That is not implementable:
DynamoDB condition expressions compare attribute paths and values and have no arithmetic,
so a sum cannot appear on the left-hand side.

Pre-computing the ceiling in the caller and conditioning on `allocated <= :ceiling` looks
race-safe but is not. Conditions evaluate against the item's pre-update state, so two
concurrent `+40,000` writes against a 50,000 budget both observe `allocated = 0`, both
satisfy `0 <= 10,000`, and both apply. The budget reaches 80,000 and nothing errors.

Implemented instead: `budget_service` reads the counters, computes the new values, and
writes them conditional on the counters still being exactly what was read. A concurrent
change fails the condition and the operation recomputes against fresh state, bounded by
`MAX_WRITE_ATTEMPTS`. One writer wins, the other retries, neither overwrites blindly.

Event budget and category allocation move together in a single `TransactWriteItems` call,
because a budget whose categories do not sum to its totals is worse than a rejected write.

`DynamoDBRepository.atomic_update` was still added and is used for genuine counters that
carry no cross-attribute invariant, such as `Team.member_count` and
`Incident.comment_count`, where `ADD` is both correct and cheaper than a read.

### D-5 Derived status is computed, not stored in the index key

`GSI1SK` currently embeds the status at creation time and is never rewritten, so
`begins_with("APPROVAL#PENDING")` returns decided approvals. Two fixes:
status transitions rewrite `GSI1SK`, and a second index `GSI2` keyed
`GSI2PK = {org}#{event}#{ENTITY}` / `GSI2SK = {STATUS}#{due_or_created}` gives correct
status and deadline ordering. `OVERDUE` stays derived from `due_date` at read time so it
can never go stale.

### D-6 Role from Cognito groups, scope from DynamoDB

Group names starting `ORG-` are organization memberships; `LEADER` and `TEAM_MEMBER` are
roles. Team membership is authoritative in DynamoDB (`TeamMember` records), not in the
token, because it changes often and the token is cached. `resolve_principal` reads the
claims and, for a team member, loads their memberships once per request.

### D-7 One aggregation read per entity family

The command centre currently issues a query per entity per event. The new
`services/shared/aggregate.py` loads an event's operational state with one `GSI1` query
per family (tasks, speakers, incidents, approvals, teams, members, budget) and derives
every count in memory. Event health, the operations brief, the command centre and the
agent's read tools all consume that one snapshot.

## 3. Data model additions

Partition key stays `PK = organization_id`. Every item carries `entity_type`.

| Entity | SK | GSI1PK / GSI1SK | GSI2PK / GSI2SK |
|---|---|---|---|
| `TeamMember` | `EVENT#{e}#TEAM#{team}#MEMBER#{userId}` | `{org}#{e}` / `MEMBER#{team}#{userId}` | `{org}#USER#{userId}` / `MEMBER#{e}#{team}` |
| `Budget` | `EVENT#{e}#BUDGET` | `{org}#{e}` / `BUDGET` | — |
| `BudgetAllocation` | `EVENT#{e}#BUDGET#CATEGORY#{category}` | `{org}#{e}` / `BUDGETCAT#{category}` | — |
| `Expense` | `EVENT#{e}#EXPENSE#{expenseId}` | `{org}#{e}` / `EXPENSE#{ts}` | `{org}#{e}#EXPENSE` / `{category}#{ts}` |
| `IncidentComment` | `EVENT#{e}#INCIDENT#{inc}#COMMENT#{cid}` | `{org}#{e}` / `COMMENT#{inc}#{ts}` | — |
| `Document` | `EVENT#{e}#DOC#{docId}` | `{org}#{e}` / `DOC#{category}#{ts}` | — |
| `Notification` | `USER#{userId}#NOTIFICATION#{nid}` | `{org}#USER#{userId}` / `NOTIF#{ts}` | — |
| `AgentActivity` | `EVENT#{e}#AGENTACT#{ts}#{actId}` | `{org}#{e}` / `AGENTACT#{ts}` | — |
| `ChatTurn` | `USER#{userId}#CHAT#{sessionId}#{seq}` | `{org}#USER#{userId}` / `CHAT#{sessionId}` | — |

`Notification` and `ChatTurn` deliberately use a `USER#` SK prefix so a user's own data
is one query and never collides with the `EVENT#` prefix scan used for event listings.

`Event` gains `total_budget`, `registration_target`, `risk_status`, `health_score`,
`health_band`, `health_reasons`, `paused_at`, `archived_at`.

`Task` gains `risk`, `estimated_effort_hours`, `source_comment_id`, `assigned_team_id`,
and its status enum widens to include `BACKLOG`, `ASSIGNED`, `REVIEW`.

`Speaker` gains `travel_origin`, `accommodation_nights`, `estimated_travel_cost`,
`estimated_accommodation_cost`, `session_time`, `availability_confirmed`,
`last_response_at`.

`Incident` gains `category`, `reported_by_role`, `assigned_to`, `acknowledged_at`,
`root_cause`, `actions_taken`, `comment_count`, `reopened_count`.

`Approval` gains `amount_inr`, `budget_category`, `requested_by`, `requested_by_role`,
`budget_impact`.

## 4. Authorization design

```
API Gateway (Cognito authorizer)
        ↓  claims
resolve_principal(event) -> Principal
        │   user_id, email, role, organizations, team_ids (loaded for TEAM_MEMBER)
        ↓
authorize_organization   — tenant boundary, fail closed
        ↓
require_role(LEADER)     — leader-only routes
        ↓
authorize_scope(...)      — team member limited to their events/teams/tasks
        ↓
evaluate_policy(action, principal, resource) — risk tier, approval requirement
        ↓
handler / tool executes, then create_audit_event
```

Agent tools receive the same `Principal` and run the same four checks. The tool registry
exposes to the model only the tools the principal may call, so an injected prompt asking
for a leader-only tool finds no such tool, and calling it directly still fails the check.

## 5. Agent architecture

```
POST /agent/chat  (Cognito authorized)
        ↓
resolve_principal → allowed tool set for this role
        ↓
agents/runtime.py: Bedrock Converse loop
        │  system prompt (role, event context, fun mode, hard rules)
        │  toolConfig = JSON schemas of allowed tools
        ↓
  model requests a tool
        ↓
  ToolRegistry.invoke(name, args, principal)
        │  1. schema validation
        │  2. principal scope check
        │  3. evaluate_policy → ALLOW | REQUIRES_APPROVAL | DENY
        │  4. execute against DynamoDB (deterministic)
        │  5. create_audit_event
        ↓
  tool result returned to the model
        ↓
  loop, bounded by max turns
        ↓
  final text + structured actions + approvals created + tools used
```

A `REQUIRES_APPROVAL` tool result is not an error: the tool creates the `Approval`
record and tells the model an approval is pending, so the model reports that truthfully
instead of claiming the action was done.

### Tool catalogue

Read: `get_event`, `list_events`, `get_team`, `list_teams`, `get_team_workload`,
`list_tasks`, `get_task`, `get_speakers`, `get_speaker`, `get_attendee_summary`,
`get_ticket`, `list_approvals`, `get_approval`, `list_incidents`, `get_incident`,
`get_incident_comments`, `get_budget`, `get_budget_utilization`,
`calculate_remaining_budget`, `get_event_risk`, `generate_event_brief`,
`search_event_documents`, `list_notifications`.

Write, auto-authorized in scope: `create_event`, `update_event`, `create_team`,
`update_team`, `assign_team_member`, `create_task`, `update_task`, `assign_task`,
`complete_task`, `add_incident_comment`, `create_incident`, `update_incident`.

Write, approval-gated: `reassign_task` (cross-team), `prepare_speaker_followup`,
`update_speaker`, `request_approval`, `approve_action`, `reject_action`,
`create_budget_allocation`, `record_expense`, `resolve_incident`, `generate_ticket`.

Each tool is a `ToolSpec(name, description, risk_action, schema, handler, roles)`.
`roles` gates visibility; `risk_action` maps to the policy catalogue.

## 6. Event health engine

`services/shared/health.py`, pure function of an `EventSnapshot`:

| Signal | Weight |
|---|---|
| overdue task | 6 each, capped 30 |
| blocked task | 4 each, capped 16 |
| unresolved incident | CRITICAL 30, HIGH 18, MEDIUM 8, LOW 3 |
| speaker pending > 72 h | 10 each, capped 20 |
| approval pending > 24 h | 5 each, capped 15 |
| budget utilization > 90 % | 12; > 75 % | 6 |
| event starts within 24 h with open critical work | 10 |
| attendee data > 10 % incomplete | 6 |

Score is the sum, clamped to 100. Bands: `0-14 GREEN`, `15-34 YELLOW`,
`35-59 ORANGE`, `60+ RED`. The function returns the band, the score and the ordered
reasons with their contributions, so the explanation is generated from the same data
that produced the number.

## 7. Approval to budget flow

```
Approval (PENDING, amount_inr, budget_category)
        ↓ leader approves
approvals_handler._decide_approval
        ↓ status → APPROVED, GSI1SK rewritten
        ↓ if amount_inr > 0:
budget_service.commit(org, event, category, amount)
        │  atomic ADD committed +amt on Budget and BudgetAllocation
        │  condition: committed + spent + amt <= allocated
        ↓ recompute remaining = total - spent - committed  (derived, never stored stale)
        ↓ create_audit_event BUDGET_COMMITTED
        ↓ notification to requester
```

Recording an expense moves committed → spent with the mirror-image atomic update. If the
conditional check fails, the approval decision is rejected with `CONFLICT` and no partial
state is written, because the budget mutation happens before the approval status commit.

## 8. Simulation

`services/api/simulation_handler.py` runs an ordered list of deterministic steps, each a
real mutation through the same services a human would use, each returning a description
plus the audit id it produced. The console plays them back with the observed state after
each step. It is idempotent per run id and only touches the demo event.

## 9. Frontend structure

```
App
├── public routes (no session required)
│   ├── /            Landing  — hero, proposition, Try / Sign In / Explore Demo
│   └── /login       Login
└── guarded routes
    ├── LEADER       /app/*     command centre, events, teams, tasks, speakers,
    │                           attendees, tickets, approvals, incidents, budget,
    │                           agent, documents, audit, simulation, settings
    └── TEAM_MEMBER  /team/*    workspace, my team, my tasks, incidents,
                                requests, notifications, agent, event info
```

`App.tsx` is restructured so the router renders first and the session gate becomes a
route guard, because today the gate returns before `<Routes>` and a public landing page
is unreachable. Role comes from `auth.getRole()`, following the existing
`getMemberOrganizations()` JWT-decode pattern. `AgentChat` is a shared component mounted
prominently in both panels and scoped by the caller's role server-side.

New CSS follows the existing token system; every new status gets a `--color-x` token and
a matching `.badge-x` rule because class names are string-interpolated.

Component tests require `jsdom` and `@testing-library/react`, which are not installed
today, so they are added along with a `test` block in the Vite config.

## 10. Testing strategy

| Layer | Coverage |
|---|---|
| models | new entities validate and reject bad input |
| repository | atomic add, conditional failure, pagination cursor, batch write (moto) |
| principal/policy | role derivation, scope checks, action catalogue, Cedar/code consistency, fail-closed unknown action |
| handlers | happy path, validation, tenant isolation, role rejection, idempotency, audit emission |
| budget | allocation invariant, commit, expense, remaining arithmetic, over-allocation conflict |
| health | band boundaries, reason attribution, determinism |
| agent | tool visibility per role, authorization rejection, approval-gated tool creates an approval instead of acting, injected prompt cannot widen scope, Converse loop with a stubbed client |
| frontend | api client contract, role routing, leader vs team nav, agent chat send/receive, budget rendering, incident discussion |

## 11. Deployment

Stack `CommunityOps`, region `ap-south-1`, account `838814606498`, `Stage=dev`.
`samconfig.toml` already targets that stack; `scripts/deploy.sh` passes a different
`--stack-name`, which is reconciled so both paths deploy the same stack.

The agent function needs `bedrock:InvokeModel` on the configured model, which no function
has today, and a longer timeout than the 30 s default. `QR_SECRET_KEY` is currently read
by the ticket service but never set in the template, so it silently uses a development
default; it is wired through the template.
