/**
 * Accessibility smoke across every page in the console (design.md §21.3
 * "Accessibility smoke").
 *
 * Four claims, each made against all eight pages rather than against one:
 *
 *   1. **One `<h1>`, and a heading order that never skips a level** — the page
 *      title is the page's only top-level heading and everything under it
 *      descends one step at a time (requirement 15.1).
 *   2. **Every control has an accessible name** — asserted through role and
 *      accessible-name queries, so what is checked is what a screen reader
 *      announces, not what a class attribute says (requirement 15.7).
 *   3. **Every drawer is a modal dialog named by its own heading**
 *      (requirement 15.5).
 *   4. **Results are announced** — the decision result and the check-in outcome
 *      each sit in a polite live region (requirement 15.8). The third region
 *      requirement 15.8 names, the mock-mode badge, belongs to `Topbar` and is
 *      covered in `Topbar.test.tsx` beside the rest of that badge's behaviour.
 *
 * Every page is rendered with the same stubbed network and driven to its
 * resolved state, because an accessibility claim about a skeleton is a claim
 * about nothing. Only `src/api.ts` and the Cognito boundary are replaced: the
 * real `PageHeader`, `DataTable`, `Drawer`, `DecisionCard` and page bodies all
 * render, which is the only way a structural claim about them means anything.
 *
 * **Validates: Requirements 15.1, 15.5, 15.7, 15.8**
 */

import type { ReactNode } from "react";
import { configure, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { greeting } from "./command/commandView";
import { WHY_THIS_ACTION } from "./components/DecisionCard";
import { EventContext, type EventContextValue } from "./event/eventContext";
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
import { Login } from "./pages/Login";
import { SpeakerOps } from "./pages/SpeakerOps";
import { TaskBoard } from "./pages/TaskBoard";

/**
 * Eight pages, each rendered afresh for every claim made about it, and three of
 * them fetch twice before they settle. The budgets below are generous on
 * purpose: a timeout in this file should mean a page never resolved, never that
 * the machine was busy running the rest of the suite alongside it.
 */
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
  getAgentCapabilities: vi.fn(),
  getAgentActivity: vi.fn(),
  agentChat: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();

  return { ...actual, ...api };
});

const AUTH_FIXTURE = vi.hoisted(() => ({
  token: "header.eyJzdWIiOiJVU1ItMSIsImVtYWlsIjoiYXNoYUBleGFtcGxlLm9yZyIsImNvZ25pdG86Z3JvdXBzIjpbIkxFQURFUiIsIk9SRy13ZW1ha2VkZXYiXX0.signature",
  user: {
    userId: "USR-1",
    email: "asha@example.org",
    name: "Asha",
    role: "LEADER" as const,
    organizations: ["ORG-wemakedev"],
    isDemo: false,
  },
}));

vi.mock("./auth", () => ({
  isAuthConfigured: true,
  isSignedIn: () => Promise.resolve(true),
  getSignedInUser: () => Promise.resolve(AUTH_FIXTURE.user),
  isDemoSession: () => false,
  signIn: () => Promise.resolve(),
  signOut: () => undefined,
  getIdToken: () => Promise.resolve(AUTH_FIXTURE.token),
  getSignedInEmail: () => AUTH_FIXTURE.user.email,
  getMemberOrganizations: () => Promise.resolve(AUTH_FIXTURE.user.organizations),
  AuthError: class AuthError extends Error {},
}));

/* --- Fixtures ------------------------------------------------------------- */

const ACTIVE_EVENT: Event = {
  event_id: EVENT_ID,
  name: "DevCon Bengaluru 2026",
  description: "The largest developer conference in South India",
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
  backup_options: ["Promote SPK-005", "Shorten the keynote to a panel"],
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
      registrations: [REGISTRATION],
      requires_disambiguation: false,
    }),
  verify: () => Promise.resolve(VERIFIED),
  recover: () =>
    Promise.resolve({
      ticket_id: REGISTRATION.registration_id,
      registration_id: REGISTRATION.registration_id,
      download_url: "#",
      already_existed: false,
      message: "Ticket generated successfully.",
    }),
  reconcile: () => Promise.resolve({ kind: "unresolved", message: "" }),
  complete: () => Promise.resolve(COMPLETED),
};

