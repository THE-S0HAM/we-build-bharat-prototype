# Requirements Document

## Introduction

Requirements for the production frontend of CommunityOps, derived from
`design.md`. The backend, API contracts, authorization model and infrastructure
are given. Every criterion below is satisfiable by frontend work in `apps/web`,
except where a backend prerequisite is named — in those cases the criterion
specifies the honest degraded behaviour that ships instead.

Ambiguity references (A1–A18) point at `design.md` §4. Criterion numbers are
stable: `design.md` correctness properties reference them as
`Requirements X.Y`.

## Glossary

- **Console**: the CommunityOps single-page application in `apps/web`, taken as a whole.
- **Login_View**: the `/login` route, including the email/password form, provider block and demo action.
- **Session_Gate**: the `RequireSession` route wrapper that resolves session state before a protected route renders.
- **API_Client**: `src/api.ts` — the single typed HTTP client, its `ApiError` contract and its mock gating.
- **App_Shell**: the shared authenticated frame — navigation, top bar, content column, page padding, skip link, single `<main>`.
- **Sidebar**: the grouped navigation and account block inside App_Shell.
- **Topbar**: the global context strip inside App_Shell — event switcher, demo chip, sign-out.
- **Event_Context**: the provider that resolves, persists and publishes the active event.
- **Command_Center**, **Approvals_View**, **SpeakerOps_View**, **TeamOps_View**, **AttendeeOps_View**, **IncidentOps_View**, **Checkin_View**, **Audit_View**: the page components for `/`, `/approvals`, `/speakers`, `/teams`, `/attendees`, `/incidents`, `/checkin`, `/audit`.
- **Design_System**: `src/styles/tokens.css` plus the shared component set defined in `design.md` §7.
- **Drawer**: the single right-side progressive-disclosure panel component.
- **Status_Badge**: the only component permitted to map a status value to a colour.
- **Live_Smoke_Check**: `apps/web/scripts/live-smoke.mjs`, run against a deployed stack.
- **Watched event**: an event present in `events[]` from `GET /command-center` — ACTIVE or PUBLISHED only.
- **Handled / Needs your decision / Cannot be automated**: the three operational states in `design.md` §1.1.
- **Demo session**: a session authenticated as the preconfigured demo identity, scoped to the demo organization by its `cognito:groups` claim.
- **Capability flag**: a build-time configuration value that determines whether a route and its nav entry exist.

## Requirements

### Requirement 1: Authentication

**User Story:** As a community leader, I want to sign in with my email and password and stay signed in, so that I can reach my operation without re-authenticating or being exposed to someone else's data.

#### Acceptance Criteria

1. WHEN a user submits a valid email and password on the Login_View, THE Console SHALL authenticate through the Cognito SRP flow and navigate to the intended route, defaulting to the Command Center.
2. IF the user pool rejects the submitted credentials, THEN THE Login_View SHALL display "We couldn't sign you in. Check your email and password.", retain the entered email, and re-enable the form.
3. WHEN the browser reloads with a valid Cognito session present, THE Session_Gate SHALL restore the session and render the requested protected route.
4. WHILE session state is unresolved, THE Session_Gate SHALL render the App_Shell skeleton in place of protected page content.
5. WHEN an unauthenticated visitor requests a protected route, THE Session_Gate SHALL navigate to `/login` and retain the requested route for navigation after sign-in.
6. WHEN a user activates sign-out, THE Console SHALL clear session state and navigate to `/login`.
7. THE API_Client SHALL attach a non-expired Cognito ID token in the `Authorization` header of every request it issues to the API.
8. IF an API response carries category `UNAUTHORIZED` with status 401, THEN THE Console SHALL navigate to `/login`, retain the intended route, and present no error notification.
9. IF an API response carries category `FORBIDDEN` with status 403, THEN THE Console SHALL display "You don't have access to this organization's data." and issue no retry.
10. WHERE `VITE_AUTH_PROVIDERS` names one or more providers, THE Login_View SHALL render one button per named provider and start the Cognito hosted-UI authorization-code redirect when a provider button is activated.
11. IF `VITE_AUTH_PROVIDERS` is empty or absent, THEN THE Login_View SHALL omit the provider block and its divider from the DOM, leaving the email/password form as the complete sign-in surface (A1).
12. THE Console SHALL derive the set of selectable organizations from the ID token's `cognito:groups` claim.

