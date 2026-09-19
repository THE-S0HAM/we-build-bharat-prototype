# CommunityOps Frontend — Tasks

Status is recorded as work completes. History is preserved rather than cleared.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked / not possible

## Phase A — Discovery and reconciliation

- [x] A.1 Inventory the API surface. 73 routes enumerated from `template.yaml`.
- [x] A.2 Inventory `apps/web`. 8 pages, dark theme, read-only except Check-In and Approvals.
- [x] A.3 Confirm Slack. No code, config or credential anywhere → **not implemented**.
- [x] A.4 Confirm federated identity. `SupportedIdentityProviders: [COGNITO]`, no domain, no
      callbacks → **not configured**.
- [x] A.5 Confirm AttendeeOps contract. `AttendeeState` exists, no REST route → **backend gap**.
- [x] A.6 Confirm demo access. Cognito only, no demo identity, no bootstrap → **backend gap**.
- [!] A.7 Locate the referenced HTML prototypes. `orbitops-command-center(1).html` and
      `orbitops-prototype(1).html` are **not present** in the repository. Working from the written
      IA and visual direction in the brief instead.
- [x] A.8 Write requirements, design and this task list.

## Phase B — Backend gaps

Smallest change that closes a real contract gap. No existing behaviour modified.

- [x] B.1 `GET /events/{eventId}/attendees` in `operations_handler`, reusing `AttendeeState`.
      Returns the aggregate plus actionable exception lists. Scope-checked.
- [x] B.2 `POST /demo/session` in `services/api/demo_handler.py`. Public route, fixed username,
      `AdminInitiateAuth`, password from environment. Refuses clearly when unconfigured.
- [x] B.3 Template: demo function, public route, `ADMIN_NO_SRP_AUTH` on the client, `DemoPassword`
      parameter (`NoEcho`), least-privilege `cognito-idp:AdminInitiateAuth` on the pool only.
- [x] B.4 `scripts/setup-demo-users.py` — groups plus three identities, passwords from environment
      or generated and printed once.
- [x] B.5 Tests: attendee route shape and scope; demo endpoint unconfigured, wrong method, and
      that it never accepts a username.

## Phase C — Design system and shell

- [x] C.1 Replace the dark token set with the light system. Status triples so interpolated class
      names always resolve.
- [x] C.2 `AppShell` — grouped sidebar, topbar with event context, role and decision count.
- [x] C.3 Primitives: `PageHeader`, `Card`, `Section`, `Stat`, `Progress`, `StatusBadge`,
      `SeverityBadge`, `HealthPill`, `Skeleton`, `LoadingState`, `EmptyState`, `ErrorState`,
      `Notice`, `Drawer`, `Tabs`, `DetailList`. No separate `Confirm`: every destructive action
      already carries its own in-place explanation, and a second modal on top of a drawer would be
      one dialog too many.
- [x] C.5 `toneFor` moved to `src/status.ts`. Keeping it in `primitives.tsx` mixed a plain function
      with component exports, which breaks Fast Refresh, and it is the piece most worth unit
      testing on its own.
- [x] C.4 One `.page` grid applied by the shell so every screen shares margins and rhythm.

## Phase D — Authentication, routing, demo entry

- [x] D.1 Restructure `App.tsx` so the router renders before the session gate, making public routes
      reachable.
- [x] D.2 `auth.getRole()` from `cognito:groups`, same decode approach as `getMemberOrganizations`.
- [x] D.3 Route guard; leader shell vs team workspace.
- [x] D.4 Landing page.
- [x] D.5 Login: email/password, honest statement about configured methods, demo entry.
- [x] D.6 `startDemoSession()` wired to `POST /demo/session`; token stored as the SRP flow does.

## Phase E — Command Center

- [x] E.1 Context line and the single dominant decision surface.
- [x] E.2 Constellation visual.
- [x] E.3 Handled summary, aggregated.
- [x] E.4 Attention list below the fold.
- [x] E.5 No-attention state.
- [x] E.6 Loading, empty, error.

## Phase F — Approvals and Agent Chat

- [x] F.1 Approvals queue: what / why / risk / action, one focused at a time.
- [x] F.2 Approve, Edit, Decline. Edit uses `decision=EDITED` with `edited_action`.
- [x] F.3 Budget figure taken from the decision response, never computed client-side.
- [x] F.4 `AgentChat` against `POST /agent/chat`; tools-used shown; approval-gated replies render as
      prepared, not done.
- [x] F.5 Capabilities panel from `GET /agent/capabilities`, so the boundary is inspectable.

## Phase G — SpeakerOps

