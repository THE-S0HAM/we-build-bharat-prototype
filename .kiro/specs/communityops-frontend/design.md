# CommunityOps Frontend — Design

## 1. What exists and is kept

| Piece | State | Action |
|---|---|---|
| `auth.ts` Cognito SRP sign-in | working | extend with role derivation and demo session |
| `api.ts` typed client, `apiFetch` chokepoint, `ApiError` | working | extend; keep the single chokepoint |
| `VITE_USE_MOCK` opt-in mock mode | working, deliberately not a fallback | preserve the invariant |
| `CheckinConsole.tsx` stepped flow | working, calls all six check-in routes | keep the state machine, restyle |
| `api.test.ts` env-stubbing pattern | working | keep, extend |
| react-router v7, React 19, Vite 6, Vitest 2 | working | keep |
| `index.css` token system | working but dark | replace tokens, keep the approach |

## 2. Decisions

### D-1 The shell renders before the session gate

`App.tsx` currently returns `<Login/>` *before* `<Routes>` when signed out, which makes any public
route unreachable. That is why there is no landing page today.

Restructured: the router renders unconditionally. `/` and `/login` are public; everything else is
wrapped in a guard component that redirects. This is the minimum change that makes public routes
possible, and it keeps the session state machine (`checking | signed-in | signed-out`) that already
works.

### D-2 Role comes from the token, scope comes from the API

`auth.getRole()` decodes `cognito:groups` exactly as the existing `getMemberOrganizations()` does.

Role gates *navigation*. It does not gate data: the API resolves team scope from DynamoDB and will
refuse an out-of-scope request whatever the UI believed. So every screen handles 403 as a normal
outcome rather than an impossible one — a member removed from a team mid-session gets a clear
refusal, not a blank page.

### D-3 Demo access via a server-held secret

Requirements: real Cognito, no credentials in the browser, no bypass.

```
Browser → POST /demo/session  (no auth, no body)
              ↓
          Lambda reads DEMO_PASSWORD from its environment
              ↓
          AdminInitiateAuth for the ONE fixed demo username
              ↓
          returns { id_token, access_token, expires_in, organization_id }
              ↓
Browser stores the token the same way the SRP flow does
```

The username is a server-side constant, not a parameter, so the endpoint cannot be turned into an
oracle for other accounts. The demo identity is `TEAM_MEMBER` in the demo organization with no
infrastructure permissions.

`ADMIN_NO_SRP_AUTH` is required on the user-pool client for `AdminInitiateAuth` to work. That is a
real widening of the client's auth flows, so it is enabled deliberately and noted here: the flow is
only reachable through this one Lambda, which never accepts a username.

If `DEMO_PASSWORD` is unset the endpoint returns a clear "demo access is not configured" error and
the login page hides the demo action. A deployment without demo credentials degrades honestly
instead of offering a button that fails.

### D-4 One aggregate call per screen

The backend already aggregates: `/command-center`, `/events/{id}/brief`, `/events/{id}/attention`,
`/events/{id}/workload` each return a composed view. The frontend calls one of those per screen
rather than assembling from primitives, so the numbers on screen are the numbers the backend
computed and two views cannot disagree.

The old `TaskBoard` fanned out six requests and flattened them client-side. `GET
/events/{id}/tasks` now exists and replaces that.

### D-5 Slack is absent, not stubbed

No Slack surface is rendered. A disabled button or a "coming soon" card would be a claim about
roadmap in the product's own voice, and the brief is explicit that a placeholder must not read as
integration.

The contract it would need, recorded so the next implementer starts from a spec:

```
Backend:  connector with workspace token in Secrets Manager
          EventBridge rule on communityops.audit → Slack dispatch Lambda
          notification policy: which actions notify which channel
          signed deep link back to the approval
Frontend: connection status from a real config read, not a constant
```

### D-6 No dead social buttons

`SupportedIdentityProviders: [COGNITO]`, no user-pool domain, no callbacks. Rendering
"Continue with Google" would be a button that cannot work.

