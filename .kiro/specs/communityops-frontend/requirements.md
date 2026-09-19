# CommunityOps Frontend — Requirements

## Purpose

Turn the verified backend into a product a community leader would actually keep open. The backend
already knows what needs attention; the frontend's job is to make that obvious in five seconds and
to keep consequential decisions visibly human.

The screen must answer one question before any other:

> Does anything actually need me?

Not "how many metrics can I show".

## The distinction the UI exists to make

Every leader-facing surface classifies operational state into exactly three buckets:

| State | Meaning | Visual weight |
|---|---|---|
| **Handled** | CommunityOps did it. No action available or needed. | Quiet, aggregated, countable |
| **Needs your decision** | A consequential action is prepared and waiting on a human. | Dominant, singular, actionable |
| **Cannot be automated** | Outside autonomous authority under any approval. | Explicit, explained, never a button |

A screen that renders these three with equal weight has failed, regardless of how much data it
displays correctly.

## Source of truth

The backend is authoritative. Where this document and the running API disagree, the API wins and
this document is wrong and gets corrected.

No UI element may imply a capability the backend will reject. Concretely: if the agent's tool
catalogue withholds `record_expense` from a team member, the team member's interface must not offer
an equivalent path.

## Scope decisions taken from discovery

Discovery against the repository (73 API routes, `template.yaml`, `apps/web/src`) established three
gaps that cannot be closed in the frontend:

### FR-G1 AttendeeOps has no REST contract

`services/shared/aggregate.AttendeeState` computes the full attendee operational picture and the
agent reaches it through `get_attendee_summary`, but no HTTP route exposes it. The frontend cannot
render AttendeeOps without one.

**Required backend change:** `GET /events/{eventId}/attendees` returning the existing
`AttendeeState` projection plus the exception lists a leader can act on. No new aggregation logic —
the computation already exists and must not be duplicated.

### FR-G2 Demo access has no safe mechanism

Cognito exists with SRP email/password, and there is no demo identity, no bootstrap, and no way for
a judge to enter without credentials. Hardcoding credentials in the frontend is prohibited
(§53 of the brief), and so is bypassing Cognito.

**Required backend change:** a public `POST /demo/session` endpoint that performs a real Cognito
`AdminInitiateAuth` for one fixed, restricted demo identity using a secret held server-side, and
returns the resulting tokens. The browser never receives a password. The endpoint may only ever
authenticate that one identity — the username is not a parameter.

Plus `scripts/setup-demo-users.py` to create the Cognito groups and the three demo identities with
passwords supplied by environment or generated and printed once.

### FR-G3 Slack is not implemented

No Slack code, configuration, connector or credential exists anywhere in the repository. The brief
describes Slack as the attention layer.

**Decision:** not implemented, and not faked. The UI shows no Slack surface at all — not a
disconnected button, not a "coming soon" panel. `design.md` records the contract it would need.

The existing `Notification` domain is *not* promoted into a second notification product to
compensate (§32). Notifications remain a supporting read model used where a specific user needs to
know a specific thing; they do not become an inbox the leader is expected to process.

### FR-G4 Federated identity providers are not configured

`UserPoolClient.SupportedIdentityProviders` is `[COGNITO]`. There is no user-pool domain, no
callback URLs, no `AWS::Cognito::UserPoolIdentityProvider`. Google, Amazon and Apple sign-in cannot
be made real without provider registration and client secrets, which are not available and must not
be committed.

**Decision:** the login page does not render dead social buttons. It states plainly that email
sign-in is the configured method. `design.md` records what enabling a provider requires.

## Functional requirements

### FR-1 Application shell

One shell, used by every authenticated screen. Sidebar grouped by operational concern, not by
entity type:

```
Command Center
OPERATIONS   SpeakerOps · TeamOps · AttendeeOps · IncidentOps
EVENT DAY    Check-In
GOVERNANCE   Approvals · Audit Log
```

Top bar carries event context, role, and a restrained count of waiting decisions. The sidebar is
navigation, not a second dashboard: no charts, no health badges per item, no activity feed.

**Acceptance:** every page renders inside the same shell with identical page margins, heading
position and grid. No page introduces its own layout.

### FR-2 Authentication and role routing

- Email/password through the existing Cognito SRP flow. The working implementation in `auth.ts` is
  extended, not replaced.
- Role derived from the `cognito:groups` claim, using the same JWT-decode approach as the existing
  `getMemberOrganizations()`.
- A leader reaches the leader shell; a team member reaches a workspace scoped to their teams.
- Route guards are a convenience, not the control. The API independently rejects out-of-scope
  requests, and the UI must handle that rejection gracefully rather than assuming it cannot happen.

**Acceptance:** a team member navigating directly to a leader-only route sees a clear refusal, and
the API returns 403 for the underlying call regardless of what the UI did.

### FR-3 Demo access

A single action on the login screen enters the product as the restricted demo identity, through real
Cognito. The demo workspace is visually identical to the real product apart from one quiet marker.
The demo user signs out normally.

**Acceptance:** no password appears in any frontend source, bundle, or network request initiated by
the browser. The demo session is obtained by calling the backend, which holds the secret.

### FR-4 Command Center

The most important screen. Structure, in order of visual weight:

1. **Context line** — a human sentence stating how many decisions need the leader.
2. **One dominant decision surface** — the single most consequential waiting decision, with its
   amount where financial, and `Approve / Edit / Decline`. Not a list. Not a recommendation card.
3. **Contextual visual** — event health as a simple constellation. It represents active events and
   where attention sits. It is not an architecture diagram.
