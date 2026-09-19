# CommunityOps — Implementation Tasks

Dependency-ordered. Each task is done when its verification passes.

## Phase 2 — Domain and data primitives

- [ ] 2.1 Add models: `TeamMember`, `Budget`, `BudgetAllocation`, `Expense`,
  `IncidentComment`, `Document`, `Notification`, `AgentActivity`, `ChatTurn`.
  Extend `Event`, `Task`, `Speaker`, `Incident`, `Approval`. Export all from
  `models/__init__.py`.
  *Verify:* `tests/unit/test_models.py` constructs each and rejects bad input.
- [ ] 2.2 Extend `DynamoDBRepository`: `atomic_update` (`ADD` + condition),
  `query_page` (cursor), `batch_put`, `transact_write`.
  *Verify:* repository tests with moto cover counter increment, conditional failure,
  and cursor round-trip.
- [ ] 2.3 Add `GSI2` to `MainTable` in `template.yaml`.
  *Verify:* `sam validate --lint`.
- [ ] 2.4 Add ID patterns and validators for member, budget, expense, comment,
  document, notification.
  *Verify:* validation tests.

## Phase 3 — Principal, scope, policy

- [ ] 3.1 `Principal` dataclass + `resolve_principal`, `require_role`,
  `authorize_scope` in `services/shared/principal.py`; keep
  `tenancy.authorize_organization` as-is and compose with it.
- [ ] 3.2 Expand `ACTION_RISK_LEVELS` with the FR-20 catalogue, add
  `NEVER_AUTONOMOUS`, add resource scope to `evaluate_policy`.
- [ ] 3.3 Update `policies/cedar/communityops.cedar` and the schema to match, and add
  `tests/unit/test_policy_consistency.py` asserting the three artefacts agree.
  *Verify:* consistency test fails if any action is added to only one place.

## Phase 4 — Services and handlers

- [ ] 4.1 `services/shared/aggregate.py` — `load_event_snapshot`, one query per family.
- [ ] 4.2 `services/shared/health.py` — deterministic score, band, reasons.
- [ ] 4.3 `services/shared/budget_service.py` — allocate, commit, spend, release,
  summarize; all atomic and conditional.
- [ ] 4.4 `services/shared/notify.py` — create notifications.
- [ ] 4.5 Handlers: `teams_handler`, `members_handler`, `budget_handler`,
  `documents_handler`, `notifications_handler`, `health_handler`, `brief_handler`,
  `simulation_handler`, `tickets_admin_handler`; extend `incidents_handler` with
  comments/acknowledge/resolve/reopen, `tasks_handler` with event-wide listing and
  scope checks, `events_handler` with archive/duplicate/lifecycle,
  `approvals_handler` with the budget hook and `GSI1SK` rewrite,
  `speakers_handler` with follow-up preparation, `command_center_handler` to use the
  snapshot.
- [ ] 4.6 Wire every function and route in `template.yaml` with least-privilege IAM.
  *Verify:* handler tests per route; `sam validate --lint`.

## Phase 5 — Agent tools

- [ ] 5.1 `tools/registry.py` — `ToolSpec`, registry, JSON schema generation,
  `invoke` with validation → scope → policy → execute → audit.
- [ ] 5.2 Implement the read tools.
- [ ] 5.3 Implement the auto-authorized write tools.
- [ ] 5.4 Implement the approval-gated write tools so they create an `Approval` and
  report it rather than acting.
  *Verify:* tool authorization tests, including a `TEAM_MEMBER` denied a leader tool
  and an approval-gated tool that mutates nothing.

## Phase 6 — Agent runtime and chat

- [ ] 6.1 `agents/runtime.py` — Converse tool-use loop, bounded turns, system prompt
  assembly, Fun Mode, PII minimization.
- [ ] 6.2 Rewire the six Strands factories onto the shared registry.
- [ ] 6.3 `services/api/agent_handler.py` — `POST /agent/chat`, `GET /agent/activity`.
- [ ] 6.4 Bedrock IAM, timeout and memory in `template.yaml`.
  *Verify:* runtime tests with a stubbed Bedrock client; live invocation after deploy.

## Phase 7 — Demo data

- [ ] 7.1 Rewrite `scripts/seed-demo.py` for AWS Community Day Maharashtra 2026 with
  the FR-25 story. Keep it idempotent and reproducible.
  *Verify:* seeding twice leaves the same item count; health computes to ORANGE.

## Phase 8 — Frontend

- [ ] 8.1 Restructure `App.tsx`: public routes, route guard, role-based nav.
- [ ] 8.2 `auth.getRole()`, `types.ts` additions, `api.ts` additions.
- [ ] 8.3 Landing page.
- [ ] 8.4 Leader screens.
- [ ] 8.5 Team screens.
- [ ] 8.6 `AgentChat` component.
- [ ] 8.7 CSS additions: chat, budget bars, tabs, discussion thread, progress.
- [ ] 8.8 Add `jsdom` + `@testing-library/react` and a Vitest environment block.
  *Verify:* `npm run typecheck`, `npm run lint`, `npm test`.

## Phase 9 — Demo identities

- [ ] 9.1 `scripts/setup-demo-users.py` — create the Cognito groups and the three demo
  identities, passwords from environment or generated and printed once, never
  committed.
  *Verify:* each identity signs in and receives the expected role and scope.

## Phase 10 — Verification

- [ ] 10.1 Full backend suite.
- [ ] 10.2 Full frontend suite.
- [ ] 10.3 `ruff check`, `ruff format --check`, `mypy`.
- [ ] 10.4 `sam validate --lint`, `sam build`.
- [ ] 10.5 Deploy, seed, create users, upload console.
- [ ] 10.6 Live verification of real resources and the deployed API; classify every
  result as LIVE AWS VERIFIED / LOCAL VERIFIED / CODE VERIFIED / NOT VERIFIED / FAILED.

## Phase 11 — Documentation

- [ ] 11.1 README and `docs/` updated to describe only implemented behaviour.
- [ ] 11.2 `faced-challenged.md` written and git-ignored.
- [ ] 11.3 Commits grouped by concern.
