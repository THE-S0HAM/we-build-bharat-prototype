/**
 * Command Center behaviour (requirements 4.1–4.9, 13.1, 13.3, 13.8, design.md
 * §21.3 "Command Center").
 *
 * The page is judged by what a community leader can do with it in five seconds,
 * so every test here is a statement about the rendered screen rather than about
 * a call: the greeting, one decision surface, the visual over the *watched*
 * events, the handled strip, and the calm sentence when there is nothing to
 * decide.
 *
 * Only two boundaries are stubbed — `src/api.ts` and the Cognito token read. The
 * real `DecisionCard`, `ApprovalActions`, `EventOrbit`, `AgentStatus`, `Drawer`,
 * `StatusBadge`, `Timeline`, `EmptyState` and `ApiErrorState` all render, because
 * the requirements are about what those components produce together.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CALM_DESCRIPTION,
  CALM_TITLE,
  HANDLED_HEADING,
  LOADING_LABEL,
  ORBIT_HEADING,
  ORG_WIDE_HEADING,
} from "../command/commandView";
import { EventContext, type EventContextValue } from "../event/eventContext";
import { SessionContext, type SessionValue } from "../session/sessionContext";
import type { Approval, AuditEvent, CommandCenterData, Event, EventHealth, OperationsBrief } from "../types";
import { CommandCenter } from "./CommandCenter";

const api = vi.hoisted(() => ({
  getCommandCenter: vi.fn(),
  getApprovals: vi.fn(),
  getAuditLog: vi.fn(),
  getAttention: vi.fn(),
  getEventHealth: vi.fn(),
  getBrief: vi.fn(),
  decideApproval: vi.fn(),
}));

const cognito = vi.hoisted(() => ({ idToken: null as string | null }));

vi.mock("../api", () => ({
  getCommandCenter: api.getCommandCenter,
  getApprovals: api.getApprovals,
  getAuditLog: api.getAuditLog,
  getAttention: api.getAttention,
  getEventHealth: api.getEventHealth,
  getBrief: api.getBrief,
  decideApproval: api.decideApproval,
  humanize: (value: string) => value.charAt(0) + value.slice(1).toLowerCase(),
  isMockMode: false,
}));

vi.mock("../auth", () => ({
  getIdToken: () => Promise.resolve(cognito.idToken),
}));

/* --- Fixtures ------------------------------------------------------------- */

/** A token payload, base64url encoded the way Cognito issues one. */
function idToken(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `header.${payload}.signature`;
}