- [x] G.1 Attention-first list; lifecycle progression.
- [x] G.2 Detail drawer with travel, accommodation and cost.
- [x] G.3 Draft follow-up inline; sending shown as approval-gated.

## Phase H — TeamOps

- [x] H.1 Team-level state first; healthy teams collapse.
- [x] H.2 Coordination grid from `/teams` and `/workload`.
- [x] H.3 Task list on selection; status update; reassign.

## Phase I — IncidentOps

- [x] I.1 Severity-ordered list with state track.
- [x] I.2 Recommendation behind a disclosure.
- [x] I.3 Discussion thread; agent and human authors distinguished.
- [x] I.4 Create task from a comment.
- [x] I.5 Resolution with summary, root cause, actions taken.

## Phase J — Check-In

- [x] J.1 Keep the working state machine; restyle to the light system.
- [x] J.2 Recovery path preserved; payment truth read from verification, never inferred.

## Phase K — Audit and Budget

- [x] K.1 Audit timeline, agent vs human actors, no secrets or AWS detail.
- [x] K.2 Budget: totals, category breakdown, utilization. No arithmetic in React.

## Phase L — AttendeeOps

- [x] L.1 Readiness funnel and exception lists, against the B.1 route.

## Phase M — Slack

- [!] M.1 Not implemented. No surface rendered. Contract recorded in `design.md` D-5 for a future
      implementer. Deliberately not stubbed, because a placeholder reads as a roadmap claim.

## Phase N — Responsive, accessibility, polish

- [x] N.1 Sidebar collapses; drawers full-screen under 768px; tables wrapped in `.table-wrap` so
      nothing forces horizontal overflow.
- [x] N.2 Focus states, labelled controls, Escape-to-close, focus trap and focus restoration in
      drawers. Colour is never the only carrier of state — every badge and check result also has a
      text label, and screen-reader-only text names the pass/fail status in the check-in list.
- [!] N.3 Contrast ratios were chosen against the token palette but **not measured**, and no screen
      reader or assistive-technology pass has been run. Claiming WCAG AA would need manual testing
      and expert review, so it is not claimed.
- [x] N.4 Cross-page review: one shell, one grid, one status vocabulary, one set of action labels.

## Phase O — Testing

- [x] O.1 Add `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `user-event`, and the
      Vitest `test` block.
- [x] O.2 api client, auth and role derivation.
- [x] O.3 Routing and guards.
- [x] O.4 Command Center states.
- [x] O.5 Approvals decide-and-refresh.
- [x] O.6 Incident comment round trip.
- [x] O.7 Agent chat, including the approval-gated reply.
- [x] O.8 `toneFor` covers every status in the backend enumerations, and every tone it can return
      has a matching `.badge-*` rule in the shipped stylesheet — read from disk, because Vitest does
      not process CSS and a `?raw` import would have made the check pass vacuously.
- [x] O.9 Check-in state machine end to end, including disambiguation, the payment-reference
      fallback, and that a failed verification has no override.
- [x] O.10 Budget page: proves no arithmetic happens in React by returning figures that local
      subtraction would not produce and asserting the backend's figures are the ones shown.
- [x] O.11 Regression found by O.5: the `Drawer` effect listed `onClose` in its dependencies, and
      callers pass an inline arrow. Every render tore the effect down and re-ran it, and its setup
      moves focus into the panel — so typing in the decision-notes field lost focus after one
      character. The handler now lives in a ref and the effect depends only on `open`. This was a
      real defect in the shipped interaction, not a test artefact.

**142 frontend tests across 10 files.** Coverage is deliberately uneven: it is concentrated on
money, the approval gate, authority boundaries and the check-in flow, and thin on the read-mostly
screens (SpeakerOps, TeamOps, AttendeeOps, AuditLog, AgentConsole) where a rendering mistake is
visible rather than silent.

## Phase P — Verification

- [x] P.1 Backend: 265 pytest passing, `ruff check` clean, `ruff format --check` clean over 112
      files, Cedar specification current. **LOCAL VERIFIED**
- [x] P.2 Frontend: `tsc --noEmit` clean, `eslint .` clean with zero warnings, 142 tests passing,
      production build succeeds. **LOCAL VERIFIED**
- [x] P.3 `sam validate --lint` reports a valid SAM template. **LOCAL VERIFIED**
- [ ] P.4 `sam build`.
- [ ] P.5 Deploy to `CommunityOps` / `ap-south-1` after verifying the caller identity.
- [ ] P.6 Live verification: leader journey, team journey, the ₹75,000 → ₹62,500 flow, and a real
      Bedrock invocation. Classify every claim.