The login page states that email sign-in is the configured method. Enabling a provider requires:
a `UserPoolDomain`, an `AWS::Cognito::UserPoolIdentityProvider` with a client id and secret from the
provider, `CallbackURLs`/`LogoutURLs` on the client, `AllowedOAuthFlows`, and the secret in Secrets
Manager. None of that is committable without real provider registration.

### D-7 AttendeeOps gets a thin route over existing aggregation

`AttendeeState` already computes every figure AttendeeOps needs, and `get_attendee_summary` already
shapes it for the agent. The new `GET /events/{eventId}/attendees` reuses both rather than
recomputing, so the screen, the agent and the health engine cannot disagree about how many
registrations are missing dietary details.

It is added to `operations_handler`, which already owns the read-only aggregate views and already has
the snapshot loader wired.

## 3. Design system

### Palette — light, warm, restrained

```
--bg            #F8F7F4   warm off-white   page
--surface       #FFFFFF   white            cards
--surface-sunk  #F3F2EE                    wells, code, thread background
--border        #E5E3DC   soft neutral
--border-strong #D3D0C7                    inputs, dividers that must read

--primary       #0F6F5C   deep teal-green  community + operations
--primary-hover #0B5949
--primary-soft  #E6F2EF                    tinted backgrounds

--text          #1C1B19   deep charcoal
--text-muted    #5F5C55
--text-subtle   #8A867D

--handled       #0F6F5C   same as primary — handled is the good state
--attention     #B4690E   restrained amber
--risk          #A72B20   restrained red
--info          #2C5A8A
```

Status colours are muted on purpose. A screen where every badge is saturated has no hierarchy, and
the dominant decision has to be able to out-shout everything else.

Each status ships as a **triple**: a `--status-x` colour, a `--status-x-bg` tint and a `.badge-x`
rule. The existing codebase interpolates class names (`badge-${status}`), so a colour without a
matching class silently renders unstyled.

### Type scale

```
display   32/38  600   marketing statements only
title     22/28  600   page title
section   15/20  600   section heading, uppercase, tracked
card      15/20  600   card title
body      14/21  400
meta      13/18  400   secondary
label     11/14  600   uppercase, tracked, badges and field labels
mono      13     400   identifiers, amounts in tables
```

One family: system UI stack, as now. Numbers use tabular figures so columns of rupees align.

### Spacing, radius, shadow

Spacing `4 8 12 16 24 32 48 64` as CSS variables. Radius `6 / 10 / 14` plus `999` for pills. Two
shadows only: a hairline card lift and a drawer/modal lift. No blur effects.

### Grid

`.page` is `max-width: 1160px`, horizontal padding `32px` desktop / `16px` mobile, one vertical
rhythm. Every screen uses it, which is what makes the set feel like one product rather than eight
templates.

## 4. Component inventory

Shared, in `apps/web/src/components/`:

```
AppShell        sidebar + topbar + <Outlet/>
PageHeader      title, subtitle, one optional primary action
Card            surface, optional header, optional footer
StatusBadge     the shared status vocabulary, label + colour
DecisionCard    the dominant "needs your decision" surface
Drawer          right slide-over; full-screen under 768px; Escape closes; focus trapped
Skeleton        block, line, card variants
EmptyState      icon, headline, optional action
ErrorState      user-readable message + Try again
Stat            one figure with a label
Progress        bar for budget utilization and funnel stages
Tabs            keyboard-navigable
Confirm         destructive/consequential confirmation
AgentChat       the operations chat panel
Constellation   the Command Center event visual
```

### Status vocabulary — one set, used everywhere

```
handled            Handled              teal
needs-decision     Needs your decision  amber, the only status that reads as urgent-and-actionable
pending            Pending              neutral
blocked            Blocked              red
overdue            Overdue              red
at-risk            At risk              amber
completed          Completed            muted
cannot-automate    Cannot be automated   neutral with an explanatory affordance
```