const ACTIVE_EVENT: Event = {
  event_id: "EVT-devcon-2026",
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

/**
 * Three watched events, two "active" in the summary and five events in the
 * organization. The three numbers are deliberately different, so a test can tell
 * which one the headline used (A13).
 */
const OVERVIEW: CommandCenterData = {
  organization_id: "ORG-wemakedev",
  summary: {
    active_events: 2,
    total_events: 5,
    pending_approvals: 2,
    critical_incidents: 1,
    overdue_tasks: 2,
  },
  events: [
    {
      event_id: "EVT-devcon-2026",
      name: "DevCon Bengaluru 2026",
      status: "ACTIVE",
      pending_approvals: 2,
      critical_incidents: 1,
      overdue_tasks: 2,
      blocked_tasks: 1,
      total_tasks: 9,
    },
    {
      event_id: "EVT-meetup",
      name: "Pune Community Meetup",
      status: "PUBLISHED",
      pending_approvals: 0,
      critical_incidents: 0,
      overdue_tasks: 0,
      blocked_tasks: 0,
      total_tasks: 4,
    },
    {
      event_id: "EVT-summit",
      name: "Hyderabad Summit",
      status: "PUBLISHED",
      pending_approvals: 0,
      critical_incidents: 0,
      overdue_tasks: 1,
      blocked_tasks: 0,
      total_tasks: 6,
    },
  ],
  recent_actions: [
    {
      audit_id: "AUD-org-1",
      organization_id: "ORG-wemakedev",
      event_id: "EVT-meetup",
      timestamp: "2026-10-02T08:00:00Z",
      action: "INCIDENT_DETECTED",
      actor_type: "agent",
      actor_id: "IncidentOps",
      resource_type: "Incident",
      resource_id: "INC-044",
      outcome: "success",
    },
    {
      audit_id: "AUD-org-2",
      organization_id: "ORG-wemakedev",
      event_id: "EVT-summit",
      timestamp: "2026-10-02T07:00:00Z",
      action: "TASK_CREATED",
      actor_type: "user",
      actor_id: "organiser-002",
      resource_type: "Task",
      resource_id: "TSK-091",
      outcome: "success",
    },
  ],
};

/** Every watched event calm: no approval, no incident, no overdue task. */
const CALM_OVERVIEW: CommandCenterData = {
  ...OVERVIEW,
  summary: { ...OVERVIEW.summary, pending_approvals: 0, critical_incidents: 0, overdue_tasks: 0 },
  events: OVERVIEW.events.map((event) => ({
    ...event,
    pending_approvals: 0,
    critical_incidents: 0,
    overdue_tasks: 0,
  })),
};

const OLDEST: Approval = {
  approval_id: "APR-002",
  event_id: "EVT-devcon-2026",
  title: "Send 3rd follow-up to Raj Malhotra",
  description: "SpeakerOps wants to send a 3rd follow-up to Raj Malhotra.",
  status: "PENDING",
  risk_level: "MEDIUM",
  requested_action: "SEND_SPEAKER_FOLLOWUP",
  reason: "Follow-up count exceeds the auto-send threshold",
  evidence: { speaker_id: "SPK-002", followup_count: 2 },
  affected_resource_type: "Speaker",
  affected_resource_id: "SPK-002",
  agent_name: "SpeakerOps",
  requested_at: "2026-10-01T09:00:00Z",
};

const NEWER: Approval = {
  ...OLDEST,
  approval_id: "APR-001",
  title: "Replace cancelled speaker with backup",
  requested_action: "RESOLVE_INCIDENT",
  reason: "Speaker cancellation — backup available",
  evidence: { incident_id: "INC-001", backup_speaker: "SPK-005" },
  affected_resource_type: "Incident",
  affected_resource_id: "INC-001",
  agent_name: "IncidentOps",
  requested_at: "2026-10-03T09:00:00Z",
};

/** The active event's audit: one agent action, one person's. */
const EVENT_AUDIT: AuditEvent[] = [
  {
    audit_id: "AUD-1",
    organization_id: "ORG-wemakedev",
    event_id: "EVT-devcon-2026",
    timestamp: "2026-10-02T09:00:00Z",
    action: "SPEAKER_FOLLOWUP_SENT",
    actor_type: "agent",
    actor_id: "SpeakerOps",
    resource_type: "Speaker",
    resource_id: "SPK-002",
    outcome: "success",
    tool_used: "send_speaker_invite",
  },
  {
    audit_id: "AUD-2",
    organization_id: "ORG-wemakedev",
    event_id: "EVT-devcon-2026",
    timestamp: "2026-10-02T08:30:00Z",
    action: "CHECKIN_COMPLETED",
    actor_type: "user",
    actor_id: "volunteer-001",
    resource_type: "CheckIn",
    resource_id: "REG-2026-004829",
    outcome: "success",
  },
];

const EVENT_HEALTH: EventHealth = {
  event_id: ACTIVE_EVENT.event_id,
  event_name: ACTIVE_EVENT.name,
  health_band: "YELLOW",
  health_score: 78,
  health_reasons: ["One decision needs review."],
  health_signals: [{ signal: "pending_approvals", points: 8, detail: "One decision needs review." }],
  health_summary: "The event is stable, with one decision needing review.",
  computed_at: "2026-10-02T10:00:00Z",
  inputs: {
    overdue_tasks: 2,
    blocked_tasks: 1,
    open_incidents: 1,
    silent_speakers: 0,
    stale_approvals: 1,
    budget_utilization_percent: 25,
    hours_until_start: 48,
    attendee_data_completeness_percent: 90,
  },
};

const EVENT_BRIEF: OperationsBrief = {
  event_id: ACTIVE_EVENT.event_id,
  event_name: ACTIVE_EVENT.name,
  generated_at: "2026-10-02T10:00:00Z",
  health_band: "YELLOW",
  health_score: 78,
  health_reasons: EVENT_HEALTH.health_reasons,
  decisions_required: 1,
  high_risk_items: 2,
  tasks_progressing: 6,
  overdue_tasks: 2,
  blocked_tasks: 1,
  open_incidents: 1,
  incidents_needing_attention: 1,
  budget: {
    total_inr: 100000,
    remaining_inr: 75000,
    remaining_formatted: "75,000",
    committed_inr: 10000,
    spent_inr: 15000,
    utilization_percent: 25,
    pending_exposure_inr: 5000,
  },
  speakers: { total: 4, confirmed: 3, pending: 1, unresponsive: 0, needing_accommodation: 1 },
  attention_items: [],
  recommended_priority: ["Decide: Venue deposit", "Unblock: Registration desk", "Review budget: catering"],
  hours_until_start: 48,
};

/* --- Harness -------------------------------------------------------------- */

const setActiveEvent = vi.fn<(eventId: string) => boolean>();
const signOut = vi.fn();

function commandCenterTree(activeEvent: Event = ACTIVE_EVENT, role: "LEADER" | "TEAM_MEMBER" = "LEADER") {
  const session: SessionValue = {
    status: "authenticated",
    user: {
      userId: "user-1",
      email: "priya@example.org",
      name: "Priya Sharma",
      role,
      organizations: ["ORG-wemakedev"],
      isDemo: false,
    },
    activeOrganizationId: "ORG-wemakedev",
    refresh: () => Promise.resolve(),
    signOut,
  };

  const events: EventContextValue = {
    status: "ready",
    activeEvent,
    activeEventId: activeEvent.event_id,
    events: activeEvent.event_id === ACTIVE_EVENT.event_id ? [ACTIVE_EVENT] : [ACTIVE_EVENT, activeEvent],
    source: "active",
    error: null,
    setActiveEvent,
    refresh: () => undefined,
  };

  return (
    <MemoryRouter>
      <SessionContext.Provider value={session}>
        <EventContext.Provider value={events}>
          <CommandCenter />
        </EventContext.Provider>
      </SessionContext.Provider>
    </MemoryRouter>
  );
}

function renderCommandCenter(activeEvent: Event = ACTIVE_EVENT, role: "LEADER" | "TEAM_MEMBER" = "LEADER") {
  return render(commandCenterTree(activeEvent, role));
}

beforeEach(() => {
  cognito.idToken = idToken({ name: "Priya Sharma", sub: "user-1" });
  api.getCommandCenter.mockResolvedValue(OVERVIEW);
  api.getApprovals.mockResolvedValue({ approvals: [NEWER, OLDEST], count: 2 });
  api.getAuditLog.mockResolvedValue({ audit_events: EVENT_AUDIT, count: EVENT_AUDIT.length });
  api.getAttention.mockResolvedValue({ event_id: ACTIVE_EVENT.event_id, attention_items: [], count: 0, critical_count: 0, high_count: 0 });
  api.getEventHealth.mockResolvedValue(EVENT_HEALTH);
  api.getBrief.mockResolvedValue(EVENT_BRIEF);
  api.decideApproval.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
});

/* --- Tests ---------------------------------------------------------------- */

describe("loading (requirement 13.1)", () => {
  it("renders skeletons in the shape of the page, not a spinner", () => {
    api.getCommandCenter.mockReturnValue(new Promise(() => undefined));

    renderCommandCenter();

    expect(screen.getByText(LOADING_LABEL)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: ORBIT_HEADING })).not.toBeInTheDocument();
  });
});