### Requirement 2: Demo access

**User Story:** As a first-time visitor or judge, I want a one-click way into a populated CommunityOps workspace, so that I can evaluate the product without credentials and without touching a real organization's data.

#### Acceptance Criteria

1. WHERE `VITE_DEMO_USERNAME` and `VITE_DEMO_PASSWORD` are both configured, THE Login_View SHALL render a "Try Demo Account" action within the initial viewport of the login screen, reachable without scrolling.
2. IF either demo configuration value is absent, THEN THE Login_View SHALL omit the "Try Demo Account" action from the DOM (A18).
3. WHEN a visitor activates "Try Demo Account", THE Console SHALL authenticate the demo identity through the same Cognito SRP call the Login_View form uses.
4. WHILE demo authentication and the first Command Center load are in flight, THE Console SHALL display "Preparing your demo workspace…".
5. WHEN demo authentication and the first data load both succeed, THE Console SHALL render the Command Center.
6. IF demo authentication or the first data load fails, THEN THE Console SHALL display "Demo access is temporarily unavailable." with a "Try again" action, and the displayed text SHALL contain only that copy.
7. WHILE a demo session is active, THE API_Client SHALL send as `organization_id` only the demo organization derived from the token's `cognito:groups` claim.
8. WHILE a demo session is active, THE Topbar SHALL render a "Demo workspace" chip that is visually and semantically distinct from the `VITE_USE_MOCK` "Demo Mode" badge.
9. WHEN a demo user activates sign-out, THE Console SHALL clear session state and navigate to `/login` through the same path any other session uses.
10. THE Console SHALL read demo credentials from build-time or runtime configuration, and the repository SHALL carry placeholder values only in `.env.example`.
11. THE Console SHALL serve a demo session with the same App_Shell, navigation and page components a standard session receives.

### Requirement 3: Application shell and event context

**User Story:** As a community leader, I want one consistent frame with honest identity and event context, so that I always know which product I am in, which organization I am acting for, and which event I am looking at.

#### Acceptance Criteria

1. THE App_Shell SHALL render "CommunityOps" as the product name in the wordmark, document title, document metadata and all user-facing copy, and SHALL render no other product name.
2. THE Sidebar SHALL render navigation as Command Center, then group OPERATIONS with SpeakerOps, TeamOps, AttendeeOps and IncidentOps, then group EVENT DAY with Check-In, then group GOVERNANCE with Approvals and Audit Log.
3. WHEN a route is active, THE Sidebar SHALL mark that entry with the active treatment and `aria-current="page"`.
4. WHERE `summary.pending_approvals` from `GET /command-center` is greater than zero, THE Sidebar SHALL render that count as a badge on the Approvals entry.
5. IF the AttendeeOps capability flag is off, THEN THE Sidebar SHALL omit the AttendeeOps entry from the DOM (A6).
6. THE Sidebar account block SHALL display the `name` claim, the `email` claim and the active organization identifier, and SHALL display no other identity attribute (A2).
7. WHEN the authenticated Console mounts, THE Event_Context SHALL resolve the active event from `GET /events` using this order: event named in the URL, stored preference, first ACTIVE event, first event by start date (A16).
8. WHEN the active event changes, THE Event_Context SHALL write the selection to `localStorage` keyed by the Cognito `sub` claim and reflect the event in the URL.
9. IF an event named in the URL or in stored preference is absent from the response of `GET /events`, THEN THE Event_Context SHALL fall through to the next resolution source.
10. IF `GET /events` returns zero events, THEN THE App_Shell SHALL render the no-events state and disable the event-scoped navigation entries.
11. THE Topbar SHALL be the only surface that renders the event switcher, the demo-workspace chip and sign-out.