Canonical action labels: **Approve / Edit / Decline**. Never Accept/Modify/Reject.

## 5. Per-screen visual metaphor

Exactly one each, and each must carry information:

| Screen | Metaphor |
|---|---|
| Command Center | constellation — events as nodes, size by scale, ring by health |
| SpeakerOps | lifecycle progression |
| TeamOps | coordination grid, teams needing attention foregrounded |
| AttendeeOps | readiness funnel |
| IncidentOps | severity-ordered risk list with a state track |
| Check-In | verification gate, the existing stepper |
| Approvals | decision queue, one focused at a time |
| Audit | timeline |

## 6. API surface used

All through `api.ts`. New wrappers added for routes that already exist but were unused:

```
getCommandCenter        GET  /command-center
getAttention            GET  /events/{id}/attention
getBrief                GET  /events/{id}/brief
getWorkload             GET  /events/{id}/workload
getEventHealth          GET  /events/{id}/health
getEvents / getEvent    GET  /events, /events/{id}
getTeams / getTeam      GET  /events/{id}/teams(/{teamId})
getEventTasks           GET  /events/{id}/tasks
updateTask              PUT  /events/{id}/teams/{teamId}/tasks/{taskId}
reassignTask            POST .../reassign
getSpeakers             GET  /events/{id}/speakers
draftSpeakerFollowup    POST /events/{id}/speakers/{id}/followup
getIncidents/getIncident GET /events/{id}/incidents(/{id})
addIncidentComment      POST /events/{id}/incidents/{id}/comments
resolveIncident         POST .../resolve
updateIncident          PUT  /events/{id}/incidents/{id}
getApprovals/getApproval GET /events/{id}/approvals(/{id})
decideApproval          PUT  /events/{id}/approvals/{id}
getBudget               GET  /events/{id}/budget
projectBudget           POST /events/{id}/budget/projection
getAttendees            GET  /events/{id}/attendees        ← new backend route
getAuditLog             GET  /events/{id}/audit
agentChat               POST /agent/chat
getAgentCapabilities    GET  /agent/capabilities
getAgentActivity        GET  /agent/activity
startDemoSession        POST /demo/session                 ← new backend route
```

## 7. Backend changes this design requires

Deliberately minimal — two routes and a script. No existing behaviour is modified.

1. `GET /events/{eventId}/attendees` in `operations_handler`, reusing `AttendeeState`.
2. `POST /demo/session` in a new `demo_handler`, public (`Authorizer: NONE`), fixed username,
   `AdminInitiateAuth`, password from environment.
3. `ADMIN_NO_SRP_AUTH` added to the user-pool client, reachable only through that Lambda.
4. `scripts/setup-demo-users.py` — groups plus three identities, passwords from environment or
   generated and printed once, never committed.
5. Tests for both routes, including that the demo endpoint refuses when unconfigured and that the
   attendee route enforces scope.

## 8. Testing

`apps/web` has no DOM test environment today — Vitest runs in node, with no `jsdom`, no
`@testing-library`. Component tests require adding `jsdom`, `@testing-library/react`,
`@testing-library/jest-dom`, `@testing-library/user-event` and a `test` block in `vite.config.ts`.

Coverage targets the behaviour that would actually break:

| Area | Test |
|---|---|
| api client | new wrappers thread `organization_id`; mock mode stays opt-in |
| auth | role derived from groups; leader vs member; malformed token fails closed |
| routing | public landing reachable signed out; guard redirects; member refused leader route |
| Command Center | loading, error, empty, populated; the dominant decision is the right one |
| Approvals | decide → the response's budget figure is displayed, not a computed one |
| Incidents | comment posts and appears; agent and human authors distinguished |
| Tasks | status update sends the right payload and refreshes |
| Agent chat | send/receive; approval-gated reply renders as prepared, not done |
| StatusBadge | every status has a class, so none renders unstyled |