describe("the resolved page (requirements 4.1, 4.2, 4.3, 4.4, 4.6, 4.7)", () => {
  it("greets the signed-in leader with the active organization", async () => {
    renderCommandCenter();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Hello, Priya Sharma" }),
    ).toBeInTheDocument();
    expect(screen.getByText("ORG-wemakedev")).toBeInTheDocument();
  });

  it("takes the headline watched count from active_events, never total_events (A13)", async () => {
    renderCommandCenter();

    expect(
      await screen.findByText("CommunityOps is watching 2 events, of 5 total."),
    ).toBeInTheDocument();
    // `total_events` is 5 and counts drafts, so it is never the headline.
    expect(screen.queryByText(/watching 5/)).not.toBeInTheDocument();
  });

  it("renders exactly one decision surface, prioritising financial then highest severity", async () => {
    renderCommandCenter();

    const decision = await screen.findByRole("region", { name: "Needs your decision" });

    expect(
      within(decision).getByRole("heading", { name: NEWER.title }),
    ).toBeInTheDocument();
    expect(within(decision).queryByText(OLDEST.title)).not.toBeInTheDocument();

    // One surface, one set of decisions (requirements 4.1, 12.8).
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
  });

  it("asks only the watched events that have a pending approval for one", async () => {
    renderCommandCenter();

    await screen.findByRole("region", { name: "Needs your decision" });

    expect(api.getApprovals).toHaveBeenCalledTimes(1);
    expect(api.getApprovals).toHaveBeenCalledWith("EVT-devcon-2026");
  });

  it("keeps the agent's reasoning behind 'Why this action?' (requirement 4.9)", async () => {
    const user = userEvent.setup();

    renderCommandCenter();

    await screen.findByRole("region", { name: "Needs your decision" });
    expect(screen.queryByText(OLDEST.reason)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Why this action?" }));

    const drawer = screen.getByRole("dialog");

    expect(within(drawer).getByText(NEWER.reason)).toBeInTheDocument();
  });

  it("draws one node per watched event and states the same counts in text", async () => {
    renderCommandCenter();

    const orbit = await screen.findByRole("region", { name: ORBIT_HEADING });

    for (const event of OVERVIEW.events) {
      expect(
        within(orbit).getByRole("button", { name: new RegExp(event.name) }),
      ).toBeInTheDocument();
    }

    expect(within(orbit).getAllByRole("button")).toHaveLength(OVERVIEW.events.length);
    expect(
      within(orbit).getByText("3 active and published events in this view."),
    ).toBeInTheDocument();
    expect(
      within(orbit).getByText("2 decisions waiting, 1 critical incident, 2 overdue tasks, 1 blocked task."),
    ).toBeInTheDocument();
  });

  it("sets the active event when a node is selected (requirement 4.5)", async () => {
    const user = userEvent.setup();

    renderCommandCenter();

    const orbit = await screen.findByRole("region", { name: ORBIT_HEADING });

    await user.click(within(orbit).getByRole("button", { name: /Hyderabad Summit/ }));

    expect(setActiveEvent).toHaveBeenCalledWith("EVT-summit");
  });

  it("renders the active event's deterministic operational state without recomputing it", async () => {
    renderCommandCenter();

    const region = await screen.findByRole("region", { name: "Current operational state" });

    expect(api.getEventHealth).toHaveBeenCalledWith(ACTIVE_EVENT.event_id);
    expect(api.getBrief).toHaveBeenCalledWith(ACTIVE_EVENT.event_id);
    expect(within(region).getByText("Yellow.")).toBeInTheDocument();
    expect(within(region).getByText(EVENT_HEALTH.health_summary, { exact: false })).toBeInTheDocument();
    expect(within(region).getByText(/progressing 6 tasks/i)).toBeInTheDocument();
    expect(within(region).getByText(/1 decision and 2 high-risk items need review/i)).toBeInTheDocument();
    expect(within(region).getByText("Decide: Venue deposit")).toBeInTheDocument();
    expect(within(region).getByText("Unblock: Registration desk")).toBeInTheDocument();
    expect(within(region).getByText("Review budget: catering")).toBeInTheDocument();
  });

  it("clears health, brief, and attention immediately when the active event changes", async () => {
    const oldAttention = {
      kind: "TASK" as const,
      severity: "HIGH" as const,
      title: "Unblock the old event task",
      detail: "Waiting on venue access",
      resource_type: "Task",
      resource_id: "TSK-old",
    };
    api.getAttention.mockResolvedValueOnce({
      event_id: ACTIVE_EVENT.event_id,
      attention_items: [oldAttention],
      count: 1,
      critical_count: 0,
      high_count: 1,
    });
    const view = renderCommandCenter();

    expect(await screen.findByText(EVENT_HEALTH.health_summary, { exact: false })).toBeInTheDocument();
    expect(await screen.findByText(oldAttention.title)).toBeInTheDocument();

    const nextEvent: Event = { ...ACTIVE_EVENT, event_id: "EVT-next", name: "Next Event" };
    api.getEventHealth.mockReturnValue(new Promise(() => undefined));
    api.getBrief.mockReturnValue(new Promise(() => undefined));
    api.getAttention.mockReturnValue(new Promise(() => undefined));

    view.rerender(commandCenterTree(nextEvent));

    expect(screen.queryByText(EVENT_HEALTH.health_summary, { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByText(oldAttention.title)).not.toBeInTheDocument();
    expect(screen.getByText("Getting the current operational state…")).toBeInTheDocument();
    await waitFor(() => {
      expect(api.getEventHealth).toHaveBeenLastCalledWith(nextEvent.event_id);
      expect(api.getBrief).toHaveBeenLastCalledWith(nextEvent.event_id);
      expect(api.getAttention).toHaveBeenLastCalledWith(nextEvent.event_id);
    });
  });

  it("builds the handled strip from the active event's audit, agent actors only", async () => {
    renderCommandCenter();

    const strip = await screen.findByRole("region", { name: HANDLED_HEADING });

    expect(api.getAuditLog).toHaveBeenCalledWith("EVT-devcon-2026");
    expect(within(strip).getByText("Speaker follow-up sent")).toBeInTheDocument();
    // A volunteer's check-in is a person's action, so it is not what
    // CommunityOps is handling (requirement 4.6).
    expect(within(strip).queryByText("Check-in completed")).not.toBeInTheDocument();
  });

  it("labels the organization-wide feed as organization-wide (requirement 4.7)", async () => {
    renderCommandCenter();

    const orgWide = await screen.findByRole("region", { name: ORG_WIDE_HEADING });

    expect(
      within(orgWide).getByText(/across every event in ORG-wemakedev, not just this one/),
    ).toBeInTheDocument();
    // The org-wide feed is not agent-filtered: it is the whole organization.
    expect(within(orgWide).getByText("Task created")).toBeInTheDocument();
  });
});

describe("the calm state (requirement 4.8)", () => {
  it("renders the calm sentences with the handled strip, and asks for no approvals", async () => {
    api.getCommandCenter.mockResolvedValue(CALM_OVERVIEW);

    renderCommandCenter();

    expect(await screen.findByText(CALM_TITLE)).toBeInTheDocument();
    expect(screen.getByText(CALM_DESCRIPTION)).toBeInTheDocument();
    expect(api.getApprovals).not.toHaveBeenCalled();

    const strip = screen.getByRole("region", { name: HANDLED_HEADING });

    expect(within(strip).getByText("Speaker follow-up sent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });
});

describe("failures (requirements 13.3, 13.8)", () => {
  it("offers a retry that re-runs only the failed request", async () => {
    const user = userEvent.setup();

    api.getCommandCenter.mockRejectedValueOnce({ status: 500, category: "INTERNAL_ERROR" });

    renderCommandCenter();

    expect(await screen.findByText("CommunityOps couldn't load this view.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Hello, Priya Sharma" }),
    ).toBeInTheDocument();
    expect(api.getCommandCenter).toHaveBeenCalledTimes(2);
  });

  it("keeps operational-state failure and retry inside that region", async () => {
    const user = userEvent.setup();
    api.getEventHealth.mockRejectedValueOnce({ status: 500, category: "INTERNAL_ERROR" });

    renderCommandCenter();

    const region = await screen.findByRole("region", { name: "Current operational state" });
    expect(within(region).getByText("CommunityOps couldn't load this view.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();

    await user.click(within(region).getByRole("button", { name: "Try again" }));

    expect(await within(region).findByText(EVENT_HEALTH.health_summary, { exact: false })).toBeInTheDocument();
    expect(api.getEventHealth).toHaveBeenCalledTimes(2);
    expect(api.getBrief).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed handled strip inside the strip", async () => {
    api.getAuditLog.mockRejectedValue({ status: 500, category: "INTERNAL_ERROR" });

    renderCommandCenter();

    const strip = await screen.findByRole("region", { name: HANDLED_HEADING });

    expect(
      within(strip).getByText("CommunityOps couldn't load this view."),
    ).toBeInTheDocument();

    // The rest of the page is still usable: the decision is still decidable and
    // the visual still renders.
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: ORBIT_HEADING })).toBeInTheDocument();
  });
});

describe("recording a decision (requirements 5.7, 13.11, 15.8, A9)", () => {
  it("replaces the action row with the outcome and announces it", async () => {
    const user = userEvent.setup();

    renderCommandCenter();

    await screen.findByRole("region", { name: "Needs your decision" });
    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Decision recorded.")).toBeInTheDocument();
    expect(api.decideApproval).toHaveBeenCalledWith(
      "EVT-devcon-2026",
      "APR-001",
      "APPROVED",
      "",
      undefined,
    );

    // The concrete outcome, beside "Decision recorded." and with no claim that
    // the workflow resumes (A9).
    const result = screen.getByText("Decision recorded.").parentElement;

    expect(result).toHaveTextContent(
      "Incident resolution approved for later execution. This decision did not resolve the incident.",
    );
    expect(result).toHaveTextContent("CommunityOps prepared this action. You approved it.");
    expect(screen.queryByText(/continue from here/)).not.toBeInTheDocument();

    // The action row is gone, and the result was announced (requirement 15.8).
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      'Recorded: you approved "Replace cancelled speaker with backup".',
    );
  });

  it("settles the card when the decision was already taken elsewhere", async () => {
    const user = userEvent.setup();

    api.decideApproval.mockRejectedValue({ status: 409, category: "CONFLICT" });

    renderCommandCenter();

    await screen.findByRole("region", { name: "Needs your decision" });
    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("This was already decided elsewhere.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });
});


describe("edited decisions", () => {
  it("sends edited wording only as edited_action", async () => {
    const user = userEvent.setup();
    renderCommandCenter();
    await screen.findByRole("region", { name: "Needs your decision" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const field = screen.getByLabelText("Adjust the action CommunityOps will take");
    await user.clear(field);
    await user.type(field, "Assign the confirmed backup speaker");
    await user.click(screen.getByRole("button", { name: "Submit edit" }));

    expect(api.decideApproval).toHaveBeenCalledWith(
      "EVT-devcon-2026",
      "APR-001",
      "EDITED",
      "",
      "Assign the confirmed backup speaker",
    );
    expect(screen.getAllByText(/approved for later execution/i).length).toBeGreaterThan(0);
  });
});