### Requirement 4: Command Center

**User Story:** As a community leader, I want to know in five seconds whether anything is waiting on me, so that I can act on the one thing that matters instead of reading a dashboard.

#### Acceptance Criteria

1. THE Command_Center SHALL render, in order, a greeting carrying the `name` claim and the active organization, at most one decision surface, one contextual visual, and the handled strip.
2. THE Command_Center SHALL derive its headline watched-event count from `summary.active_events`, and WHERE `summary.total_events` is also shown, THE Command_Center SHALL label it "of N total" (A13).
3. WHEN at least one pending approval exists across watched events, THE Command_Center SHALL render the oldest as a single decision surface carrying Approve, Edit and Decline actions.
4. THE Command_Center SHALL compose its one contextual visual from `events[]` returned by `GET /command-center`, with one node per watched event whose treatment is driven by that event's `pending_approvals`, `critical_incidents`, `overdue_tasks` and `blocked_tasks`.
5. WHEN a user selects a node in the contextual visual, THE Event_Context SHALL set the active event to that node's event.
6. THE Command_Center SHALL build the handled strip from `GET /events/{eventId}/audit` for the active event, filtered to agent actors (A12).
7. WHERE the org-wide `recent_actions` feed is rendered, THE Command_Center SHALL label it as organization-wide.
8. WHEN no pending approval, critical incident or overdue task exists across watched events, THE Command_Center SHALL render "Abhi koi drama nahi." with "CommunityOps is keeping things moving." and the handled strip.
9. THE Command_Center SHALL present the agent's reasoning for the decision surface only behind a "Why this action?" affordance that opens the Drawer.
10. THE Command_Center SHALL limit its summary metrics to the greeting context line and the contextual visual.
11. THE Command_Center SHALL answer "Is anything waiting on me right now?" within the initial viewport at `--bp-lg`, using either one decision surface or one calm sentence.

### Requirement 5: Approvals

**User Story:** As a community leader, I want a queue of only the decisions that need me, with the consequence of each stated plainly, so that I can approve, adjust or decline with confidence and an audit trail.

#### Acceptance Criteria

1. THE Approvals_View SHALL render a pending-only queue from `GET /events/{eventId}/approvals`, ordered oldest first (A3).
2. THE Approvals_View SHALL render each queue item with the requested action, the agent's reason, the risk level, the consequence line and the available actions.
3. WHEN a user activates Approve, THE Approvals_View SHALL issue exactly one `PUT /events/{eventId}/approvals/{approvalId}` with `decision="APPROVED"` and lock that item's controls until the response resolves.
4. WHEN a user activates Decline, THE Approvals_View SHALL require a note, submit `decision="DECLINED"` with that note, and state that the note is recorded in the audit trail.
5. WHEN a user activates Edit, THE Approvals_View SHALL present one labelled multi-line field pre-filled with `requested_action`, display the original action immediately above it, and submit `decision="EDITED"` with the field value as `edited_action` (A4).
6. IF a decision request returns status 409, THEN THE Approvals_View SHALL replace that item with "This was already decided elsewhere." and refetch the queue.
7. WHEN a decision is recorded, THE Approvals_View SHALL display "Decision recorded." together with the concrete outcome, stated as "CommunityOps will proceed with this action." or "CommunityOps will not send this follow-up." (A9).
8. THE Approvals_View SHALL attribute a prepared action as "CommunityOps prepared this action" and attribute the decision to the user.
9. THE Approvals_View SHALL render approval `evidence` as labelled rows for recognised keys and as a single count for unrecognised keys (A11).
10. WHERE approval `evidence` carries a recognised amount field, THE Approvals_View SHALL render a financial consequence line from that value (A10).
11. WHILE decisions have been recorded in the current session, THE Approvals_View SHALL render a recently-decided strip labelled as session-scoped, with a link to the Audit Log.
12. WHEN the pending queue is empty, THE Approvals_View SHALL render "Nothing needs your decision."
13. THE Approvals_View SHALL render "Faisla aapka." once, as the queue framing line.