4. **Handled summary** — compact counts of what the agent dealt with, aggregated, not itemised.
5. **Attention list** — the remainder, below the fold, ordered worst first.

When nothing needs the leader, the screen says so in plain language and does not fall back to an
analytics wall.

All values come from `GET /command-center` and `GET /events/{id}/attention`. No figure is computed
in React.

**Acceptance:** with the seeded demo data the page shows exactly the pending decision count the API
reports, and the dominant surface is the highest-severity financial approval.

### FR-5 Progressive disclosure

Default state answers *what happened* and *why it matters*. The agent's reasoning, evidence and
available actions appear on interaction — a drawer or an expandable row — never all at once.

Chain-of-thought is never rendered. Evidence is: the figures, the counts, the identifiers the
decision rests on.

### FR-6 SpeakerOps

Answers *which speakers need attention*. The list shows name, topic, status and follow-up count
only. Everything else — contact, travel, accommodation, cost, session, communication history — is in
the detail drawer.

Lifecycle is shown as progression: Identified → Invited → Awaiting → Follow-up → Confirmed.

Drafting a follow-up is available inline. Sending it is not: that is approval-gated and the UI says
so rather than offering a Send button that will fail.

### FR-7 TeamOps

Answers *which teams are healthy, blocked or drifting*. Opens with team-level state, not a task
dump. Only teams needing attention are prominent; healthy teams collapse to a line.

Selecting a team reveals its tasks. Task counts, overdue, blocked and workload-per-member all come
from `GET /events/{id}/teams` and `GET /events/{id}/workload`.

### FR-8 AttendeeOps

Depends on FR-G1. Answers *how ready are attendees operationally* as a readiness funnel —
registered → verified → information complete → event-ready — with the exception lists surfaced:
missing dietary details, accommodation gaps, unconfirmed arrivals.

Aggregates only. No attendee CRM, no individual attendee records beyond what an exception requires.

### FR-9 IncidentOps

Answers *what could disrupt the event*. Severity, affected resource, current state, next action. The
agent's recommendation is behind a disclosure, not presented as a standing card.

### FR-10 Incident discussion

Real threaded discussion against `POST/GET /events/{id}/incidents/{id}/comments`. Human and agent
authors are visually distinguished. A task can be created from a comment in one action, and the
resulting task links back to it.

### FR-11 Incident resolution

Only the transitions the API supports are offered. Resolution captures summary, root cause and
actions taken, and the resulting change in event state is shown.

### FR-12 Check-In

Event-day workflow answering *can this attendee enter*. The existing stepped flow is kept and
restyled. Payment truth is deterministic and read from the verification response; no agent
involvement.

### FR-13 Approvals

Answers *what decisions are waiting for me*. Each item states what, why, the risk, and the action.
Language attributes preparation to the agent and the decision to the human: "CommunityOps prepared
this action", never "CommunityOps decided".

Edit is implemented because the backend supports `decision=EDITED` with `edited_action`.

After a decision: "Decision recorded. CommunityOps will continue from here."

### FR-14 Budget

Shows total, allocated, spent, committed, remaining and utilization, with the category breakdown,
all from `GET /events/{id}/budget`. No money arithmetic in React.

The critical interaction: approving a ₹12,500 request against ₹75,000 remaining displays ₹62,500 —
because the approval response carries the recomputed budget, not because the frontend subtracted.

### FR-15 Audit log

Answers *what happened*, as a timeline distinguishing agent from human actors. Never renders
secrets, stack traces, AWS identifiers or unnecessary PII.

### FR-16 Agent chat

The leader talks to CommunityOps. Uses `POST /agent/chat` and the existing 30-tool architecture; no
second agent implementation.

The interface shows which tools an answer relied on, because an answer whose sources are visible is
one a leader can check. Where a tool hit the approval gate, the reply says the action is prepared
and waiting — never that it was done.

Tool availability differs by role (30 vs 23) and the UI must not imply otherwise.

### FR-17 Fun Mode

Off by default, per-user, persisted locally. Adds occasional light Hindi-flavoured encouragement.
Never applied to money, approvals, incidents, security, or outbound text.

### FR-18 Loading, empty and error states

Every API-backed surface implements all four states with polished skeletons. Errors are
user-readable; raw Lambda, DynamoDB and AWS detail never reaches the screen.

Mock mode stays opt-in via `VITE_USE_MOCK` and is never a fallback for a failing backend, preserving
the existing invariant that fabricated operational data is never presented as real.

## Non-functional requirements

| # | Requirement |
|---|---|
| NFR-1 | Light theme only. No dark mode, no neon, no glassmorphism. |
| NFR-2 | One design system: tokens for colour, type, spacing, radius, shadow, z-index. No ad-hoc values in components. |
| NFR-3 | Spacing scale 4/8/12/16/24/32/48/64. One grid. Identical page margins everywhere. |
| NFR-4 | Status never communicated by colour alone — always a label, optionally an icon. |
| NFR-5 | One dominant element and one primary action per page. |
| NFR-6 | At most one major visual metaphor per screen. A visual that carries no operational information is removed. |
| NFR-7 | Responsive to mobile without horizontal overflow; drawers become full-screen; touch targets ≥ 44px. |
| NFR-8 | Keyboard navigable, visible focus, labelled controls, Escape closes overlays, contrast meets AA. |
| NFR-9 | No raw `fetch` in components. All network access through the typed client. |
| NFR-10 | Typecheck, lint, tests and build all pass with no suppressed failures. |

## Out of scope

Slack integration. Federated identity providers. Attendee record management beyond aggregates and
exceptions. Document content search. Real email or message delivery.
