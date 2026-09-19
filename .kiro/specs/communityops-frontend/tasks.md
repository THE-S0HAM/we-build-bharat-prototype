# Implementation Plan: CommunityOps Frontend

## Overview

Frontend implementation plan for `apps/web`, derived from `design.md` §Phased
Implementation Order (A–M). Every task writes or tests frontend code. No task
changes backend, infrastructure or deployment: where a phase is gated by a
backend gap, the task implements the honest degraded state and names the blocker.

Phases A and B are strictly first — every later page consumes their tokens,
shell, session context and event context. The validation gate
(`npm run typecheck`, `npm run lint`, `npm test -- --run`, `npm run build`, all
from `apps/web`) closes every phase.

## Tasks

- [x] 1. Phase A — Design tokens, light theme and application shell

  - [x] 1.1 Create `src/styles/tokens.css` with the complete token set
    - Surface, brand, attention, risk, text, line, type scale, weight and line height, spacing, radius, elevation, z-index, breakpoints, control heights, layout dimensions per `design.md` §6.2
    - Import once from `src/main.tsx`
    - _Requirements: 12.1, 12.3_

  - [x] 1.2 Convert `src/index.css` from dark to light over tokens
    - Replace every literal colour, size and radius with a token reference
    - Preserve the existing `prefers-reduced-motion` block and the explicit `:focus-visible` rule unchanged
    - _Requirements: 12.1, 12.3, 15.4, 15.11_

  - [x] 1.3 Set up the component test environment
    - Add `jsdom`, `@testing-library/react`, `@testing-library/user-event` as dev dependencies; set the Vitest environment
    - The existing tests in `src/api.test.ts` must keep passing unchanged
    - Prerequisite for every component and interaction test task below
    - _Requirements: 17.3_

  - [x] 1.4 Build `AppShell` and `PageHeader`
    - Single `<main>`, `<nav>` landmark, skip-to-content link, content capped at `--content-max`, one page padding and section rhythm
    - `PageHeader` owns page title, context line and at most one primary action
    - _Requirements: 3.1, 12.4, 12.11, 15.1_

  - [x] 1.5 Build `Sidebar` from a single nav config list
    - Groups: ungrouped Command Center, OPERATIONS, EVENT DAY, GOVERNANCE
    - Active state with `aria-current="page"`; pending-approval badge slot; entries behind a capability flag omitted from the DOM
    - Account block renders `name`, `email` and active organization only — no role label
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 1.6 Build `Topbar`
    - Slots for the event switcher and the demo-workspace chip (wired in Phase B), plus sign-out
    - Only surface that renders global context; renders the `VITE_USE_MOCK` Demo Mode badge while mock mode is active
    - _Requirements: 3.11, 1.6, 13.9_

  - [x] 1.7 Build `StatusBadge` and `RiskIndicator`
    - `StatusBadge` owns the whole status-to-colour table from `design.md` §6.4 and always renders a text label
    - `RiskIndicator` renders LOW/MEDIUM/HIGH/CRITICAL with `--risk` reserved for CRITICAL
    - _Requirements: 12.5, 12.9, 15.10_

  - [x] 1.8 Build `Drawer`
    - `role="dialog"`, `aria-modal`, labelled by its heading, focus moved in on open, focus trapped while open, focus returned to the trigger on close, Escape closes, scroll lock
    - _Requirements: 12.6, 15.5, 15.6_

  - [x] 1.9 Build `EmptyState`, `ErrorState` and `Skeleton`
    - One empty pattern, one error pattern with a "Try again" that re-runs only the failed request, one shape-preserving loading pattern
    - _Requirements: 13.1, 13.2, 13.3_

  - [x] 1.10 Build `DataTable` and `Timeline`
    - `DataTable` uses `<table>` with `<th scope>`, consistent alignment, loading and empty rows, and a row-level drawer trigger
    - `Timeline` renders chronological entries with actor attribution and one shared relative-time formatter
    - _Requirements: 15.2, 12.4_

  - [x] 1.11 Remove every inline `style` literal from the eight existing pages
    - `CommandCenter`, `CheckinConsole`, `ApprovalCenter`, `SpeakerOps`, `TaskBoard`, `IncidentCenter`, `AuditLog`, `Login`
    - Dynamic values pass through token-backed CSS custom properties set on the element
    - _Requirements: 12.2_

  - [x] 1.12 Add a lint guard against inline style literals and raw design values
    - Fail on `style={{` in `src/pages` and `src/components`, and on hex colours or raw px font sizes outside `src/styles`
    - _Requirements: 12.1, 12.2, 17.2_

  - [x] 1.13 Write behaviour tests for the shared components
    - `Drawer` traps focus, closes on Escape, returns focus to its trigger (Property 9)
    - `StatusBadge` renders a text label for every status (Property 8)
    - _Requirements: 15.5, 15.6, 12.5, 15.10_

  - [x] 1.14 Phase A validation gate
    - Run `npm run typecheck`, `npm run lint`, `npm test -- --run`, `npm run build` from `apps/web`; all must pass
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