### Requirement 6: SpeakerOps

**User Story:** As a community leader, I want to see which speakers are unconfirmed and what CommunityOps has already done about it, so that I only chase the ones the agent cannot.

#### Acceptance Criteria

1. THE SpeakerOps_View SHALL group speakers from `GET /events/{eventId}/speakers` into Needs attention, In progress with CommunityOps, Confirmed, and Declined/Cancelled.
2. THE SpeakerOps_View SHALL render one confirmation-progress visual composed from the real status counts.
3. WHEN a user activates "View details" on a speaker row, THE Drawer SHALL present topic, session type, `followup_count`, travel and accommodation flags, backup relationship, and that speaker's agent activity from the audit log.
4. THE SpeakerOps_View SHALL present `FOLLOWUP_SENT` and `AWAITING_RESPONSE` as Handled with the follow-up count stated.
5. WHEN a user submits a speaker change, THE SpeakerOps_View SHALL issue `PUT /events/{eventId}/speakers/{speakerId}` restricted to the fields that endpoint allows and update the affected row in place.
6. WHEN `GET /events/{eventId}/speakers` returns zero speakers, THE SpeakerOps_View SHALL render "No speakers yet for this event."

### Requirement 7: TeamOps

**User Story:** As a community leader, I want to see which team is blocked and on what, so that I can unblock people instead of reading task lists.

#### Acceptance Criteria

1. THE TeamOps_View SHALL present teams as the primary structure, with task detail reached from a team.
2. THE TeamOps_View SHALL derive every team identifier it uses from the response of `GET /events/{eventId}/teams`.
3. IF `GET /events/{eventId}/teams` is unavailable, THEN THE TeamOps_View SHALL render a "Team directory unavailable" state that names the missing contract in plain language and states that task data becomes reachable once a team directory exists (A5).
4. WHERE the team directory is available, THE TeamOps_View SHALL render per-team blocked, overdue, in-progress and completed counts from `GET /events/{eventId}/teams/{teamId}/tasks`, ordered by attention needed.
5. WHEN a user opens a team, THE Drawer SHALL list that team's tasks with title, assignee, due date, escalation level, and `depends_on` and `blocks` relationships expressed as sentences.
6. THE TeamOps_View SHALL pair every blocked and overdue portion of a progress visual with a text label.
7. WHEN a team has zero tasks, THE TeamOps_View SHALL render "No tasks recorded for this team."
8. WHEN a user submits a task change, THE TeamOps_View SHALL issue `PUT /events/{eventId}/teams/{teamId}/tasks/{taskId}` restricted to the fields that endpoint allows and update the affected task in place.

### Requirement 8: IncidentOps

**User Story:** As a community leader, I want to see what is at risk and what CommunityOps proposes, so that I can decide on the proposal rather than diagnose the problem.

#### Acceptance Criteria

1. THE IncidentOps_View SHALL render incidents from `GET /events/{eventId}/incidents` ordered by severity with CRITICAL first, and SHALL collapse resolved incidents below the active ones.
2. THE IncidentOps_View SHALL render each incident row with severity, affected resource, status and the next action.
3. THE IncidentOps_View SHALL render one severity-distribution visual composed from the real counts.
4. WHEN a user activates "View details" on an incident, THE Drawer SHALL present description, impact analysis, dependencies, `backup_options` as a labelled list, the recommendation with its state, and the resolution summary when the incident is resolved.
5. THE IncidentOps_View SHALL present the recommendation inside the Drawer.
6. WHERE a pending approval's `affected_resource_id` matches an incident identifier, THE IncidentOps_View SHALL surface that approval and describe the relationship as derived.
7. WHEN zero incidents exist for the active event, THE IncidentOps_View SHALL render "No incidents for this event."
8. WHEN a user submits an incident change, THE IncidentOps_View SHALL issue `PUT /events/{eventId}/incidents/{incidentId}` restricted to the fields that endpoint allows and update the affected row in place.