/* --- Harness -------------------------------------------------------------- */

const SESSION: SessionValue = {
  status: "authenticated",
  user: {
    userId: "USR-1",
    email: "asha@example.org",
    name: "Asha",
    role: "LEADER",
    organizations: ["ORG-wemakedev"],
    isDemo: false,
  },
  activeOrganizationId: "ORG-wemakedev",
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

/**
 * A page inside the providers every protected route has above it. The shell is
 * deliberately absent: `AppShell` owns the landmarks and the skip link and has
 * its own suite, so what is left here is the page's own structure.
 */
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
  /** The page's name, as the navigation and this suite's output call it. */
  readonly name: string;

  /** The text of the page's single `<h1>`. */
  readonly title: string;

  /** Render it and wait until it has finished resolving. */
  open(): Promise<void>;
}

const PAGES: readonly PageUnderTest[] = [
  {
    name: "Command Center",
    title: greeting(null),
    async open() {
      mount(<CommandCenter />);
      await screen.findByRole("region", { name: "Needs your decision" });
    },
  },
  {
    name: "Approvals",
    title: "Approvals",
    async open() {
      mount(<ApprovalCenter eventId={EVENT_ID} />);
      await screen.findByRole("heading", { level: 2, name: APPROVAL.title });
    },
  },
  {
    name: "SpeakerOps",
    title: "SpeakerOps",
    async open() {
      mount(<SpeakerOps eventId={EVENT_ID} />);
      await screen.findByRole("button", { name: `View details for ${SPEAKER.name}` });
    },
  },
  {
    name: "TeamOps",
    title: "TeamOps",
    async open() {
      mount(<TaskBoard eventId={EVENT_ID} />);
      await screen.findByRole("heading", { level: 2, name: TEAM.name });
    },
  },
  {
    name: "IncidentOps",
    title: "IncidentOps",
    async open() {
      mount(<IncidentCenter eventId={EVENT_ID} />);
      await screen.findByRole("button", { name: `View details for ${INCIDENT.title}` });
    },
  },
  {
    name: "Check-In",
    title: "Check-In",
    async open() {
      mount(<CheckinConsole eventId={EVENT_ID} service={checkinService} />);
      await screen.findByRole("heading", { level: 2, name: "Find the attendee" });
    },
  },
  {
    name: "AttendeeOps",
    title: "AttendeeOps",
    async open() {
      mount(<AttendeeOps eventId={EVENT_ID} />);
      await screen.findByRole("group", { name: "Attendee exception type" });
    },
  },
  {
    name: "Budget",
    title: "Budget",
    async open() {
      mount(<Budget eventId={EVENT_ID} />);
      await screen.findByText("₹75,000");
    },
  },
  {
    name: "Agent",
    title: "Agent",
    async open() {
      mount(<AgentConsole eventId={EVENT_ID} />);
      await screen.findByRole("heading", { name: "Operational conversation" });
    },
  },
  {
    name: "Audit Log",
    title: "Audit Log",
    async open() {
      mount(<AuditLog eventId={EVENT_ID} />);
      await screen.findByRole("heading", { level: 2 });
    },
  },
  {
    name: "Login",
    title: "CommunityOps",
    async open() {
      // No providers: the sign-in screen sits outside the session, and giving it
      // one here would hide a dependency it must not have.
      render(<Login onSignedIn={() => undefined} />);
      await screen.findByRole("heading", { level: 2, name: "Welcome back" });
    },
  },
];

/** Heading levels in document order, as assistive technology reads them. */
function headingLevels(): number[] {
  return screen.getAllByRole("heading").map((heading) => {
    const explicit = heading.getAttribute("aria-level");

    return explicit === null ? Number(heading.tagName.slice(1)) : Number(explicit);
  });
}

/**
 * Roles that answer to a keystroke or a click. Gathered by role rather than by
 * element, so a control's *computed* role is what decides whether it is checked.
 */