- [x] 2. Phase B — Session, event context, login and demo access

  - [x] 2.1 Extract the session gate from `App.tsx` into a session context provider and `RequireSession`
    - Unresolved session renders the shell skeleton, never the login screen
    - Unauthenticated protected route navigates to `/login` and retains the intended route
    - Capability-flagged routes resolve to the not-found view when off
    - _Requirements: 1.3, 1.4, 1.5, 11.1_

  - [x] 2.2 Replace `VITE_ORG_ID` with token-derived organization context
    - Derive selectable organizations from `cognito:groups` via `getMemberOrganizations()`; `api.ts` sends the resolved value as `organization_id`
    - Disregard any stored or URL organization outside the token's groups
    - _Requirements: 1.12, 16.3, 16.4_

  - [x] 2.3 Build the `EventContext` provider
    - Resolve from `GET /events` in order: URL event, stored preference, first ACTIVE event, first event by start date; fall through when an identifier is absent from the response
    - Persist to `localStorage` keyed by the Cognito `sub`; reflect the active event in the URL
    - Delete the hardcoded `EVENT_ID` from `App.tsx`
    - _Requirements: 3.7, 3.8, 3.9_

  - [x] 2.4 Build `EventSwitcher`, wire it into `Topbar`, and add the no-events state
    - Sole writer of event context; zero events disables the event-scoped nav entries
    - _Requirements: 3.10, 3.11_

  - [x] 2.5 Rebuild the `Login` page
    - Email/password over the existing Cognito SRP path; safe failure copy that retains the entered email
    - Provider buttons rendered only from the `VITE_AUTH_PROVIDERS` allowlist; block and divider omitted when empty
    - Blocker: A1 — hosted UI domain, OAuth config and identity provider resources do not exist, so no provider is configured today and the block does not render
    - _Requirements: 1.1, 1.2, 1.10, 1.11_

  - [x] 2.6 Implement "Try Demo Account"
    - Config-gated on `VITE_DEMO_USERNAME` and `VITE_DEMO_PASSWORD`; absent from the DOM when either is missing
    - Same SRP call as the form; "Preparing your demo workspace…" transition; failure renders "Demo access is temporarily unavailable." with a working Try again and no backend detail
    - "Demo workspace" chip in `Topbar`, distinct from the `VITE_USE_MOCK` Demo Mode badge; sign-out unchanged
    - Blocker: A18 — `ORG-demo` group, demo identity and seeded demo organization do not exist yet, so the action stays absent until the configuration values are supplied
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11_

  - [x] 2.7 Implement the shared error-category mapping and session-level error handling
    - One mapping from `ApiError.category` to the copy table in `design.md` §12: 401 navigates to `/login` retaining the intended route with no notification; 403 renders "You don't have access to this organization's data." with no retry; `NOT_FOUND` renders "We couldn't find that record. It may have been removed." and refreshes the list; `POLICY_REQUIRES_APPROVAL` renders "CommunityOps needs your approval before this can proceed." with a link to Approvals
    - `CONFIGURATION_ERROR` renders "This console isn't configured yet." with detail in the browser console only
    - _Requirements: 1.8, 1.9, 13.4, 13.6, 13.7_

  - [x] 2.8 Write behaviour tests for session, event context, login and demo
    - Unresolved session renders skeleton; protected route redirect preserves the intended route; 401 mid-session returns to login; sign-out clears state (Properties 1, 2)
    - Demo button absent without config, present with it, preparing state shown, failure copy correct (Properties 4, 7)
    - Event context defaults to the first ACTIVE event, restores from storage, falls back on an invalid stored event, updates the URL on switch (Properties 5, 13)
    - _Requirements: 1.4, 1.5, 1.7, 1.8, 2.2, 2.4, 2.6, 3.7, 3.8, 3.9_

  - [x] 2.9 Phase B validation gate
    - Run `npm run typecheck`, `npm run lint`, `npm test -- --run`, `npm run build` from `apps/web`; all must pass
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