### Requirement 9: Check-In

**User Story:** As a volunteer at the venue desk, I want to find an attendee, see whether they can go in, and check them in from a phone, so that the queue keeps moving even when a ticket is missing.

#### Acceptance Criteria

1. THE Checkin_View SHALL present a search, verify and complete flow with recovery and reconciliation as branches, and SHALL reflect real progress in a four-step stepper.
2. THE Checkin_View SHALL present one search field and state that it accepts registration ID, email, phone or name.
3. WHEN `POST /events/{eventId}/checkin/search` returns a single match, THE Checkin_View SHALL advance to verification for that registration.
4. WHEN a search response sets `requires_disambiguation`, THE Checkin_View SHALL render only the masked candidate fields the API returned — `registration_id`, `attendee_name`, masked email and `ticket_type` — and SHALL require the volunteer to select one.
5. WHEN `POST /events/{eventId}/checkin/verify` returns, THE Checkin_View SHALL render all seven named checks — `registration_exists`, `event_match`, `registration_status`, `payment_status`, `not_cancelled`, `not_refunded`, `checkin_eligibility` — each with its PASS, FAIL or WARN result and its message.
6. WHERE `checkin_eligibility` returns WARN, THE Checkin_View SHALL present it as "Already checked in" and keep completion available.
7. THE Checkin_View SHALL derive every verification result from the verify response.
8. WHEN a user starts recovery, THE Checkin_View SHALL render "Ticket nahi mila? Koi scene nahi." and report the outcome as newly generated or already existing according to `already_existed`.
9. WHEN a user submits reconciliation, THE Checkin_View SHALL send `transaction_id` only, state that card details are not accepted, and report `recovery_case_created` as a case rather than a resolution.
10. WHEN check-in completes, THE Checkin_View SHALL render "Scene handled." with `checked_in_at`, and WHERE `was_already_checked_in` is true, THE Checkin_View SHALL report an existing check-in instead of a new one.
11. WHILE the Checkin_View is idle, THE Checkin_View SHALL explain what can be searched.
12. IF a check-in request fails, THEN THE Checkin_View SHALL render the copy mapped to the returned category and retain the search input.

### Requirement 10: Audit Log

**User Story:** As a community leader, I want a readable record of what happened, who did it and whether it was allowed, so that I can trust the agent and answer questions after the event.

#### Acceptance Criteria

1. THE Audit_View SHALL render `GET /events/{eventId}/audit` as a chronological timeline, newest first, grouped by day.
2. THE Audit_View SHALL render each entry as a readable actor, action and outcome sentence built from `timestamp`, `action`, `actor_type`, `actor_id`, `resource_type`, `resource_id`, `outcome`, and `tool_used` and `policy_evaluated` when present.
3. THE Audit_View SHALL restrict the fields it renders to the list in criterion 10.2 (A11).
4. WHERE further entries exist, THE Audit_View SHALL offer "Load more" using the endpoint's `limit` parameter, capped at 200.
5. THE Audit_View SHALL offer actor-type filters for CommunityOps agents, people and system.
6. WHEN zero audit events exist for the active event, THE Audit_View SHALL render "No activity recorded yet."

### Requirement 11: AttendeeOps

**User Story:** As a community leader, I want attendee readiness only when it reflects real attendee records, so that I am never shown a funnel assembled from data the system does not have.

#### Acceptance Criteria

