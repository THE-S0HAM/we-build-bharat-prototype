# CommunityOps — Community Operations Platform Requirements

## Overview

CommunityOps is an AI Community Operations Agent. It is not an event-registration
platform and not a dashboard with a chatbot attached. It is an operations teammate
for a community leader.

> Your event does not need another dashboard. It needs an operations teammate.

The agent observes operational state, reasons about it, identifies risk, plans work,
creates and assigns tasks, executes low-risk actions, requests human approval for
consequential actions, verifies results, and audits everything.

The leader remains the decision-maker.

## Fundamental constraints

These are non-negotiable and every requirement below inherits them.

| # | Constraint |
|---|-----------|
| C-1 | Deterministic systems establish facts. Transactional truth (payment captured, budget remaining, task status, registration exists) comes from DynamoDB, never from an LLM. |
| C-2 | The LLM reasons about facts it was given by tools. It never receives raw database access. |
| C-3 | Every agent tool enforces authorization against the calling principal before returning or mutating data. |
| C-4 | Policy decides authority. Unknown or high-risk actions fail closed to "requires approval". |
| C-5 | Consequential actions (financial, irreversible, external communication, speaker confirmation) require human approval. |
| C-6 | `organization_id` is the tenant boundary and the DynamoDB partition key. Cross-tenant access is denied at the authorizer, the handler, the tool, and the key. |
| C-7 | Every meaningful action produces an audit record. |
| C-8 | Prompt content can never widen a principal's authorization. |

## Roles

Two roles, carried as Cognito groups and resolved into a `Principal`.

### LEADER

Organization-wide operational authority for the events in their organization.

May: create/edit/archive/duplicate events; drive event lifecycle; manage teams and
members; create/assign/reassign/complete any task; manage speakers; view attendee
operations; verify transactions and generate/revoke tickets; approve, edit or reject
approval requests; allocate budget and record expenses; review and act on AI
recommendations; run the agent chat at organization scope; view audit logs; view and
recalculate event health; acknowledge/assign/escalate/resolve/reopen incidents;
trigger workflows and the demo simulation; upload event documents; read notifications.

### TEAM_MEMBER

Authorized scope only: the events they are assigned to, their own teams, and tasks
assigned to them or owned by their teams.

May: see assigned events; see their teams and teammates; see assigned tasks; update
task status; submit task completion; report incidents; comment on incidents in their
scope; view speaker/attendee information relevant to their responsibility; request
approvals; submit expense requests; run the agent chat at their scope; receive
reminders; see their own workload.

May not: approve anything, allocate budget, record expenses directly, manage teams or
members, create or edit events, generate or revoke tickets, view the organization
audit log, or read data for teams and events outside their scope.

### Public demo identity

A `TEAM_MEMBER` in an isolated demo organization. No AWS credentials, no admin
privileges, no access to other tenants.

## Functional requirements

### FR-1 Authentication and role routing

- Sign-in through Amazon Cognito using SRP; the ID token authorizes API Gateway.
- Role derived from the `cognito:groups` claim. Group names prefixed `ORG-` are
  organization memberships; `LEADER` and `TEAM_MEMBER` are roles.
- The console routes by role: leader panel vs team panel. Admin-only controls are not
  rendered for team members, and the API independently rejects them.
- Identity providers that are not configured in this environment (Google, Amazon,
  Apple, AWS Builder ID) are shown as explicitly unavailable rather than faked.

**Acceptance:** a `TEAM_MEMBER` token calling a leader-only route receives 403 from the
API even when the UI control is bypassed.

### FR-2 Event management

- Leader can create, read, update, archive and duplicate events.
- Fields: name, description, date, start/end time, venue, city, expected attendees,
  registration target, total budget, status, risk status, tags.
- Lifecycle: `DRAFT → PUBLISHED → ACTIVE → COMPLETED`, plus `PAUSED` and `ARCHIVED`.
- On request ("prepare this event") the agent generates an operational plan: teams,
  tasks with deadlines and dependencies, an operational checklist, and the approvals
  the plan will require. The plan is reviewed by the leader before any consequential
  action executes.

**Acceptance:** creating an event then asking the agent to prepare it produces teams
and tasks that are readable back through the API, and no approval-gated action has
executed.

### FR-3 Team management

- Eight default operational teams: Marketing, Registration, Speaker Management,
  Venue & Logistics, Sponsorship, Technical, Volunteer Coordination, Attendee
  Experience.
- Each team has a lead, members, responsibilities, assigned tasks, workload, progress,
  overdue count, blocked count and a derived risk level.
- Leader can create/edit teams, add/remove members, assign a lead, and reassign tasks.
- `member_count` is maintained by the write path, not recomputed on read.

**Acceptance:** adding a member increments the team's member count atomically and is
visible in the team workload summary.

### FR-4 Task management

- Lifecycle: `BACKLOG → ASSIGNED → IN_PROGRESS → BLOCKED → REVIEW → COMPLETED`, plus
  `CANCELLED`. `OVERDUE` is derived from `due_date`, not stored as a competing status.