- [x] 3. Phase C — Command Center

  - [x] 3.1 Rebuild the `CommandCenter` layout
    - Greeting with `name` and active organization; headline watched-event count from `summary.active_events`, any total labelled "of N total"
    - Remove the stat-card grid; summary metrics limited to the greeting context line and the one contextual visual
    - _Requirements: 4.1, 4.2, 4.10, 4.11_

  - [x] 3.2 Build `DecisionCard` and wire the single oldest pending approval
    - Agent attribution, requested action, reason, consequence line, risk, actions; "Why this action?" opens the `Drawer`
    - _Requirements: 4.3, 4.9, 12.8_

  - [x] 3.3 Build the watched-event visual
    - One SVG/CSS orbit over `events[]` from `/command-center`; node treatment from real `pending_approvals`, `critical_incidents`, `overdue_tasks`, `blocked_tasks`; selecting a node sets event context
    - Text alternative stating the same counts; no autonomous animation under `prefers-reduced-motion`
    - _Requirements: 4.4, 4.5, 12.10, 15.11, 15.12_

  - [x] 3.4 Build `AgentStatus` and wire the handled strip
    - Strip from `GET /events/{eventId}/audit` for the active event, filtered to agent actors; org-wide `recent_actions` rendered below and labelled organization-wide
    - _Requirements: 4.6, 4.7_

  - [x] 3.5 Wire Command Center loading, empty and error states
    - Three-block skeleton; "Abhi koi drama nahi." + "CommunityOps is keeping things moving." with the handled strip; strip failure stays strip-local
    - _Requirements: 4.8, 13.1, 13.3, 13.8_

  - [x] 3.6 Write behaviour tests for the Command Center
    - Loading renders skeletons; success renders greeting, one decision surface, the visual over watched events and the handled strip; empty renders the calm state; error retries; headline count uses `active_events`
    - _Requirements: 4.1, 4.2, 4.3, 4.6, 4.8, 13.1, 13.3_

  - [x] 3.7 Phase C validation gate
    - Run `npm run typecheck`, `npm run lint`, `npm test -- --run`, `npm run build` from `apps/web`; all must pass
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