1. IF the AttendeeOps capability flag is off, THEN THE Console SHALL resolve `/attendees` to the not-found view (A6).
2. WHERE the AttendeeOps capability flag is on, THE AttendeeOps_View SHALL render a readiness funnel of Registered, Information complete, Requirements captured and Arrival confirmed over records from `GET /events/{eventId}/attendees`.
3. WHERE the AttendeeOps_View renders, THE AttendeeOps_View SHALL derive its exception lists from `missing_fields`, `dietary_requirements`, `accessibility_requirements` and `accommodation_required`.
4. THE AttendeeOps_View SHALL derive every displayed value from the attendee contract.

### Requirement 12: Design system consistency

**User Story:** As a community leader, I want every page to feel like one product, so that I never have to relearn where things are or what a colour means.

#### Acceptance Criteria

1. THE Design_System SHALL define every colour, type size, type weight, line height, spacing step, radius, shadow, z-index, breakpoint, control height and layout dimension as a CSS custom property in `src/styles/tokens.css`.
2. THE Console SHALL express layout through classes and token-backed CSS custom properties, so that page and component files contain no inline `style` literal.
3. THE Console SHALL render a single light theme.
4. THE App_Shell and PageHeader SHALL produce the same page frame, title baseline, content width, page padding, card padding and section rhythm on every route.
5. THE Status_Badge SHALL be the only component that maps a status to a colour, and SHALL render a text label with every status it renders.
6. THE Drawer SHALL be the only progressive-disclosure surface, with the same open, close and focus behaviour on every route.
7. THE Console SHALL use the canonical term from the `design.md` §15.2 glossary for each concept it names.
8. THE Console SHALL label decision actions as Approve, Edit and Decline.
9. THE Console SHALL render exactly one of Handled, Needs your decision or Cannot be automated for each operational item it displays.
10. THE Console SHALL render at most one contextual visual per page, composed from tokens and real values.
11. THE Console SHALL render one button height, one input height and one primary action per page.

### Requirement 13: Loading, empty, error and mock states

**User Story:** As a community leader, I want every screen to tell me plainly what is happening, so that I never mistake a failure for an empty operation or fabricated data for live data.

#### Acceptance Criteria

1. WHILE an API-backed view is loading, THE Console SHALL render skeletons in the shape of the eventual content.
2. WHEN an API-backed view resolves with zero records, THE Console SHALL render the EmptyState carrying the copy specified for that view.
3. IF an API request fails with category `INTERNAL_ERROR`, `EXTERNAL_SERVICE_ERROR` or `TIMEOUT`, THEN THE Console SHALL render "CommunityOps couldn't load this view." with a "Try again" action that re-runs only the failed request.
4. IF an API request fails with category `NOT_FOUND`, THEN THE Console SHALL render "We couldn't find that record. It may have been removed." and refresh the affected list.
5. IF an API request fails with category `AMBIGUOUS_MATCH`, THEN THE Console SHALL render "More than one person matches. Pick the right registration." with the masked candidates.
6. IF an API request fails with category `POLICY_REQUIRES_APPROVAL`, THEN THE Console SHALL render "CommunityOps needs your approval before this can proceed." with a link to Approvals.
7. IF required client configuration is missing, THEN THE Console SHALL render "This console isn't configured yet." and write the specific detail to the browser console only.
8. IF a region-scoped request fails, THEN THE Console SHALL scope the error state to that region and keep the rest of the page usable.
9. WHILE `VITE_USE_MOCK` equals `"true"`, THE API_Client SHALL return mock data and THE App_Shell SHALL render the Demo Mode badge.
10. IF an API request fails while `VITE_USE_MOCK` does not equal `"true"`, THEN THE API_Client SHALL propagate the `ApiError` and return no mock data.
11. WHEN a mutation is in flight, THE Console SHALL place the invoking control in a loading state, lock the related controls, and replace the action row with the result in place.