const WIDGET_ROLES = [
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "spinbutton",
  "slider",
  "tab",
] as const;

/** Every interactive control currently on screen, hidden ones excluded. */
function controlsOnScreen(): HTMLElement[] {
  return WIDGET_ROLES.flatMap((role) => screen.queryAllByRole(role));
}

beforeEach(() => {
  api.getCommandCenter.mockResolvedValue(OVERVIEW);
  api.getAttention.mockResolvedValue({ event_id: EVENT_ID, attention_items: [], count: 0, critical_count: 0, high_count: 0 });
  api.getApprovals.mockResolvedValue({ approvals: [APPROVAL], count: 1 });
  api.getAuditLog.mockResolvedValue({ audit_events: [AUDIT_EVENT], count: 1 });
  api.decideApproval.mockResolvedValue({});
  api.getSpeakers.mockResolvedValue({ speakers: [SPEAKER], count: 1 });
  api.getIncidents.mockResolvedValue({ incidents: [INCIDENT], count: 1 });
  api.getTeams.mockResolvedValue({ teams: [TEAM], count: 1 });
  api.getTasks.mockResolvedValue({ tasks: [TASK], count: 1 });
  api.getEventTasks.mockResolvedValue({ tasks: [TASK], count: 1, overdue_count: 0 });
  api.getWorkload.mockResolvedValue({ event_id: EVENT_ID, teams: [], members: [], busiest_member: null, most_available_member: null });
  api.getAttendeeOps.mockResolvedValue({ event_id: EVENT_ID, event_name: ACTIVE_EVENT.name, summary: { total_registered: 1, confirmed: 1, cancelled: 0, waitlisted: 0, checked_in: 0, not_checked_in: 1, accommodation_required: 0, dietary_provided: 1, dietary_missing: 0, arrival_confirmed: 1, arrival_conflicts: 0, missing_information: 0, data_completeness_percent: 100, expected_attendees: 1, registration_target: 1 }, funnel: [{ stage: "Registered", count: 1, detail: "Signed up" }], exceptions: { missing_dietary: [], missing_dietary_total: 0, accommodation_pending: [], accommodation_pending_total: 0, arrival_unconfirmed: [], arrival_unconfirmed_total: 0 } });
  api.getBudget.mockResolvedValue({ event_id: EVENT_ID, currency: "INR", total_budget: 100000, allocated: 90000, spent: 15000, committed: 10000, remaining: 75000, unallocated: 10000, utilization_percent: 25, categories: [], exists: true, total_budget_formatted: "1,00,000", remaining_formatted: "75,000", categories_available: ["VENUE"] });
  api.getExpenses.mockResolvedValue({ expenses: [], count: 0, total_inr: 0 });
  api.getAgentCapabilities.mockResolvedValue({ role: "LEADER", model_id: "private-model", model_region: "private-region", tool_count: 1, tools: [], automatic: ["get_budget"], requires_approval: [], withheld_from_role: [], notes: [] });
  api.getAgentActivity.mockResolvedValue({ activity: [], count: 0, refused_count: 0, awaiting_approval_count: 0 });
});

/* --- Headings (requirement 15.1) ------------------------------------------ */

describe("one <h1> per page, and no skipped heading level", () => {
  for (const page of PAGES) {
    it(`${page.name} titles itself with a single level-one heading`, async () => {
      await page.open();

      const topLevel = screen.getAllByRole("heading", { level: 1 });

      expect(topLevel).toHaveLength(1);
      expect(topLevel[0]).toHaveAccessibleName(page.title);
    });

    it(`${page.name} descends one heading level at a time`, async () => {
      await page.open();

      const levels = headingLevels();

      // The page's first heading is its title, so nothing is announced above it.
      expect(levels[0]).toBe(1);

      // Every heading is at most one level below the deepest one before it, which
      // is what "a single descending heading order" means for a screen reader
      // walking the page.
      let deepest = 1;
      for (const level of levels) {
        expect(level).toBeLessThanOrEqual(deepest + 1);
        deepest = Math.max(deepest, level);
      }
    });
  }
});