- [x] 4. Phase D — Approvals

  - [x] 4.1 Rebuild `ApprovalCenter` as a pending-only queue
    - Oldest first from `GET /events/{eventId}/approvals`; delete the permanently-empty resolved table; render "Faisla aapka." once as the framing line; empty renders "Nothing needs your decision."
    - _Requirements: 5.1, 5.2, 5.12, 5.13_

  - [x] 4.2 Build `ApprovalActions` for Approve and Decline
    - Exactly one request per user action with controls locked until it resolves; Decline requires a note and states that the note is recorded in the audit trail
    - _Requirements: 5.3, 5.4, 12.8, 13.11_

  - [x] 4.3 Implement Edit at real contract fidelity
    - One labelled multi-line field pre-filled with `requested_action`, original shown immediately above, submitted as `decision="EDITED"` with `edited_action`; copy "Adjust the action CommunityOps will take"
    - _Requirements: 5.5_

  - [x] 4.4 Implement the evidence allowlist renderer and the conditional financial line
    - Recognised keys as labelled rows, unrecognised keys as a single count, no raw JSON anywhere
    - Financial line renders only when `evidence` carries a recognised amount field
    - Render only fields declared in `src/types.ts`; keep `task_token` and `workflow_execution_id` out of the typed model
    - Blocker: A8 — the backend must strip `task_token` and `workflow_execution_id` from the approvals response before the console is publicly exposed; the typed-field allowlist here reduces blast radius but does not fix the exposure
    - _Requirements: 5.9, 5.10, 16.5, 16.6_

  - [x] 4.5 Implement 409 handling and post-decision copy
    - 409 replaces the card with "This was already decided elsewhere." and refetches the queue
    - Success renders "Decision recorded." plus the concrete outcome, with no continuation claim; "CommunityOps prepared this action" attribution, decision attributed to the user
    - _Requirements: 5.6, 5.7, 5.8_

  - [x] 4.6 Implement the session-scoped recently-decided strip
    - Built from decisions made in this session, labelled session-scoped, linking to the Audit Log
    - _Requirements: 5.11_

  - [x] 4.7 Write behaviour tests for approvals
    - Approve submits once and locks controls; Edit pre-fills and submits `EDITED` with `edited_action`; Decline requires a note; 409 shows already-decided and refreshes; post-decision copy makes no continuation claim (Property 15)
    - Unrecognised evidence keys render as a count and never as serialized text; no rendered string contains an AWS identifier (Properties 7, 10, 11, 12)
    - _Requirements: 5.3, 5.4, 5.5, 5.6, 5.7, 5.9, 5.10, 16.5, 16.7_

  - [x] 4.8 Phase D validation gate
    - Run `npm run typecheck`, `npm run lint`, `npm test -- --run`, `npm run build` from `apps/web`; all must pass
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

- [x] 5. Phase E — SpeakerOps

  - [x] 5.1 Rebuild `SpeakerOps` with status grouping and the confirmation-progress visual
    - Groups: Needs attention, In progress with CommunityOps, Confirmed, Declined/Cancelled; one progress visual from real status counts
    - _Requirements: 6.1, 6.2, 12.10_

  - [x] 5.2 Build the speaker drawer and agent attribution
    - Topic, session type, `followup_count`, travel and accommodation flags, backup relationship, speaker-scoped agent activity
    - `FOLLOWUP_SENT` and `AWAITING_RESPONSE` read as Handled with the follow-up count stated
    - _Requirements: 6.3, 6.4, 12.6_

  - [x] 5.3 Wire the speaker mutation
    - `PUT /events/{eventId}/speakers/{speakerId}` restricted to the fields that endpoint allows; row updates in place with controls locked while in flight
    - _Requirements: 6.5, 13.11_

  - [x] 5.4 Wire SpeakerOps loading, empty and error states
    - List skeleton; "No speakers yet for this event."; shared error state
    - _Requirements: 6.6, 13.1, 13.2, 13.3_

  - [x] 5.5 Write behaviour tests for SpeakerOps
    - Status grouping is correct; agent-progress statuses render as Handled with the count; mutation sends only allowed fields
    - _Requirements: 6.1, 6.4, 6.5_

  - [x] 5.6 Phase E validation gate
    - Run `npm run typecheck`, `npm run lint`, `npm test -- --run`, `npm run build` from `apps/web`; all must pass
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