### Requirement 14: Responsive behaviour

**User Story:** As a community leader on a laptop and a volunteer on a phone, I want each width to be deliberately designed, so that the decision surface and the check-in flow work wherever I am.

#### Acceptance Criteria

1. WHILE the viewport is at or above `--bp-lg`, THE App_Shell SHALL render the full `--nav-w` sidebar and cap content at `--content-max`.
2. WHILE the viewport is between `--bp-md` and `--bp-lg`, THE Sidebar SHALL collapse to icons with labels on hover and focus, and THE Console SHALL render a single content column.
3. WHILE the viewport is between `--bp-sm` and `--bp-md`, THE Sidebar SHALL render as a menu button opening a full-height panel that contains the event switcher.
4. WHILE the viewport is below `--bp-sm`, THE Drawer SHALL render as a full-screen sheet with an explicit Close control.
5. THE Console SHALL render the decision surface with all three action labels visible at every supported width.
6. WHILE the viewport is below `--bp-md`, THE Console SHALL render interactive targets at `--touch-min` or larger.
7. THE Console SHALL fit content within the viewport width at `--bp-sm`, `--bp-md`, `--bp-lg` and `--bp-xl` with no horizontal page scroll and no clipped content.

### Requirement 15: Accessibility

**User Story:** As a user relying on a keyboard or a screen reader, I want the console to be navigable and announced correctly, so that I can run an operation without a mouse or colour perception.

#### Acceptance Criteria

1. THE Console SHALL render one `<main>`, one `<h1>`, a `<nav>` landmark and a skip-to-content link per page, with a single descending heading order.
2. THE Console SHALL render tabular data as `<table>` markup with `<th scope>` headers.
3. THE Console SHALL make every action reachable and operable by keyboard in a logical tab order.
4. THE Console SHALL render a visible focus indicator from `--focus-ring` on every interactive element.
5. THE Drawer SHALL expose `role="dialog"` and `aria-modal`, be labelled by its heading, move focus into itself on open, trap focus while open, and return focus to the triggering element on close.
6. WHEN a user presses Escape while a Drawer or confirmation layer is open, THE Console SHALL close that layer.
7. THE Console SHALL give every form control a visible `<label>` and associate validation errors programmatically with their control.
8. WHEN a decision result, a check-in outcome or a mock-mode change occurs, THE Console SHALL announce it through an `aria-live="polite"` region.
9. THE Console SHALL meet WCAG AA contrast for body text and UI text against their token backgrounds.
10. THE Console SHALL pair every colour-coded status, severity and progress segment with a text label.
11. WHILE `prefers-reduced-motion` is set, THE Console SHALL render contextual visuals with no autonomous animation.
12. THE Console SHALL provide a text alternative stating the same counts for every contextual visual.

### Requirement 16: Security

**User Story:** As the operator of a multi-tenant system, I want the frontend to hold no authority and leak no internals, so that a hostile visitor with the bundle and devtools gains nothing.

#### Acceptance Criteria

1. THE Console SHALL include in its bundle only configuration values: API URL, user pool and client identifiers, capability flags, and the deliberately public demo credential (A18).
2. THE Console SHALL render affordances only, and SHALL rely on API Gateway and `tenancy.authorize_organization` for every access decision.
3. THE API_Client SHALL send an `organization_id` derived from the ID token's `cognito:groups` claim.
4. IF a stored preference or URL parameter names an organization outside the token's groups, THEN THE Console SHALL disregard that value.
5. THE Console SHALL render only values corresponding to fields declared in `src/types.ts`.
6. THE Console SHALL exclude `task_token`, `workflow_execution_id` and `AuditEvent.details` from its typed models, so that those values are never read, rendered, logged or persisted (A8, A11).
7. THE Console SHALL render user-facing text that contains no stack trace, exception name, AWS ARN, account identifier, table name, Lambda name, request path or request identifier.
8. THE Console SHALL keep masked check-in candidate fields masked, and SHALL write no personal data to `localStorage` or to client-side logs.
9. THE Console SHALL keep tokens in the Cognito SDK storage, and SHALL place no token in application state, URLs or logs.