- Fields: title, description, event, team, assignee, priority, risk, status, deadline,
  dependencies, estimated effort, created by, timestamps.
- Leader manages all tasks in the organization. A team member may update only tasks
  assigned to them or belonging to their teams, and may not reassign across teams.

**Acceptance:** a team member updating another team's task receives 403.

### FR-5 AI task automation

- The agent detects overdue tasks, identifies the owner, compares team workload,
  drafts a reminder, and queues it according to policy.
- The agent may recommend reassignment with evidence ("T-124 overdue 8h; Rahul has 11
  active tasks, Priya has 4").
- Creating an internal task and sending an internal reminder are auto-authorized.
  Reassignment of a consequential task and any external message require approval.
- The leader can approve, edit or decline every recommendation.

**Acceptance:** an agent-initiated external speaker message never leaves the system
without an approved `Approval` record.

### FR-6 Speaker management

- Track status (`INVITED`, `RESPONDED`, `CONFIRMED`, `PENDING`, `DECLINED`, `AT_RISK`),
  topic, availability, travel origin, accommodation requirement and nights, estimated
  travel and accommodation cost, session time, requirements, and communication history.
- The agent detects: no response beyond 72 hours, missing availability, missing travel
  information, accommodation requirement, topic mismatch, budget conflict — and
  produces a recommended action.
- `CONFIRM_SPEAKER`, `SEND_EXTERNAL_SPEAKER_MESSAGE` and `ACCOMMODATION_COMMITMENT`
  require approval.

**Acceptance:** a speaker silent for more than 72 hours appears in the attention list
with a prepared follow-up draft that has not been sent.

### FR-7 Ticket generation (admin)

- Flow: registration → payment/transaction verification → admin verifies transaction →
  generate ticket → `ticket_id == registration_id` → signed QR → stored in S3 →
  provided to the attendee.
- The admin can search registrations, view payment details, verify a transaction,
  generate a ticket, safely regenerate, view the ticket, verify a QR, and revoke where
  policy allows.
- Payment status is read from the payment record. The LLM never asserts payment state.
- Regeneration is idempotent: it refreshes the download URL and increments a counter
  rather than minting a second identity.

**Acceptance:** generating a ticket twice yields one ticket record with
`generated_count = 2`.

### FR-8 Attendee operations

- Aggregate: total registered, checked in, not checked in, accommodation required,
  breakfast/lunch counts, dietary requirements, missing information, arrival conflicts.
- The agent identifies missing data, segments attendees, prepares communication,
  requests approval when the communication is external, tracks response, and updates
  operational state.

**Acceptance:** the attendee summary numbers are computed from registration and
attendee records, and the same numbers appear in the agent's answer.

### FR-9 Incident management

- A team member can report an incident with title, description, event, team, severity
  (`LOW|MEDIUM|HIGH|CRITICAL`), category, and reporter.
- Lifecycle: `REPORTED → ACKNOWLEDGED → ANALYZING → RECOMMENDATION_READY →
  AWAITING_APPROVAL → EXECUTING → RESOLVED → CLOSED`, plus `REOPENED` and `ESCALATED`.
- Admin actions: acknowledge, assign, escalate, create task, request approval, resolve,
  reopen, close.
- Resolving records resolution summary, root cause, actions taken, resolver and time,
  and writes an audit event.

### FR-10 Incident discussion

- Every incident has a threaded discussion: author, author role, team, timestamp, body,
  optional parent comment, optional attachment reference, and an author type that
  distinguishes human from agent.
- A task or an approval can be created directly from a discussion comment and links
  back to it.
- The agent posts analysis into the thread as an identified agent author.

**Acceptance:** creating a task from a comment produces a task whose `source_comment_id`
resolves back to the originating comment.

### FR-11 Incident AI assistance

- For an incident the agent produces: impact, affected resources, dependencies, and
  ranked recommended actions, each annotated with whether it requires approval.
- The agent must not resolve a `HIGH` or `CRITICAL` incident autonomously.

### FR-12 Approval center

- Each approval carries: requested action, requester, event, reason, risk level,
  amount and currency where financial, budget impact, agent recommendation, evidence,
  and status.
- Leader can approve, edit or reject. Only `PENDING` approvals are decidable.
- Deciding an approval rewrites the status-bearing index key so listings stay correct.

### FR-13 Budget management

- Per event: total budget, allocated, spent, committed, remaining, utilization percent.
- Categories: Venue, Catering, Speaker Travel, Accommodation, Equipment, Marketing,
  Certificates, Transportation, Emergency, Other.
- Per category: allocated, spent, committed, remaining, utilization.
- Amounts are stored as integer rupees. No floating point money.

### FR-14 Budget allocation

- The leader allocates budget to categories.
- The sum of allocations may not exceed the event total budget. The check is enforced
  by a conditional write, not by a read-then-write race.

**Acceptance:** two concurrent allocations that would jointly exceed the total budget
result in one success and one `CONFLICT`.

### FR-15 Approval to budget automation

- Approving a financial request deterministically moves the amount into `committed` and
  reduces `remaining`, recalculates utilization, and writes an audit event.
- Recording an expense moves an amount from `committed` (or directly from `remaining`)
  into `spent`.
- The backend performs the arithmetic. The agent may explain and predict, never decide.

**Acceptance:** approving a ₹12,500 accommodation request against ₹75,000 remaining
yields exactly ₹62,500 remaining and ₹12,500 committed, and the agent reports the same
figures because it reads them back.

### FR-16 Budget agent queries

The agent answers "how much remains", "how much have we spent", "which category has the
highest utilization", "can we afford this ₹20,000 request", "what happens if I approve
X", "show budget risks", "prepare a budget summary", "which approvals have financial
impact" — each from retrieved budget state, with the figures traceable to the API.

### FR-17 Event health engine

- Deterministic score producing `GREEN | YELLOW | ORANGE | RED`.
- Inputs: overdue tasks, blocked tasks, pending speaker confirmations, unresolved
  incidents weighted by severity, approval age, budget utilization, deadline proximity,
  attendee data completeness.
- The output includes the contributing reasons and each reason's weight so the score is
  explainable.
- The LLM may explain the score. It may not determine it.

**Acceptance:** the same operational state always produces the same score, and the
reasons list accounts for the score.

### FR-18 Operations brief

- One action produces today's brief: decisions required, high-risk items, work
  progressing automatically, overdue tasks, incidents needing attention, budget
  remaining, speaker status, and a recommended priority order.
- Every number comes from operational state.

### FR-19 Document support

- Upload and retrieve PDF, DOC/DOCX, XLS/XLSX and TXT via S3 using pre-signed URLs.
- Metadata: eventId, documentId, filename, content type, size, uploadedBy, uploadedAt,
  category.
- The agent can list and filter documents by event and category and return their
  metadata and a download link. Full-text retrieval-augmented search is **not**
  implemented and must not be presented as if it were.

### FR-20 Policy model

| Action | Authority |
|---|---|
| `CreateInternalTask` | AUTO |
| `AssignTask` | AUTO within authorized scope |
| `SendInternalReminder` | AUTO |
| `GenerateDraft` | AUTO |
| `ReadOperationalState` | AUTO |
| `SummarizeData` | AUTO |
| `SendExternalSpeakerMessage` | APPROVAL |
| `ConfirmSpeaker` | APPROVAL |
| `ApproveExpenditure` | APPROVAL |
| `AccommodationCommitment` | APPROVAL |
| `FinancialCommitment` | APPROVAL |
| `AllocateBudget` | APPROVAL |
| `ResolveIncident` | APPROVAL |
| `RevokeTicket` | APPROVAL |
| `ContractSigning` | NEVER_AUTONOMOUS |
| unknown | APPROVAL (fail closed) |

`NEVER_AUTONOMOUS` actions are refused by the agent even when an approval exists; only
a human acting directly may perform them.

### FR-21 Audit log

Every record carries timestamp, organizationId, eventId, actor, actorType, action,
target, reason, riskLevel, approvalRequired, approvalId, result.

### FR-22 Notification center

Notifications for: new approval, task assignment, overdue task, incident, agent
recommendation, speaker response, budget warning. Each is addressed to a user or a
role, carries a read state, and deep-links to the thing it is about.

### FR-23 Demo simulation

A leader-triggered, deterministic sequence that visibly demonstrates
observe → detect → reason → recommend → approval → execute → verify → audit:
speaker response received, task becomes overdue, venue incident appears, catering
deadline approaches, risk recalculated, approval requested, leader approves, budget
updates, incident resolved, health improves. Each step writes real records.

### FR-24 Fun Mode

An optional light Hindi/Bollywood-flavoured tone for internal encouragement only.
Off by default, per-user. Never applied to financial, legal, security or external
communication content, and never allowed to alter operational figures.

### FR-25 Demo data

One fully populated demo event whose data tells a story: a confirmed speaker, a silent
speaker, one needing accommodation, one whose travel estimate exceeds its allocation;
teams with differing health; a constrained but healthy budget; pending, approved and
rejected approvals; one active HIGH incident with discussion, one resolved, one low
priority.

## Non-functional requirements

| # | Requirement |
|---|---|
| NFR-1 | No N+1 query fan-out where a single query or batch read suffices. Aggregations read once per entity family per event. |
| NFR-2 | List endpoints paginate and return a cursor rather than silently truncating. |
| NFR-3 | No secrets in source. QR signing key and demo passwords come from configuration. |
| NFR-4 | PII is masked in logs and minimized in model prompts. |
| NFR-5 | Least-privilege IAM per Lambda. |
| NFR-6 | Backend and frontend tests cover every feature added, and the suites pass. |
| NFR-7 | `sam validate --lint` and `sam build` succeed. |
| NFR-8 | Documentation describes only what is implemented. |

## Out of scope

Retrieval-augmented generation over documents; real payment gateway integration; real
email or WhatsApp delivery; external registration platform connectors beyond the
existing abstraction; mobile applications; Amazon Verified Permissions as the runtime
Cedar engine.