- [x] 6. Phase F — TeamOps

  - [x] 6.1 Delete the hardcoded team list and the per-team fan-out from `TaskBoard.tsx`
    - No team identifier originates in frontend source
    - _Requirements: 7.2_

  - [x] 6.2 Implement the "Team directory unavailable" state
    - Names the missing `GET /events/{eventId}/teams` contract in plain product language and states that task data becomes reachable once a team directory exists
    - Blocker: A5 — the teams list endpoint does not exist; this state is what ships until it does
    - _Requirements: 7.3_

  - [x] 6.3 Implement the team-first board behind a typed teams client
    - Add the typed `GET /events/{eventId}/teams` client and `Team` model in `api.ts` / `types.ts`; render per-team blocked, overdue, in-progress and completed counts ordered by attention needed when the contract responds, and the unavailable state when it does not
    - Progress visual pairs blocked and overdue portions with text labels
    - _Requirements: 7.1, 7.4, 7.6_

  - [x] 6.4 Build the team task drawer and task mutation
    - Task title, assignee, due date, escalation level, `depends_on` and `blocks` as sentences; `PUT .../tasks/{taskId}` restricted to allowed fields, updating in place
    - Empty renders "No tasks recorded for this team."
    - _Requirements: 7.5, 7.7, 7.8_

  - [x] 6.5 Write behaviour tests for TeamOps
    - Unavailable state renders when the teams call fails or is absent; no hardcoded team identifier appears in the rendered output; blocked and overdue carry text labels
    - _Requirements: 7.2, 7.3, 7.6_

  - [x] 6.6 Phase F validation gate
    - Run `npm run typecheck`, `npm run lint`, `npm test -- --run`, `npm run build` from `apps/web`; all must pass
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

- [x] 7. Phase G — IncidentOps

  - [x] 7.1 Rebuild `IncidentCenter` with severity ordering and the distribution visual
    - CRITICAL first, resolved collapsed below; row shows severity, affected resource, status and next action; one severity-distribution visual from real counts
    - _Requirements: 8.1, 8.2, 8.3, 12.10_

  - [x] 7.2 Build the incident drawer with the recommendation
    - Description, impact analysis, dependencies, `backup_options` as a labelled list, recommendation with its state, resolution summary when resolved; recommendation lives in the drawer, not as a headline card
    - _Requirements: 8.4, 8.5, 12.6_

  - [x] 7.3 Implement the derived approval linkage
    - Surface a pending approval only when its `affected_resource_id` matches the incident, and describe the relationship as derived
    - _Requirements: 8.6_

  - [x] 7.4 Wire IncidentOps states and the incident mutation
    - List skeleton; "No incidents for this event."; shared error state; `PUT .../incidents/{incidentId}` restricted to allowed fields, updating in place
    - _Requirements: 8.7, 8.8, 13.1, 13.2, 13.3_

  - [x] 7.5 Write behaviour tests for IncidentOps
    - Severity ordering with CRITICAL first; recommendation reachable only through the drawer; derived approval linkage matches on `affected_resource_id` and is labelled derived
    - _Requirements: 8.1, 8.5, 8.6_

  - [x] 7.6 Phase G validation gate
    - Run `npm run typecheck`, `npm run lint`, `npm test -- --run`, `npm run build` from `apps/web`; all must pass
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