### Requirement 17: Quality gates

**User Story:** As a maintainer, I want the same four commands to prove the console is sound, so that every phase lands verified rather than assumed.

#### Acceptance Criteria

1. THE Console SHALL pass `npm run typecheck` from `apps/web` with zero errors.
2. THE Console SHALL pass `npm run lint` from `apps/web` with zero errors.
3. THE Console SHALL pass `npm test -- --run` from `apps/web` with every test passing, including the existing tests in `src/api.test.ts` unchanged.
4. THE Console SHALL pass `npm run build` from `apps/web` with zero errors.
5. THE Console SHALL satisfy criteria 17.1 through 17.4 at the end of every implementation phase.
6. WHERE a deployed stack is available, THE Live_Smoke_Check SHALL report every console view receiving real data.

## Non-Functional Constraints

| # | Constraint | Source |
|---|---|---|
| NFC-1 | Light theme only. `src/index.css` is converted, not themed; no dark-mode toggle is added. | design.md §6.1 |
| NFC-2 | No new heavy dependencies. No UI kit, no CSS framework, no charting library, no animation library, no state library, no data-fetching library. Visuals are composed from SVG and CSS over tokens. | design.md §5.1, §6.3, State Model |
| NFC-3 | Strict TypeScript retained (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`). No unnecessary `any`, no `@ts-ignore`, no `eslint-disable` to pass a gate. | design.md §2.1 |
| NFC-4 | `src/api.ts` and `src/auth.ts` are extended, not replaced. The `ApiError` contract and the mock gating tests survive unchanged. | design.md §2.1, §5.1 |
| NFC-5 | Component and interaction tests require adding `jsdom` and `@testing-library/react` / `@testing-library/user-event` and setting the Vitest environment. These are dev dependencies. | design.md §2.6, §21.2 |
| NFC-6 | No credential of any kind is committed. CI runs a repository-wide secret scan. | design.md §2.6, A18 |
| NFC-7 | Property-based testing is not adopted. The correctness properties are verified as targeted behaviour tests, and by the Live_Smoke_Check where jsdom cannot reach them. | design.md §21 |

## Backend and Infrastructure Prerequisites

These gate specific requirements. Each one has a defined degraded frontend
behaviour that ships in the meantime.

| Ref | Prerequisite | Gates | Frontend behaviour while blocked |
|---|---|---|---|
| A8 | Strip `task_token` and `workflow_execution_id` from the approvals response | Public exposure of Requirement 5 | 16.5, 16.6 ship regardless; launch is gated on the backend change |
| A18 | `ORG-demo` Cognito group, demo user creation script, `seed-demo.py` organization parameterization | Requirement 2 | 2.2 — the demo action is absent, not faked |
| A5 | `GET /events/{eventId}/teams` returning `{teams[], count}` filtered to `entity_type == "TEAM"` | 7.4, 7.5, 7.8 | 7.3 — "Team directory unavailable"; the hardcoded team list is deleted |
| A6 | `GET /events/{eventId}/attendees` plus seeded attendee records | 11.2, 11.3 | 11.1, 3.5 — route resolves to not-found, nav entry absent |
| A1 | Hosted UI domain, OAuth configuration, identity provider resources | 1.10 | 1.11 — provider block absent |
| A15 | Console publish step: build, `s3 sync`, CloudFront invalidation | Deployment | 17.1–17.4 pass locally; publishing waits |
| A9 | `SendTaskSuccess` / `SendTaskFailure` on decision | Continuation copy | 5.7 — outcome-only copy, no continuation claim |
| A17 | Narrow API CORS to the CloudFront domain | Production hardening | No frontend impact |
