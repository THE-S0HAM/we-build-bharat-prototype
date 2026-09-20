/**
 * Security surface of the whole console (design.md "Security", task 13.3).
 *
 * The other suites each guard one page. This one makes six claims about the
 * product as a whole, because every one of them is the kind of defect that
 * arrives through the page nobody thought to check:
 *
 *   1. **No rendered string leaks implementation detail** — every page, driven
 *      into failure by a backend error carrying a stack trace, an exception
 *      name, an ARN, an account id, a table name, a Lambda name, a request path
 *      and a request id, renders none of it (requirement 16.7, property 7).
 *   2. **Unmodelled fields are absent from the typed models** — `src/types.ts`
 *      declares no `task_token`, no `workflow_execution_id` and no
 *      `AuditEvent.details`, so no typed code can reach them (requirements
 *      16.5, 16.6).
 *   3. **…and absent from rendered output** — with all three present on every
 *      record the API returns, no page puts a key or a value in the DOM.
 *   4. **Mock data never returns on a real failure** — a failed request leaves
 *      the page in its error state with no rows, and none of `api.ts`'s mock
 *      fixtures on screen (requirement 13.10, property 3).
 *   5. **No component gates access on a client-side role or permission check**
 *      — authorization belongs to API Gateway and
 *      `tenancy.authorize_organization` (requirement 16.2).
 *   6. **No token is copied into application state, a URL or a log**
 *      (requirement 16.9).
 *
 * Claims 2, 5 and 6 are partly statements about source, not about a render: a
 * TypeScript interface is erased before a test could query it, and "no component
 * gates on a role" is a claim about every component including the ones not yet
 * written. Those are asserted by reading the text of every module under `src/`,
 * which is the same thing `scripts/check-design-values.mjs` does for design
 * values and for the same reason — the guard has to hold for code that does not
 * exist yet. The text comes from Vite's own `?raw` glob rather than from `fs`,
 * so the suite reads exactly the module graph the build compiles and needs no
 * knowledge of where the project sits on disk.
 *
 * Claims 1, 3 and 4 are rendered assertions, made against the real pages with
 * only `src/api.ts` and the Cognito boundary replaced.
 *
 * **Validates: Requirements 16.1, 16.2, 16.5, 16.6, 16.7, 16.9, 13.10**
 */