- [x] 8. Phase H — Check-In

  - [x] 8.1 Rebuild the `CheckinConsole` search step and the four-step stepper
    - One field stating that it accepts registration ID, email, phone or name; stepper reflects real progress; idle state explains what can be searched
    - _Requirements: 9.1, 9.2, 9.11_

  - [x] 8.2 Implement single-match advance and masked disambiguation
    - Single match advances to verification; `requires_disambiguation` renders only `registration_id`, `attendee_name`, masked email and `ticket_type`, and requires an explicit selection
    - _Requirements: 9.3, 9.4, 16.8_

  - [x] 8.3 Implement the seven-check verification surface
    - All seven named checks with PASS/FAIL/WARN and their messages, every result taken from the verify response
    - `checkin_eligibility` WARN reads "Already checked in" and keeps completion available
    - _Requirements: 9.5, 9.6, 9.7_

  - [x] 8.4 Implement the recovery branch
    - "Ticket nahi mila? Koi scene nahi."; outcome reported as newly generated or already existing from `already_existed`
    - _Requirements: 9.8_

  - [x] 8.5 Implement the reconciliation branch
    - `transaction_id` only, with the form stating that card details are not accepted; `recovery_case_created` reported as a case rather than a resolution
    - _Requirements: 9.9_

  - [x] 8.6 Implement completion and check-in error handling
    - "Scene handled." with `checked_in_at`; `was_already_checked_in` reported as an existing check-in; failures render category-mapped copy and retain the search input
    - _Requirements: 9.10, 9.12, 13.5_

  - [x] 8.7 Write behaviour tests for Check-In
    - Single match advances; multi-match renders masked candidates only (Property 16); the seven checks render with their results; `checkin_eligibility` WARN does not block completion; recover and complete report prior state truthfully (Property 14)
    - _Requirements: 9.3, 9.4, 9.5, 9.6, 9.8, 9.10_

  - [x] 8.8 Phase H validation gate
    - Run `npm run typecheck`, `npm run lint`, `npm test -- --run`, `npm run build` from `apps/web`; all must pass
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

- [x] 9. Phase I — Audit Log

  - [x] 9.1 Rebuild `AuditLog` as a day-grouped timeline over modelled fields only
    - Newest first; readable actor, action and outcome sentences from `timestamp`, `action`, `actor_type`, `actor_id`, `resource_type`, `resource_id`, `outcome`, `tool_used`, `policy_evaluated`
    - `details` is excluded from the typed model by construction
    - _Requirements: 10.1, 10.2, 10.3, 16.6_

  - [x] 9.2 Implement actor-type filters and "Load more"
    - Filters for CommunityOps agents, people and system; paging against the endpoint `limit`, capped at 200
    - _Requirements: 10.4, 10.5_

  - [x] 9.3 Wire Audit Log loading, empty and error states
    - Timeline skeleton; "No activity recorded yet."; shared error state
    - _Requirements: 10.6, 13.1, 13.2, 13.3_

  - [x] 9.4 Write behaviour tests for the Audit Log
    - Only the listed fields render; `details` never appears in the output; load more respects the cap; filters narrow by actor type
    - _Requirements: 10.2, 10.3, 10.4, 10.5_

  - [x] 9.5 Phase I validation gate
    - Run `npm run typecheck`, `npm run lint`, `npm test -- --run`, `npm run build` from `apps/web`; all must pass
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

- [x] 10. Phase J — AttendeeOps (conditional on the real contract landing)

  - [ ]* 10.1 Add the typed attendee client and model
    - `GET /events/{eventId}/attendees` in `api.ts` and the `Attendee` interface in `types.ts`, matching the shipped contract exactly
    - Blocker: A6 — no attendee endpoint, route or seeded `ATTENDEE` records exist; do not start this task until the contract is deployed
    - _Requirements: 11.2, 11.4_

  - [ ]* 10.2 Implement the readiness funnel and exception lists
    - Registered → Information complete → Requirements captured → Arrival confirmed over real records; exceptions from `missing_fields`, `dietary_requirements`, `accessibility_requirements`, `accommodation_required`
    - Enable the capability flag only once real data renders; until then the route stays on the not-found view and the nav entry stays absent
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [ ]* 10.3 Write behaviour tests for AttendeeOps gating and the funnel
    - Flag off: nav entry absent and route resolves to not-found (Property 17); flag on: funnel stages derive only from attendee fields
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [ ]* 10.4 Phase J validation gate
    - Run `npm run typecheck`, `npm run lint`, `npm test -- --run`, `npm run build` from `apps/web`; all must pass
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