/* --- Labelled controls (requirement 15.7) --------------------------------- */

describe("every control announces a name", () => {
  for (const page of PAGES) {
    it(`${page.name} leaves no control unnamed`, async () => {
      await page.open();

      const controls = controlsOnScreen();

      // A page with no controls would pass the loop below without asserting
      // anything, and none of these eight is that page.
      expect(controls.length).toBeGreaterThan(0);

      for (const control of controls) {
        expect(control).toHaveAccessibleName();
      }
    });
  }
});

/* --- Drawers (requirement 15.5) ------------------------------------------- */

describe("every drawer is a modal dialog named by its heading", () => {
  /**
   * Opens a drawer from the control named `trigger` and returns the dialog,
   * having checked the three things requirement 15.5 asks of every one of them.
   */
  async function openDrawer(trigger: string, name: string): Promise<HTMLElement> {
    const user = userEvent.setup();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: trigger }));

    const dialog = screen.getByRole("dialog", { name });

    expect(dialog).toHaveAttribute("aria-modal", "true");
    // Named by the heading the user can see, not by a second string written for
    // assistive technology alone.
    expect(within(dialog).getByRole("heading", { level: 2 })).toHaveAccessibleName(name);

    return dialog;
  }

  it("opens the agent's reasoning from the Command Center decision surface", async () => {
    mount(<CommandCenter />);
    await screen.findByRole("region", { name: "Needs your decision" });

    const dialog = await openDrawer(WHY_THIS_ACTION, WHY_THIS_ACTION);

    // The approval it is about is the dialog's description, so the panel is
    // never just "Why this action?" with no subject.
    expect(dialog).toHaveAccessibleDescription(APPROVAL.title);
  });

  it("opens a speaker's detail from SpeakerOps", async () => {
    mount(<SpeakerOps eventId={EVENT_ID} />);
    await screen.findByRole("button", { name: `View details for ${SPEAKER.name}` });

    await openDrawer(`View details for ${SPEAKER.name}`, SPEAKER.name);
  });

  it("opens an incident's detail from IncidentOps", async () => {
    mount(<IncidentCenter eventId={EVENT_ID} />);
    await screen.findByRole("button", { name: `View details for ${INCIDENT.title}` });

    await openDrawer(`View details for ${INCIDENT.title}`, INCIDENT.title);
  });

  it("opens a team's tasks from TeamOps", async () => {
    mount(<TaskBoard eventId={EVENT_ID} />);
    await screen.findByRole("heading", { level: 2, name: TEAM.name });

    await openDrawer(`View details for ${TEAM.name}`, TEAM.name);
  });
});

/* --- Announcements (requirement 15.8) ------------------------------------- */

describe("results are announced through a polite live region", () => {
  it("announces a decision result on the approvals queue", async () => {
    mount(<ApprovalCenter eventId={EVENT_ID} />);
    await screen.findByRole("heading", { level: 2, name: APPROVAL.title });

    // Present before there is anything to say, so the result is announced rather
    // than the region arriving with it.
    const announcement = screen.getByRole("status");
    expect(announcement).toHaveAttribute("aria-live", "polite");
    expect(announcement).toBeEmptyDOMElement();

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByRole("status")).toHaveTextContent(/approved/i);
  });

  it("announces a check-in outcome at the desk", async () => {
    mount(<CheckinConsole eventId={EVENT_ID} service={checkinService} />);
    await screen.findByRole("heading", { level: 2, name: "Find the attendee" });

    const announcement = screen.getByRole("status");
    expect(announcement).toHaveAttribute("aria-live", "polite");

    await userEvent.type(
      screen.getByLabelText("Registration ID, email, phone or name"),
      REGISTRATION.registration_id,
    );
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await userEvent.click(await screen.findByRole("button", { name: "Complete check-in" }));

    await screen.findByRole("heading", { name: "Scene handled." });
    expect(screen.getByRole("status")).toHaveTextContent(/checked in/i);
  });
});