import type { ReactNode } from "react";
import { configure, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./api";
import { EventContext, type EventContextValue } from "./event/eventContext";
import { readStoredEvent, rememberEvent } from "./event/eventResolution";
import { rememberOrganization, resolveOrganization } from "./orgContext";
import { SessionContext, type SessionValue } from "./session/sessionContext";
import type {
  Approval,
  AuditEvent,
  CommandCenterData,
  Event,
  Incident,
  Registration,
  Speaker,
  Task,
  Team,
  VerificationCheck,
} from "./types";
import { AgentConsole } from "./pages/AgentConsole";
import { ApprovalCenter } from "./pages/ApprovalCenter";
import { AttendeeOps } from "./pages/AttendeeOps";
import { AuditLog } from "./pages/AuditLog";
import { Budget } from "./pages/Budget";
import { CheckinConsole } from "./pages/CheckinConsole";
import { VERIFICATION_CHECK_NAMES } from "./pages/checkin/checkinFlow";
import type {
  CheckinCompletion,
  CheckinService,
  VerificationOutcome,
} from "./pages/checkin/checkinService";
import { CommandCenter } from "./pages/CommandCenter";
import { IncidentCenter } from "./pages/IncidentCenter";
import { SpeakerOps } from "./pages/SpeakerOps";
import { TaskBoard } from "./pages/TaskBoard";

/**
 * The text of every module under `src/`, keyed by path.
 *
 * Eager and `?raw`, so the source-level guards below read the same files the
 * build compiles. `import.meta.glob` has to take a literal pattern, which is why
 * this sits at the top rather than inside the guard that uses it.
 */
const RAW_MODULES = import.meta.glob("./**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Seven pages, most of them rendered twice per claim. See a11y.pages.test.tsx. */
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

const EVENT_ID = "EVT-devcon-2026";

/* --- The stubbed boundaries ----------------------------------------------- */

const api = vi.hoisted(() => ({
  getCommandCenter: vi.fn(),
  getAttention: vi.fn(),
  getApprovals: vi.fn(),
  getAuditLog: vi.fn(),
  decideApproval: vi.fn(),
  getSpeakers: vi.fn(),
  getIncidents: vi.fn(),
  getTeams: vi.fn(),
  getTasks: vi.fn(),
  getEventTasks: vi.fn(),
  getWorkload: vi.fn(),
  getAttendeeOps: vi.fn(),
  getBudget: vi.fn(),
  getExpenses: vi.fn(),
  projectBudget: vi.fn(),
  getAgentCapabilities: vi.fn(),
  getAgentActivity: vi.fn(),
  agentChat: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();

  return { ...actual, ...api };
});

vi.mock("./auth", () => ({
  isAuthConfigured: true,
  isSignedIn: () => Promise.resolve(true),
  getSignedInUser: () => Promise.resolve(null),
  isDemoSession: () => false,
  signIn: () => Promise.resolve(),
  signOut: () => undefined,
  getIdToken: () => Promise.resolve(null),
}));

/* --- The leak the backend can hand us ------------------------------------- */

/**
 * One failure carrying every item requirement 16.7 enumerates: a DynamoDB
 * exception name, a Python traceback frame with a source path and a line number,
 * a Lambda ARN with a twelve-digit account id, a table name, the request path
 * and a request id.
 *
 * Not invented for the test — this is the shape `boto3` raises through a Lambda
 * handler, which is what `err.message` would carry if a handler ever returned
 * its exception text.
 */
const LEAKY_MESSAGE =
  "DynamoDBClientError: ValidationException raised by " +
  "arn:aws:lambda:ap-south-1:123456789012:function:CommunityOps-ApprovalsHandler " +
  "while reading table communityops-approvals-prod. " +
  "Traceback (most recent call last): at Runtime.handler (/var/task/approvals_handler.py:142) " +
  "path=/events/EVT-devcon-2026/approvals requestId=3f9c1b8a-77de-4f21-9a6c-5e0b2d41c7aa. " +
  // `api.ts`'s own fallback wording when a failed response carries no message,
  // so the battery covers the string this client can produce as well as the
  // string the backend can.
  "Request failed (HTTP 500)";

function leakyFailure(status = 500): ApiError {
  const error = new ApiError(LEAKY_MESSAGE, status, "DYNAMODB_ERROR");

  // A thrown Error carries a stack whether or not anyone asked for one. Pinning
  // it here means the assertion covers the stack as well as the message.
  error.stack = `DynamoDBClientError: ${LEAKY_MESSAGE}\n    at Runtime.handler (/var/task/approvals_handler.py:142)`;

  return error;
}

/**
 * What must never appear in a rendered string. Each entry names the item of
 * requirement 16.7 it stands for, so a failure says which guarantee broke.
 *
 * Matched against `textContent`, which is what a user and a screen reader
 * actually receive.
 */
const FORBIDDEN_IN_RENDERED_TEXT: readonly (readonly [string, RegExp])[] = [
  ["exception name", /\b\w*(?:Error|Exception)\b/],
  ["stack frame", /\bat\s+\S+\s*\([^)]*:\d+\)/],
  ["traceback marker", /traceback/i],
  ["source file path", /\/var\/task|\.py\b|\.tsx?\b/i],
  ["AWS ARN", /arn:aws/i],
  ["AWS account id", /\b\d{12}\b/],
  ["AWS service name", /\b(?:dynamodb|lambda|cloudwatch|apigateway|execute-api|boto3)\b/i],
  ["table name", /communityops-[a-z-]+/i],
  ["request path", /\bpath=|\/events\/[A-Z]/],
  ["request id", /request[\s_-]?id/i],
  ["uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["HTTP status code", /\bHTTP\s*\d{3}\b/i],
];

/**
 * Key names distinctive enough that finding one anywhere in the markup — text,
 * attribute or class — is by itself a leak. The Step Functions handles the
 * approvals endpoint passes through (A8).
 *
 * `details` is deliberately not on this list. It is the third unmodelled field
 * (A11), but "details" is also the canonical word for the affordance that opens
 * a record — "View details" (design.md §15.2) — so the bare string appears on
 * nearly every page as reviewed copy. What is asserted for `details` instead is
 * its serialized key shape and, definitively, its values.
 */
const UNMODELLED_KEYS = ["task_token", "workflow_execution_id"] as const;

/**
 * `details` in a key position: a JSON key, or an object literal's property. The
 * label "Details" above a table column matches none of these.
 */
const SERIALIZED_DETAILS_KEY = /["']details["']\s*:|\bdetails\s*:\s*[{["']/i;

/** Values placed behind those keys, distinctive enough to find anywhere. */
const UNMODELLED_VALUES = {
  task_token: "AAAAKgAAAAIAAAAAAAAAAeUnmodelledTaskTokenSentinel",
  workflow_execution_id: "arn:aws:states:ap-south-1:123456789012:execution:sentinel:1",
  details: { prompt: "UnmodelledDetailsSentinel", pii_email: "sentinel@example.com" },
} as const;

/** Adds all three to any record, the way the endpoints actually return them. */
function withUnmodelledFields<T>(record: T): T {
  return { ...record, ...UNMODELLED_VALUES } as T;
}

/**
 * An ID token carrying the given claims, in the three-segment shape the real one
 * has. Unsigned — nothing in the browser verifies one, and the token-handling
 * rule this suite checks is about where the string goes, not what it says.
 */
function tokenFor(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `header.${payload}.signature`;
}

/* --- Fixtures ------------------------------------------------------------- */

const ACTIVE_EVENT: Event = {
  event_id: EVENT_ID,
  name: "DevCon Bengaluru 2026",
  description: "The largest developer gathering in South India",
  status: "ACTIVE",
  venue: "NIMHANS Convention Centre",
  city: "Bengaluru",
  start_date: "2026-10-15T09:00:00Z",
  end_date: "2026-10-15T18:00:00Z",
  expected_attendees: 500,
  registration_open: true,
  tags: [],
};

const APPROVAL: Approval = {
  approval_id: "APR-001",
  event_id: EVENT_ID,
  title: "Send 3rd follow-up to Raj Malhotra",
  description: "SpeakerOps wants to send a 3rd follow-up to a speaker who has not replied.",
  status: "PENDING",
  risk_level: "MEDIUM",
  requested_action: "SEND_SPEAKER_FOLLOWUP",
  reason: "Follow-up count exceeds the auto-send threshold",
  evidence: { speaker_id: "SPK-002", followup_count: 2 },
  affected_resource_type: "Speaker",
  affected_resource_id: "SPK-002",
  agent_name: "SpeakerOps",
  requested_at: "2026-10-14T09:00:00Z",
};

const SPEAKER: Speaker = {
  speaker_id: "SPK-002",
  event_id: EVENT_ID,
  name: "Raj Malhotra",
  email: "raj@example.com",
  status: "AWAITING_RESPONSE",
  topic: "Serverless at scale",
  session_type: "Keynote",
  followup_count: 2,
  travel_required: true,
  accommodation_required: false,
  is_backup: false,
};

const INCIDENT: Incident = {
  incident_id: "INC-001",
  event_id: EVENT_ID,
  title: "Keynote speaker has cancelled",
  description: "Raj Malhotra withdrew nine days before the event.",
  severity: "HIGH",
  status: "OPEN",
  affected_resource_type: "Speaker",
  affected_resource_id: "SPK-002",
  recommendation: "Promote the confirmed backup speaker to the keynote slot.",
  backup_options: ["Promote SPK-005"],
  detected_at: "2026-10-14T08:00:00Z",
};

const TEAM: Team = {
  team_id: "TEAM-speakers",
  event_id: EVENT_ID,
  name: "Speaker Management",
  is_active: true,
};

const TASK: Task = {
  task_id: "TSK-001",
  event_id: EVENT_ID,
  team_id: TEAM.team_id,
  title: "Confirm keynote slide deck",
  description: "The deck is needed for the AV rehearsal.",
  status: "BLOCKED",
  priority: "HIGH",
  assigned_to: "volunteer-001",
  due_date: "2026-10-14T12:00:00Z",
  depends_on: [],
  blocks: [],
  escalation_level: 0,
};

const AUDIT_EVENT: AuditEvent = {
  audit_id: "AUD-1",
  organization_id: "ORG-wemakedev",
  event_id: EVENT_ID,
  timestamp: "2026-10-14T09:00:00Z",
  action: "SPEAKER_FOLLOWUP_SENT",
  actor_type: "agent",
  actor_id: "SpeakerOps",
  resource_type: "Speaker",
  resource_id: "SPK-002",
  outcome: "success",
  tool_used: "send_speaker_invite",
};

const OVERVIEW: CommandCenterData = {
  organization_id: "ORG-wemakedev",
  summary: {
    active_events: 1,
    total_events: 2,
    pending_approvals: 1,
    critical_incidents: 1,
    overdue_tasks: 1,
  },
  events: [
    {
      event_id: EVENT_ID,
      name: ACTIVE_EVENT.name,
      status: "ACTIVE",
      pending_approvals: 1,
      critical_incidents: 1,
      overdue_tasks: 1,
      blocked_tasks: 1,
      total_tasks: 4,
    },
  ],
  recent_actions: [AUDIT_EVENT],
};

const REGISTRATION: Registration = {
  registration_id: "REG-2026-004821",
  event_id: EVENT_ID,
  attendee_name: "Priya Sharma",
  attendee_email: "priya.sharma@example.com",
  attendee_phone: "+919876543210",
  status: "CONFIRMED",
  payment_status: "CAPTURED",
  ticket_type: "GENERAL",
  is_checked_in: false,
};

const ALL_CHECKS_PASS: readonly VerificationCheck[] = VERIFICATION_CHECK_NAMES.map((name) => ({
  name,
  status: "PASS",
  message: `${name} passed`,
}));

const VERIFIED: VerificationOutcome = {
  registrationId: REGISTRATION.registration_id,
  allPassed: true,
  checks: ALL_CHECKS_PASS,
  registration: {
    attendee_name: REGISTRATION.attendee_name,
    ticket_type: REGISTRATION.ticket_type,
    status: REGISTRATION.status,
    payment_status: REGISTRATION.payment_status,
  },
};

const COMPLETED: CheckinCompletion = {
  registrationId: REGISTRATION.registration_id,
  status: "CHECKED_IN",
  checkedInAt: "2026-10-15T09:12:00Z",
  message: "Check-in completed successfully.",
  wasAlreadyCheckedIn: false,
};

/** The check-in flow, answering the way the endpoints do for one clean match. */
const checkinService: CheckinService = {
  search: () =>
    Promise.resolve({
      found: true,
      count: 1,
      registrations: [withUnmodelledFields(REGISTRATION)],
      requires_disambiguation: false,
    }),
  verify: () => Promise.resolve(withUnmodelledFields(VERIFIED)),
  recover: () =>
    Promise.resolve({
      ticket_id: REGISTRATION.registration_id,
      registration_id: REGISTRATION.registration_id,
      download_url: "#",
      already_existed: false,
      message: "Ticket generated successfully.",
    }),
  reconcile: () => Promise.resolve({ kind: "unresolved", message: "" }),
  complete: () => Promise.resolve(withUnmodelledFields(COMPLETED)),
};

/** The check-in flow, failing the way a broken endpoint does. */
const failingCheckinService: CheckinService = {
  search: () => Promise.reject(leakyFailure()),
  verify: () => Promise.reject(leakyFailure()),
  recover: () => Promise.reject(leakyFailure()),
  reconcile: () => Promise.reject(leakyFailure()),
  complete: () => Promise.reject(leakyFailure()),
};

/* --- Harness -------------------------------------------------------------- */

const SESSION: SessionValue = {
  status: "authenticated",
  refresh: () => Promise.resolve(),
  signOut: () => undefined,
};

const EVENTS: EventContextValue = {
  status: "ready",
  activeEvent: ACTIVE_EVENT,
  activeEventId: EVENT_ID,
  events: [ACTIVE_EVENT],
  source: "active",
  error: null,
  setActiveEvent: () => true,
  refresh: () => undefined,
};

function mount(page: ReactNode) {
  render(
    <MemoryRouter>
      <SessionContext.Provider value={SESSION}>
        <EventContext.Provider value={EVENTS}>{page}</EventContext.Provider>
      </SessionContext.Provider>
    </MemoryRouter>,
  );
}

interface PageUnderTest {
  readonly name: string;

  /** Render it with every request answered, and wait until it has settled. */
  openResolved(): Promise<void>;

  /** Render it with every request failing, and wait for the error surface. */
  openFailed(): Promise<void>;
}

/** Every page whose content comes from the API. */
const PAGES: readonly PageUnderTest[] = [
  {
    name: "Command Center",
    async openResolved() {
      mount(<CommandCenter />);
      await screen.findByRole("region", { name: "Needs your decision" });
    },
    async openFailed() {
      mount(<CommandCenter />);
      await screen.findByRole("alert");
    },
  },
  {
    name: "Approvals",
    async openResolved() {
      mount(<ApprovalCenter eventId={EVENT_ID} />);
      await screen.findByRole("heading", { level: 2, name: APPROVAL.title });
    },
    async openFailed() {
      mount(<ApprovalCenter eventId={EVENT_ID} />);
      await screen.findByRole("alert");
    },
  },
  {
    name: "SpeakerOps",
    async openResolved() {
      mount(<SpeakerOps eventId={EVENT_ID} />);
      await screen.findByRole("button", { name: `View details for ${SPEAKER.name}` });
    },
    async openFailed() {
      mount(<SpeakerOps eventId={EVENT_ID} />);
      await screen.findByRole("alert");
    },
  },
  {
    name: "TeamOps",
    async openResolved() {
      mount(<TaskBoard eventId={EVENT_ID} />);
      await screen.findByRole("heading", { level: 2, name: TEAM.name });
    },
    async openFailed() {
      mount(<TaskBoard eventId={EVENT_ID} />);
      await screen.findByRole("alert");
    },
  },
  {
    name: "IncidentOps",
    async openResolved() {
      mount(<IncidentCenter eventId={EVENT_ID} />);
      await screen.findByRole("button", { name: `View details for ${INCIDENT.title}` });
    },
    async openFailed() {
      mount(<IncidentCenter eventId={EVENT_ID} />);
      await screen.findByRole("alert");
    },
  },
  {
    name: "AttendeeOps",
    async openResolved() {
      mount(<AttendeeOps eventId={EVENT_ID} />);
      await screen.findByRole("group", { name: "Attendee exception type" });
    },
    async openFailed() {
      mount(<AttendeeOps eventId={EVENT_ID} />);
      await screen.findByRole("alert");
    },
  },
  {
    name: "Budget",
    async openResolved() {
      mount(<Budget eventId={EVENT_ID} />);
      await screen.findByText("₹75,000");
    },
    async openFailed() {
      mount(<Budget eventId={EVENT_ID} />);
      await screen.findByRole("alert");
    },
  },
  {
    name: "Agent",
    async openResolved() {
      mount(<AgentConsole eventId={EVENT_ID} />);
      await screen.findByRole("heading", { name: "Operational conversation" });
    },
    async openFailed() {
      mount(<AgentConsole eventId={EVENT_ID} />);
      await screen.findByRole("alert");
    },
  },
  {
    name: "Audit Log",
    async openResolved() {
      mount(<AuditLog eventId={EVENT_ID} />);
      await screen.findByRole("heading", { level: 2 });
    },
    async openFailed() {
      mount(<AuditLog eventId={EVENT_ID} />);
      await screen.findByRole("alert");
    },
  },
  {
    name: "Check-In",
    async openResolved() {
      mount(<CheckinConsole eventId={EVENT_ID} service={checkinService} />);
      await screen.findByRole("heading", { level: 2, name: "Find the attendee" });
    },
    async openFailed() {
      mount(<CheckinConsole eventId={EVENT_ID} service={failingCheckinService} />);
      await screen.findByRole("heading", { level: 2, name: "Find the attendee" });
    },
  },
];

/** One page by name, for a claim that is about a single page rather than all of them. */
function pageNamed(name: string): PageUnderTest {
  const page = PAGES.find((candidate) => candidate.name === name);

  if (page === undefined) {
    throw new Error(`No page named "${name}" in this suite.`);
  }

  return page;
}

/** Everything on screen, as text — the surface a person and a reader receive. */
function renderedText(): string {
  return document.body.textContent ?? "";
}

/** Everything on screen including attributes, for a key-name search. */
function renderedMarkup(): string {
  return document.body.innerHTML;
}

/** Answer every request. */
function resolveEverything() {
  api.getCommandCenter.mockResolvedValue({
    ...OVERVIEW,
    recent_actions: [withUnmodelledFields(AUDIT_EVENT)],
  });
  api.getAttention.mockResolvedValue({ event_id: EVENT_ID, attention_items: [], count: 0, critical_count: 0, high_count: 0 });
  api.getApprovals.mockResolvedValue({
    approvals: [withUnmodelledFields(APPROVAL)],
    count: 1,
  });
  api.getAuditLog.mockResolvedValue({
    audit_events: [withUnmodelledFields(AUDIT_EVENT)],
    count: 1,
  });
  api.decideApproval.mockResolvedValue({});
  api.getSpeakers.mockResolvedValue({ speakers: [withUnmodelledFields(SPEAKER)], count: 1 });
  api.getIncidents.mockResolvedValue({ incidents: [withUnmodelledFields(INCIDENT)], count: 1 });
  api.getTeams.mockResolvedValue({ teams: [withUnmodelledFields(TEAM)], count: 1 });
  api.getTasks.mockResolvedValue({ tasks: [withUnmodelledFields(TASK)], count: 1 });
  api.getEventTasks.mockResolvedValue({ tasks: [withUnmodelledFields(TASK)], count: 1, overdue_count: 0 });
  api.getWorkload.mockResolvedValue({ event_id: EVENT_ID, teams: [], members: [], busiest_member: null, most_available_member: null });
  api.getAttendeeOps.mockResolvedValue({ event_id: EVENT_ID, event_name: ACTIVE_EVENT.name, summary: { total_registered: 1, confirmed: 1, cancelled: 0, waitlisted: 0, checked_in: 0, not_checked_in: 1, accommodation_required: 0, dietary_provided: 1, dietary_missing: 0, arrival_confirmed: 1, arrival_conflicts: 0, missing_information: 0, data_completeness_percent: 100, expected_attendees: 1, registration_target: 1 }, funnel: [{ stage: "Registered", count: 1, detail: "Signed up" }], exceptions: { missing_dietary: [withUnmodelledFields({ registration_id: REGISTRATION.registration_id, attendee_name: REGISTRATION.attendee_name, ticket_type: REGISTRATION.ticket_type })], missing_dietary_total: 1, accommodation_pending: [], accommodation_pending_total: 0, arrival_unconfirmed: [], arrival_unconfirmed_total: 0 } });
  api.getBudget.mockResolvedValue(withUnmodelledFields({ event_id: EVENT_ID, currency: "INR", total_budget: 100000, allocated: 90000, spent: 15000, committed: 10000, remaining: 75000, unallocated: 10000, utilization_percent: 25, categories: [], exists: true, total_budget_formatted: "1,00,000", remaining_formatted: "75,000", categories_available: ["VENUE"] }));
  api.getExpenses.mockResolvedValue({ expenses: [], count: 0, total_inr: 0 });
  api.getAgentCapabilities.mockResolvedValue(withUnmodelledFields({ role: "LEADER", model_id: "internal-model", model_region: "internal-region", tool_count: 1, tools: [], automatic: ["get_budget"], requires_approval: [], withheld_from_role: [], notes: [] }));
  api.getAgentActivity.mockResolvedValue({ activity: [], count: 0, refused_count: 0, awaiting_approval_count: 0 });
}

/** Fail every request, with the leak attached. */
function failEverything() {
  for (const call of Object.values(api)) {
    call.mockRejectedValue(leakyFailure());
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveEverything();
});

/* --- 1. No rendered string leaks implementation detail (16.7) -------------- */

describe("no rendered string carries implementation detail", () => {
  it("would detect every one of these items in the failure it is given", () => {
    // The negative control. Every assertion below is an absence, and an absence
    // passes just as well when the battery is broken or the failure carries
    // nothing. This proves the battery bites on the text it is aimed at, so the
    // absences that follow are findings rather than silence.
    for (const [item, pattern] of FORBIDDEN_IN_RENDERED_TEXT) {
      expect(LEAKY_MESSAGE + leakyFailure().stack, `${item} is not in the fixture`).toMatch(
        pattern,
      );
    }
  });

  for (const page of PAGES) {
    it(`${page.name} shows none of the backend's failure detail`, async () => {
      failEverything();

      await page.openFailed();

      const text = renderedText();

      // The page did render something, so the loop below is asserting about a
      // page with content rather than about an empty document.
      expect(text.length).toBeGreaterThan(0);

      for (const [item, pattern] of FORBIDDEN_IN_RENDERED_TEXT) {
        expect(text, `${page.name} leaked a ${item}`).not.toMatch(pattern);
      }
    });
  }

  for (const page of PAGES) {
    // A failure is the obvious route for machine text, but not the only one: the
    // records themselves carry an ARN and an account id in this suite's
    // fixtures, so a resolved page is the other surface worth checking.
    it(`${page.name} shows none of it once resolved either`, async () => {
      await page.openResolved();

      const text = renderedText();

      expect(text, `${page.name} leaked an ARN`).not.toMatch(/arn:aws/i);
      expect(text, `${page.name} leaked an account id`).not.toMatch(/\b\d{12}\b/);
    });
  }
});

/* --- 2. Unmodelled fields are absent from the typed models (16.5, 16.6) ---- */

describe("the typed models declare no unmodelled field", () => {
  const typesSource = sourceOf("types.ts");

  for (const key of ["task_token", "workflow_execution_id"] as const) {
    it(`declares no ${key} on any model`, () => {
      expect(typesSource).not.toContain(key);
    });
  }

  it("declares no details field on AuditEvent", () => {
    const auditEvent = /export interface AuditEvent \{([^}]*)\}/.exec(typesSource);

    // A regex that matched nothing would make the assertion below vacuous.
    expect(auditEvent, "AuditEvent is no longer declared in src/types.ts").not.toBeNull();
    expect(auditEvent?.[1]).not.toMatch(/\bdetails\b/);
  });
});

/* --- 3. …and absent from rendered output (16.5, 16.6) --------------------- */

describe("no unmodelled field reaches the DOM", () => {
  it("puts all three on every record the pages are given", () => {
    // The negative control for the absences below: the fields have to be in the
    // responses for "they are not in the DOM" to mean anything.
    const record: Record<string, unknown> = { ...withUnmodelledFields(AUDIT_EVENT) };

    for (const key of [...UNMODELLED_KEYS, "details"]) {
      expect(record, `the fixture carries no ${key}`).toHaveProperty(key);
    }
  });

  for (const page of PAGES) {
    it(`${page.name} renders neither the key nor the value`, async () => {
      await page.openResolved();

      const markup = renderedMarkup();

      for (const key of UNMODELLED_KEYS) {
        expect(markup, `${page.name} rendered the ${key} key`).not.toContain(key);
      }
      expect(markup, `${page.name} serialized AuditEvent.details`).not.toMatch(
        SERIALIZED_DETAILS_KEY,
      );

      // The values, which is the assertion that settles it either way.
      expect(markup).not.toContain(UNMODELLED_VALUES.task_token);
      expect(markup).not.toContain(UNMODELLED_VALUES.workflow_execution_id);
      expect(markup).not.toContain(UNMODELLED_VALUES.details.prompt);
      expect(markup).not.toContain(UNMODELLED_VALUES.details.pii_email);

      // No raw serialization anywhere, which is the other way an unmodelled
      // field reaches a user (requirement 16.5).
      expect(document.querySelector("pre")).toBeNull();
    });
  }
});

/* --- 4. Mock data never returns on a real failure (13.10) ----------------- */

describe("a failed request never falls back to mock data", () => {
  /**
   * Values that exist only in `api.ts`'s mock fixtures. If one of these reaches
   * the screen while every request is failing, mock data has become a failure
   * fallback — which is the defect requirement 13.10 forbids.
   */
  const MOCK_ONLY_VALUES = [
    "Dr. Ananya Krishnan",
    "Building Responsible AI Systems",
    "Replace cancelled speaker with backup",
    "Send final event reminder email",
    "Prepare check-in kits",
    "Speaker James Chen cancelled",
  ] as const;

  for (const page of PAGES) {
    it(`${page.name} stays empty rather than showing fabricated data`, async () => {
      failEverything();

      await page.openFailed();

      const markup = renderedMarkup();

      for (const value of MOCK_ONLY_VALUES) {
        expect(markup, `${page.name} substituted mock data for a failure`).not.toContain(value);
      }
    });
  }

  it("renders no data rows on a page whose only request failed", async () => {
    failEverything();

    // SpeakerOps: one request, one table, so an empty table is unambiguous.
    await pageNamed("SpeakerOps").openFailed();

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("row")).not.toBeInTheDocument();
  });
});

/* --- Source-level guards -------------------------------------------------- */

interface SourceFile {
  /** Path relative to `src/`, as the failure message should name it. */
  readonly path: string;
  readonly text: string;
}

/**
 * Every shipped module under `src/`, as text.
 *
 * Test files are excluded: a test may name a forbidden pattern in order to
 * assert against it, as this file does throughout.
 */
const SOURCES: readonly SourceFile[] = Object.entries(
  RAW_MODULES as Record<string, string>,
)
  .filter(([path]) => !/\.test\.tsx?$/.test(path))
  .map(([path, text]) => ({ path: path.replace(/^\.\//, ""), text }));

/**
 * Source with comments removed. Every rule below is about code: the invariants
 * are documented in prose throughout `src/`, and a guard that read the prose
 * would fire on the sentence explaining why the code is safe.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** The text of one shipped module, by its path relative to `src/`. */
function sourceOf(path: string): string {
  const module = SOURCES.find((source) => source.path === path);

  expect(module, `${path} is no longer part of the module graph`).toBeDefined();

  return code(module?.text ?? "");
}

/* --- 5. No client-side authorization (16.1, 16.2) ------------------------- */

describe("role-aware presentation is not authorization", () => {
  it("keeps tokens and permission grants out of page components", () => {
    const pageSources = SOURCES.filter(({ path }) => path.startsWith("pages/"));
    for (const { path, text } of pageSources) {
      expect(code(text), path).not.toMatch(/\bAuthorization\b|\bpermissionGrant\b|\bgrantAccess\b/);
    }
  });

  it("stores only claim-derived presentation identity while API calls remain authoritative", () => {
    expect(sourceOf("session/sessionContext.ts")).toMatch(/SignedInUser/);
    expect(sourceOf("api.ts")).toMatch(/Authorization/);
    expect(sourceOf("api.ts")).toMatch(/resolveOrganization/);
  });
});

/* --- 6. No token in application state, a URL or a log (16.9) -------------- */

describe("no token is copied into application state, a URL or a log", () => {
  /** Where a value leaves the module that produced it. */
  const SINKS: readonly RegExp[] = [
    /\.setItem\s*\(/,
    /\bconsole\.\w+\s*\(/,
    /\bdocument\.cookie\b/,
    /\bURLSearchParams\b/,
    /\blocation\.(?:href|search|assign|replace)\b/,
    /\bsearchParams\.set\b/,
  ];

  /** A token-shaped value, by the names this codebase gives one. */
  const TOKEN_VALUE = /\b(?:idToken|IdToken|jwtToken|JwtToken|accessToken|AccessToken|refreshToken|bearer)\b/;

  it("puts no token-valued expression on a line that reaches a sink", () => {
    expect(SOURCES.length).toBeGreaterThan(0);

    const offences = SOURCES.flatMap(({ path, text }) =>
      code(text)
        .split("\n")
        .flatMap((line, index) =>
          SINKS.some((sink) => sink.test(line)) && TOKEN_VALUE.test(line)
            ? [`${path}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );

    expect(offences).toEqual([]);
  });

  it("declares no token on the session value", () => {
    expect(sourceOf("session/sessionContext.ts")).not.toMatch(/\btoken\b/i);
  });

  /**
   * The source guards above are universal but static. These two are the runtime
   * half, aimed at the only modules in the console that hold an ID token and
   * write to `localStorage` in the same breath: `orgContext.ts` and
   * `event/eventResolution.ts`. If a token were ever persisted, it would be one
   * of these two that did it.
   */
  describe("and the modules that hold a token persist none of it", () => {
    /** A real ID token's shape: three dot-separated base64url segments. */
    const SENTINEL_TOKEN = tokenFor({
      sub: "sentinel-subject",
      "cognito:groups": ["ORG-wemakedev"],
    });

    let logged: string[] = [];

    beforeEach(() => {
      logged = [];
      for (const level of ["log", "info", "warn", "error", "debug"] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          logged.push(args.map(String).join(" "));
        });
      }
      window.localStorage.clear();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      window.localStorage.clear();
    });

    it("writes the preference and not the token that scoped it", () => {
      const stored = rememberEvent(SENTINEL_TOKEN, EVENT_ID, [ACTIVE_EVENT]);
      const storedOrg = rememberOrganization(SENTINEL_TOKEN, "ORG-wemakedev");

      // The negative control: both writes have to have happened for the
      // absences below to be about anything.
      expect(stored, "the event preference was not written").toBe(true);
      expect(storedOrg, "the organization preference was not written").toBe(true);

      const entries = Object.keys(window.localStorage).map(
        (key) => `${key}=${window.localStorage.getItem(key)}`,
      );

      expect(entries).toHaveLength(2);

      const everything = entries.join("\n");

      expect(everything).not.toContain(SENTINEL_TOKEN);
      // Nor any segment of it: the signature and the claims payload are each
      // enough to be worth stealing on their own.
      for (const segment of SENTINEL_TOKEN.split(".")) {
        expect(everything, "a token segment was persisted").not.toContain(segment);
      }
    });

    it("puts no token in the URL or the console while resolving one", async () => {
      // Both read the token and both touch storage, which is the combination
      // requirement 16.9 is about.
      const organization = resolveOrganization({
        idToken: SENTINEL_TOKEN,
        fallbackOrganizationId: "ORG-fallback",
      });
      readStoredEvent(SENTINEL_TOKEN);

      // The negative control: the token was read, not ignored.
      expect(organization.organizationId).toBe("ORG-wemakedev");

      await pageNamed("SpeakerOps").openResolved();

      expect(window.location.href).not.toContain(SENTINEL_TOKEN);
      expect(renderedMarkup()).not.toContain(SENTINEL_TOKEN);
      expect(logged.join("\n"), "a token reached the console").not.toContain(SENTINEL_TOKEN);
    });
  });
});