- [ ] 11. Phase K — Responsive behaviour and accessibility

  - [x] 11.1 Implement the shell breakpoint behaviour
    - Full `--nav-w` sidebar and `--content-max` at or above `--bp-lg`; icon collapse with hover and focus labels between `--bp-md` and `--bp-lg`; menu button with full-height panel containing the event switcher between `--bp-sm` and `--bp-md`
    - _Requirements: 14.1, 14.2, 14.3_

  - [x] 11.2 Implement full-screen drawer sheets and touch targets
    - `Drawer` becomes a full-screen sheet with an explicit Close below `--bp-sm`; interactive targets hold at `--touch-min` below `--bp-md`
    - _Requirements: 14.4, 14.6_

  - [x] 11.3 Make the decision surface and tables responsive
    - All three action labels visible at every width, buttons stack rather than truncate; tables keep primary columns and move the rest into the drawer; no horizontal page scroll or clipping at any breakpoint
    - _Requirements: 14.5, 14.7_

  - [x] 11.4 Run the accessibility implementation pass across all pages
    - Landmarks and single descending heading order; labelled controls with programmatically associated errors; `aria-live="polite"` for decision results, check-in outcomes and mock-mode changes; visible focus everywhere; AA contrast on token backgrounds; text labels beside every colour-coded status; text alternatives for the contextual visuals; reduced-motion respected
    - _Requirements: 15.1, 15.3, 15.4, 15.7, 15.8, 15.9, 15.10, 15.11, 15.12_

  - [~] 11.5 Write responsive and accessibility tests
    - Menu-button behaviour and nav visibility at the collapsed breakpoint where jsdom allows; one `<h1>` per page; labelled controls; `role="dialog"` with `aria-modal` on drawers; status regions announced
    - _Requirements: 14.3, 15.1, 15.5, 15.7, 15.8_

  - [ ] 11.6 Phase K validation gate
    - Run `npm run typecheck`, `npm run lint`, `npm test -- --run`, `npm run build` from `apps/web`; all must pass
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

- [ ] 12. Phase L — Cross-page consistency

  - [~] 12.1 Run the pixel-precision checklist on every page
    - All twelve checks from `design.md` §15.3 against each of the eight pages; every fix lands in the shared component or token, never locally
    - _Requirements: 12.1, 12.2, 12.4, 12.5, 12.6, 12.10, 12.11, 13.1, 13.2, 13.3_

  - [x] 12.2 Run the terminology and product-name sweep
    - Every concept uses its canonical term from `design.md` §15.2; decision actions read Approve, Edit and Decline; "CommunityOps" is the only product name in copy, page title and document metadata
    - _Requirements: 3.1, 12.7, 12.8_

  - [~] 12.3 Run the side-by-side cross-page comparison pass
    - All eight pages reviewed at one width: identical header zone, card language, table behaviour, badge treatment, drawer behaviour and empty/loading/error patterns, with at most one visual per page
    - _Requirements: 12.4, 12.9, 12.10_

  - [ ] 12.4 Phase L validation gate
    - Run `npm run typecheck`, `npm run lint`, `npm test -- --run`, `npm run build` from `apps/web`; all must pass
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

- [ ] 13. Phase M — Testing completion and production build

  - [ ] 13.1 Complete the behaviour-test matrix from `design.md` §21.3
    - Fill any remaining gaps across auth states, demo account, demo isolation with a demo-scoped token fixture, Command Center, approval decision, check-in, drawer, event context, mock discipline, responsive nav and accessibility smoke
    - _Requirements: 17.3_

  - [ ] 13.2 Add one targeted test per correctness property reachable in jsdom
    - Properties 1–18 from `design.md`; properties not reachable in jsdom are recorded as covered by the live smoke check instead
    - _Requirements: 17.3_

  - [x] 13.3 Add the security-surface tests
    - No rendered string contains a stack trace, exception name, AWS ARN, account identifier, table name, Lambda name, request path or request identifier; `task_token`, `workflow_execution_id` and `AuditEvent.details` are absent from the typed models and from rendered output; mock data never returns on a real failure
    - Assert the built bundle carries configuration values only, that no component gates access on a client-side role or permission check, and that no token is copied into application state, a URL or a log
    - _Requirements: 16.1, 16.2, 16.5, 16.6, 16.7, 16.9, 13.10_

  - [x] 13.4 Final validation gate
    - Run `npm run typecheck`, `npm run lint`, `npm test -- --run`, `npm run build` from `apps/web`; all must pass with the existing `api.test.ts` tests unchanged
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

  - [ ]* 13.5 Run the live smoke check against a deployed stack
    - `node scripts/live-smoke.mjs` from `apps/web`; asserts every console view receives real data
    - Conditional: requires a deployed stack and smoke credentials, so it runs only where those are available
    - _Requirements: 17.6_

## Notes

- Tasks marked `*` are optional or conditional: Phase J waits on the A6 attendee contract, and 13.5 waits on a deployed stack.
- Every task references the requirement criteria it implements, for traceability back to `requirements.md` and to the correctness properties in `design.md`.
- Validation gates are the phase checkpoints. A phase is not complete until `npm run typecheck`, `npm run lint`, `npm test -- --run` and `npm run build` all pass from `apps/web`. Ask the user if a gate fails for a reason outside the phase's scope.
- Backend blockers are called out inside the task that degrades around them: A1 (2.5), A5 (6.2), A6 (10.1), A8 (4.4), A18 (2.6). No task changes backend or infrastructure code.
- Task 1.3 installs the component test environment and gates every later component or interaction test task.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.4", "1.7", "1.8", "1.9", "1.10"] },
    { "id": 3, "tasks": ["1.5", "1.6"] },
    { "id": 4, "tasks": ["1.11", "1.12"] },
    { "id": 5, "tasks": ["1.13"] },
    { "id": 6, "tasks": ["1.14"] },
    { "id": 7, "tasks": ["2.1", "2.2"] },
    { "id": 8, "tasks": ["2.3", "2.5"] },
    { "id": 9, "tasks": ["2.4", "2.6", "2.7"] },
    { "id": 10, "tasks": ["2.8"] },
    { "id": 11, "tasks": ["2.9"] },
    { "id": 12, "tasks": ["3.1", "4.1", "5.1", "6.1", "7.1", "8.1", "9.1"] },
    { "id": 13, "tasks": ["3.2", "4.2", "5.2", "6.2", "7.2", "8.2", "9.2"] },
    { "id": 14, "tasks": ["3.3", "4.3", "5.3", "6.3", "7.3", "8.3", "9.3"] },
    { "id": 15, "tasks": ["3.4", "4.4", "5.4", "6.4", "7.4", "8.4", "9.4"] },
    { "id": 16, "tasks": ["3.5", "4.5", "5.5", "6.5", "7.5", "8.5", "9.5"] },
    { "id": 17, "tasks": ["3.6", "4.6", "5.6", "6.6", "7.6", "8.6"] },
    { "id": 18, "tasks": ["3.7", "4.7", "8.7"] },
    { "id": 19, "tasks": ["4.8", "8.8"] },
    { "id": 20, "tasks": ["10.1"] },
    { "id": 21, "tasks": ["10.2"] },
    { "id": 22, "tasks": ["10.3"] },
    { "id": 23, "tasks": ["10.4"] },
    { "id": 24, "tasks": ["11.1", "11.2", "11.3"] },
    { "id": 25, "tasks": ["11.4"] },
    { "id": 26, "tasks": ["11.5"] },
    { "id": 27, "tasks": ["11.6"] },
    { "id": 28, "tasks": ["12.1"] },
    { "id": 29, "tasks": ["12.2"] },
    { "id": 30, "tasks": ["12.3"] },
    { "id": 31, "tasks": ["12.4"] },
    { "id": 32, "tasks": ["13.1", "13.2", "13.3"] },
    { "id": 33, "tasks": ["13.4"] },
    { "id": 34, "tasks": ["13.5"] }
  ]
}
```
