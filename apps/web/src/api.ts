/**
 * API client for the CommunityOps backend.
 *
 * One chokepoint, `apiFetch`, attaches the Cognito ID token the deployed user-pool authorizer
 * requires. Components never call `fetch` directly: a scattered request is one that can forget the
 * token, forget the organization scope, or invent its own error shape.
 *
 * Mock data is opt-in via `VITE_USE_MOCK=true` for local UI work with no backend. It is deliberately
 * **not** a fallback: when a real API URL is configured and the backend fails, the error surfaces
 * rather than being masked by fabricated operational data. Presenting invented figures as real
 * operational state is the one failure this product cannot afford.
 */

import { getIdToken, storeDemoSession } from "./auth";
import type {
  AgentActivityResponse,
  AgentCapabilities,
  AgentChatRequest,
  AgentChatResponse,
  ApprovalDecisionResponse,
  ApprovalDetailResponse,
  ApprovalListResponse,
  AttendeeOpsResponse,
  AttentionResponse,
  AuditEvent,
  BudgetProjection,
  BudgetSummary,
  CommandCenterData,
  DemoSession,
  Event,
  EventHealth,
  Expense,
  FollowupDraft,
  IncidentDetailResponse,
  IncidentListResponse,
  Notification,
  OperationsBrief,
  ReconcileResult,
  SearchResult,
  SpeakerListResponse,
  Task,
  TaskListResponse,
  TeamMember,
  TeamSummary,
  TicketResult,
  VerificationCheck,
  VerifiedRegistration,
  WorkloadResponse,
} from "./types";

const API_BASE = import.meta.env.VITE_API_URL || "";
const ORG_ID = import.meta.env.VITE_ORG_ID || "ORG-wemakedev";
const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";

export const isMockMode = USE_MOCK;
export const organizationId = ORG_ID;

/** The event the console operates on by default. Overridable per call. */
export const DEFAULT_EVENT_ID = import.meta.env.VITE_EVENT_ID || "EVT-acd-mh-2026";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly category?: string,
  ) {
    super(message);
  }

  /** True when the backend refused on authorization rather than failing. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** True when the session is gone and the user needs to sign in again. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

interface FetchOptions extends RequestInit {
  /** Set for the demo-session route, which is the only unauthenticated endpoint. */
  anonymous?: boolean;
}

async function apiFetch<T>(path: string, options?: FetchOptions): Promise<T> {
  if (USE_MOCK) {
    return mockFetch<T>(path, options);
  }

  if (!API_BASE) {
    throw new ApiError(
      "No API URL is configured. Set VITE_API_URL to the deployed API, or VITE_USE_MOCK=true for local demo data.",
      0,
      "CONFIGURATION_ERROR",
    );
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (!options?.anonymous) {
    const token = await getIdToken();
    if (!token) {
      throw new ApiError("Your session has expired. Please sign in again.", 401, "UNAUTHORIZED");
    }
    // The authorizer expects the bare token, not a Bearer prefix.
    headers.Authorization = token;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { ...headers, ...options?.headers },
    });
  } catch {
    // A network failure is distinct from a backend error and needs a different message: there is
    // nothing wrong with the request, so "try again" is the right advice.
    throw new ApiError(
      "Could not reach CommunityOps. Check your connection and try again.",
      0,
      "NETWORK_ERROR",
    );
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new ApiError(
      err.message || `Request failed (HTTP ${res.status})`,
      res.status,
      err.error,
    );
  }

  // 204 and empty bodies are valid for mutations.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Build a query string, dropping empty values so URLs stay readable. */
function query(params: Record<string, string | number | boolean | undefined>): string {
  const pairs = Object.entries({ organization_id: ORG_ID, ...params })
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return pairs.length ? `?${pairs.join("&")}` : "";
}

/** Body for a mutation. Every write carries the organization the backend authorizes against. */
function body(payload: Record<string, unknown>): string {
  return JSON.stringify({ organization_id: ORG_ID, ...payload });
}

// =============================================================
// Demo access
// =============================================================

/**
 * Start a demo session.
 *
 * The browser sends no parameters. The backend holds the password and authenticates one fixed
 * restricted identity, so no credential is present in this bundle. The returned token is stored the
 * same way a normal session is.
 */
export async function startDemoSession(): Promise<DemoSession> {
  const session = await apiFetch<DemoSession>("/demo/session", {
    method: "POST",
    anonymous: true,
    body: "{}",
  });
  storeDemoSession(
    session.id_token,
    {
      email: session.email,
      organization_id: session.organization_id,
      role: session.role,
    },
    session.expires_in,
  );
  return session;
}

// =============================================================
// Command Center and operations views
// =============================================================

export async function getCommandCenter(): Promise<CommandCenterData> {
  return apiFetch(`/command-center${query({})}`);
}

export async function getAttention(eventId: string): Promise<AttentionResponse> {
  return apiFetch(`/events/${eventId}/attention${query({})}`);
}

export async function getBrief(eventId: string): Promise<OperationsBrief> {
  return apiFetch(`/events/${eventId}/brief${query({})}`);
}

export async function getEventHealth(eventId: string): Promise<EventHealth> {
  return apiFetch(`/events/${eventId}/health${query({})}`);
}

export async function getWorkload(eventId: string): Promise<WorkloadResponse> {
  return apiFetch(`/events/${eventId}/workload${query({})}`);
}

export async function getAttendeeOps(eventId: string): Promise<AttendeeOpsResponse> {
  return apiFetch(`/events/${eventId}/attendees${query({})}`);
}

// =============================================================
// Events
// =============================================================

export async function getEvents(): Promise<{ events: Event[]; count: number }> {
  return apiFetch(`/events${query({})}`);
}

export async function getEvent(eventId: string): Promise<Event & Record<string, unknown>> {
  return apiFetch(`/events/${eventId}${query({})}`);
}

// =============================================================
// Teams and tasks
// =============================================================

export async function getTeams(eventId: string): Promise<{ teams: TeamSummary[]; count: number }> {
  return apiFetch(`/events/${eventId}/teams${query({})}`);
}

export async function getTeam(
  eventId: string,
  teamId: string,
): Promise<{ team: TeamSummary; members: TeamMember[]; tasks: Task[] }> {
  return apiFetch(`/events/${eventId}/teams/${teamId}${query({})}`);
}

/**
 * Every task for an event in one request.
 *
 * Replaces the previous approach of one request per team flattened client-side, which meant eight
 * round trips to render one page and counts that could disagree with the command centre's.
 */
export async function getEventTasks(
  eventId: string,
  filters: { status?: string; team_id?: string; assigned_to?: string; mine?: boolean } = {},
): Promise<TaskListResponse> {
  return apiFetch(`/events/${eventId}/tasks${query(filters)}`);
}

export async function getTeamTasks(eventId: string, teamId: string): Promise<TaskListResponse> {
  return apiFetch(`/events/${eventId}/teams/${teamId}/tasks${query({})}`);
}

export async function updateTask(
  eventId: string,
  teamId: string,
  taskId: string,
  updates: Partial<Pick<Task, "status" | "priority" | "notes" | "blocked_reason" | "due_date" | "assigned_to">>,
): Promise<{ task_id: string; status: string; message: string }> {
  return apiFetch(`/events/${eventId}/teams/${teamId}/tasks/${taskId}`, {
    method: "PUT",
    body: body(updates),
  });
}

export async function reassignTask(
  eventId: string,
  teamId: string,
  taskId: string,
  assignedTo: string,
  reason = "",
): Promise<{ task_id: string; assigned_to: string; message: string }> {
  return apiFetch(`/events/${eventId}/teams/${teamId}/tasks/${taskId}/reassign`, {
    method: "POST",
    body: body({ assigned_to: assignedTo, reason }),
  });
}

export async function createTask(
  eventId: string,
  teamId: string,
  task: { title: string; description?: string; priority?: string; due_date?: string },
): Promise<{ task_id: string; status: string; message: string }> {
  return apiFetch(`/events/${eventId}/teams/${teamId}/tasks`, {
    method: "POST",
    body: body(task),
  });
}

// =============================================================
// Speakers
// =============================================================

export async function getSpeakers(
  eventId: string,
  status?: string,
): Promise<SpeakerListResponse> {
  return apiFetch(`/events/${eventId}/speakers${query({ status })}`);
}

/** Draft a follow-up. Does not send: sending is approval-gated. */
export async function draftSpeakerFollowup(
  eventId: string,
  speakerId: string,
): Promise<FollowupDraft> {
  return apiFetch(`/events/${eventId}/speakers/${speakerId}/followup`, {
    method: "POST",
    body: body({}),
  });
}

// =============================================================
// Incidents
// =============================================================

export async function getIncidents(
  eventId: string,
  openOnly = false,
): Promise<IncidentListResponse> {
  return apiFetch(`/events/${eventId}/incidents${query({ open_only: openOnly || undefined })}`);
}

export async function getIncident(
  eventId: string,
  incidentId: string,
): Promise<IncidentDetailResponse> {
  return apiFetch(`/events/${eventId}/incidents/${incidentId}${query({})}`);
}

export async function addIncidentComment(
  eventId: string,
  incidentId: string,
  payload: {
    body: string;
    parent_comment_id?: string;
    create_task?: boolean;
    task_team_id?: string;
    task_title?: string;
    task_priority?: string;
    task_due_date?: string;
  },
): Promise<{ comment_id: string; created_task_id: string | null; message: string }> {
  return apiFetch(`/events/${eventId}/incidents/${incidentId}/comments`, {
    method: "POST",
    body: body(payload),
  });
}

export async function updateIncident(
  eventId: string,
  incidentId: string,
  updates: Record<string, unknown>,
): Promise<{ incident_id: string; message: string }> {
  return apiFetch(`/events/${eventId}/incidents/${incidentId}`, {
    method: "PUT",
    body: body(updates),
  });
}

export async function resolveIncident(
  eventId: string,
  incidentId: string,
  resolution: { resolution_summary: string; root_cause?: string; actions_taken?: string[] },
): Promise<{ incident_id: string; status: string; message: string }> {
  return apiFetch(`/events/${eventId}/incidents/${incidentId}/resolve`, {
    method: "POST",
    body: body(resolution),
  });
}

export async function reportIncident(
  eventId: string,
  incident: {
    title: string;
    description?: string;
    severity?: string;
    category?: string;
    team_id?: string;
  },
): Promise<{ incident_id: string; status: string; message: string }> {
  return apiFetch(`/events/${eventId}/incidents`, { method: "POST", body: body(incident) });
}

// =============================================================
// Approvals
// =============================================================

export async function getApprovals(
  eventId: string,
  status?: string,
): Promise<ApprovalListResponse> {
  return apiFetch(`/events/${eventId}/approvals${query({ status })}`);
}

export async function getApproval(
  eventId: string,
  approvalId: string,
): Promise<ApprovalDetailResponse> {
  return apiFetch(`/events/${eventId}/approvals/${approvalId}${query({})}`);
}

/**
 * Decide an approval.
 *
 * The response carries the recomputed budget when the request was financial. That figure is
 * displayed as-is — the frontend never subtracts the amount itself, because a number it calculated
 * could differ from the one the backend actually committed.
 */
export async function decideApproval(
  eventId: string,
  approvalId: string,
  decision: "APPROVED" | "DECLINED" | "EDITED",
  options: { notes?: string; edited_action?: string } = {},
): Promise<ApprovalDecisionResponse> {
  return apiFetch(`/events/${eventId}/approvals/${approvalId}`, {
    method: "PUT",
    body: body({ decision, ...options }),
  });
}

export async function requestApproval(
  eventId: string,
  request: {
    title: string;
    requested_action: string;
    description?: string;
    reason?: string;
    amount_inr?: number;
    budget_category?: string;
  },
): Promise<{ approval_id: string; status: string; message: string }> {
  return apiFetch(`/events/${eventId}/approvals`, { method: "POST", body: body(request) });
}

// =============================================================
// Budget
// =============================================================

export async function getBudget(eventId: string): Promise<BudgetSummary> {
  return apiFetch(`/events/${eventId}/budget${query({})}`);
}

export async function getExpenses(
  eventId: string,
): Promise<{ expenses: Expense[]; count: number; total_inr: number }> {
  return apiFetch(`/events/${eventId}/budget/expenses${query({})}`);
}

/** Preview a commitment without writing. Same arithmetic the approve path runs. */
export async function projectBudget(
  eventId: string,
  category: string,
  amountInr: number,
): Promise<{ projection: BudgetProjection; budget: BudgetSummary }> {
  return apiFetch(`/events/${eventId}/budget/projection`, {
    method: "POST",
    body: body({ category, amount_inr: amountInr }),
  });
}

// =============================================================
// Audit
// =============================================================

export async function getAuditLog(
  eventId: string,
  limit = 100,
): Promise<{ audit_events: AuditEvent[]; count: number }> {
  return apiFetch(`/events/${eventId}/audit${query({ limit })}`);
}

// =============================================================
// Agent
// =============================================================

export async function agentChat(request: AgentChatRequest): Promise<AgentChatResponse> {
  return apiFetch("/agent/chat", { method: "POST", body: body({ ...request }) });
}

export async function getAgentCapabilities(): Promise<AgentCapabilities> {
  return apiFetch(`/agent/capabilities${query({})}`);
}

export async function getAgentActivity(eventId?: string): Promise<AgentActivityResponse> {
  return apiFetch(`/agent/activity${query({ event_id: eventId })}`);
}

// =============================================================
// Check-in
// =============================================================

export async function searchCheckin(
  eventId: string,
  searchParams: Record<string, string>,
): Promise<SearchResult> {
  return apiFetch(`/events/${eventId}/checkin/search`, {
    method: "POST",
    body: body(searchParams),
  });
}

export async function verifyCheckin(
  eventId: string,
  registrationId: string,
): Promise<{
  registration_id: string;
  verification: { all_passed: boolean; checks: VerificationCheck[] };
  registration: VerifiedRegistration;
}> {
  return apiFetch(`/events/${eventId}/checkin/verify`, {
    method: "POST",
    body: body({ registration_id: registrationId }),
  });
}

export async function recoverTicket(
  eventId: string,
  registrationId: string,
): Promise<TicketResult> {
  return apiFetch(`/events/${eventId}/checkin/recover`, {
    method: "POST",
    body: body({ registration_id: registrationId }),
  });
}

export async function completeCheckin(
  eventId: string,
  registrationId: string,
): Promise<{ registration_id: string; status: string; was_already_checked_in: boolean }> {
  return apiFetch(`/events/${eventId}/checkin/complete`, {
    method: "POST",
    body: body({ registration_id: registrationId }),
  });
}

/**
 * Reconcile a check-in against a payment reference.
 *
 * A failure to match is a 200 with `reconciled: false`, not an error: the backend has
 * successfully determined that this reference cannot be verified and has opened a recovery
 * case. That is an answer, and the volunteer needs to read it rather than see a red banner.
 */
export async function reconcilePayment(
  eventId: string,
  transactionId: string,
): Promise<ReconcileResult> {
  return apiFetch(`/events/${eventId}/checkin/reconcile`, {
    method: "POST",
    body: body({ transaction_id: transactionId }),
  });
}

// =============================================================
// Notifications
// =============================================================

export async function getNotifications(
  unreadOnly = false,
): Promise<{ notifications: Notification[]; count: number; unread_count: number }> {
  return apiFetch(`/notifications${query({ unread_only: unreadOnly || undefined })}`);
}

export async function markNotificationRead(notificationId: string): Promise<unknown> {
  return apiFetch(`/notifications/${notificationId}/read`, { method: "PUT", body: body({}) });
}

// =============================================================
// Formatting helpers
//
// Money arrives from the backend as integer rupees. These format for display only — no arithmetic
// happens here, because a figure computed in the browser can disagree with the committed one.
// =============================================================

/** Indian digit grouping: 250000 -> "2,50,000". `Intl` with en-IN produces this correctly. */
export function formatInr(amount: number | undefined | null): string {
  if (amount === undefined || amount === null) return "—";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(amount);
}

export function formatInrWithSymbol(amount: number | undefined | null): string {
  if (amount === undefined || amount === null) return "—";
  return `₹${formatInr(amount)}`;
}

export function formatTime(timestamp: string | undefined): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatDate(timestamp: string | undefined): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(timestamp: string | undefined): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return `${formatDate(timestamp)}, ${formatTime(timestamp)}`;
}

/** "3 days ago", "in 4 hours". Relative time reads faster than a timestamp for recency. */
export function formatRelative(timestamp: string | undefined): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = date.getTime() - Date.now();
  const future = diffMs > 0;
  const mins = Math.round(Math.abs(diffMs) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}

/** Turn SCREAMING_SNAKE into readable text: "TASK_CREATED" -> "Task created". */
export function humanize(value: string | undefined): string {
  if (!value) return "";
  const words = value.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// =============================================================
// Mock data — local UI work only, never a fallback
// =============================================================

const MOCK_EVENT_ID = "EVT-acd-mh-2026";

const MOCK_COMMAND_CENTER: CommandCenterData = {
  organization_id: ORG_ID,
  role: "LEADER",
  summary: {
    active_events: 1,
    total_events: 1,
    pending_approvals: 5,
    critical_incidents: 0,
    open_incidents: 2,
    overdue_tasks: 2,
    blocked_tasks: 2,
    unresponsive_speakers: 1,
    budget_remaining_inr: 75000,
    budget_remaining_formatted: "75,000",
    attention_required: 8,
  },
  events: [
    {
      event_id: MOCK_EVENT_ID,
      name: "AWS Community Day — Maharashtra 2026",
      status: "ACTIVE",
      start_date: new Date(Date.now() + 21 * 864e5).toISOString(),
      health_band: "ORANGE",
      health_score: 52,
      health_reasons: [
        "Unresolved: 1 high-severity incident, 1 low-severity incident",
        "2 overdue tasks",
        "1 speaker unresponsive, longest 96h",
      ],
      detailed: true,
      pending_approvals: 5,
      critical_incidents: 0,
      open_incidents: 2,
      overdue_tasks: 2,
      blocked_tasks: 2,
      total_tasks: 31,
      completed_tasks: 6,
      teams: 8,
      speakers: 5,
      confirmed_speakers: 3,
      registered: 286,
      checked_in: 13,
      budget_remaining_inr: 75000,
      budget_utilization_percent: 70,
    },
  ],
  attention_items: [
    {
      kind: "INCIDENT",
      severity: "HIGH",
      title: "Main hall projector failed during AV testing",
      detail: "HIGH incident, status RECOMMENDATION_READY",
      resource_type: "Incident",
      resource_id: "INC-001",
      event_id: MOCK_EVENT_ID,
    },
    {
      kind: "APPROVAL",
      severity: "HIGH",
      title: "Accommodation for Kavya Nair — 2 nights",
      detail: "AccommodationCommitment — 12,500 INR",
      resource_type: "Approval",
      resource_id: "APR-001",
      event_id: MOCK_EVENT_ID,
    },
    {
      kind: "SPEAKER",
      severity: "HIGH",
      title: "Raj Malhotra has not responded",
      detail: "No reply for 96h on 'Cloud-Native Architecture Patterns'",
      resource_type: "Speaker",
      resource_id: "SPK-002",
      event_id: MOCK_EVENT_ID,
    },
    {
      kind: "TASK",
      severity: "MEDIUM",
      title: "2 overdue tasks",
      detail: "Reconcile payment records, Generate tickets for pending registrations",
      resource_type: "Task",
      resource_id: "TSK-rg02",
      event_id: MOCK_EVENT_ID,
    },
  ],
  recent_actions: [
    {
      audit_id: "AUD-m1",
      organization_id: ORG_ID,
      event_id: MOCK_EVENT_ID,
      timestamp: new Date(Date.now() - 2 * 36e5).toISOString(),
      action: "AGENT_PREPARE_SPEAKER_FOLLOWUP",
      actor_type: "agent",
      actor_id: "CommunityOps",
      resource_type: "Speaker",
      resource_id: "SPK-002",
      outcome: "success",
      tool_used: "prepare_speaker_followup",
    },
    {
      audit_id: "AUD-m2",
      organization_id: ORG_ID,
      event_id: MOCK_EVENT_ID,
      timestamp: new Date(Date.now() - 4.5 * 36e5).toISOString(),
      action: "AGENT_ADD_INCIDENT_COMMENT",
      actor_type: "agent",
      actor_id: "CommunityOps",
      resource_type: "IncidentComment",
      resource_id: "CMT-004",
      outcome: "success",
      tool_used: "add_incident_comment",
    },
  ],
};

async function mockFetch<T>(path: string, options?: FetchOptions): Promise<T> {
  // A small delay so loading states are actually visible while building them.
  await new Promise((r) => setTimeout(r, 180));

  const method = options?.method ?? "GET";

  if (path.startsWith("/demo/session")) {
    return {
      id_token: "mock.demo.token",
      expires_in: 3600,
      email: "demo@communityops.local",
      organization_id: ORG_ID,
      role: "TEAM_MEMBER",
      is_demo: true,
      message: "Mock demo session.",
    } as T;
  }
  if (path.startsWith("/command-center")) return MOCK_COMMAND_CENTER as T;
  if (path.includes("/attention")) {
    return {
      event_id: MOCK_EVENT_ID,
      attention_items: MOCK_COMMAND_CENTER.attention_items,
      count: MOCK_COMMAND_CENTER.attention_items.length,
      critical_count: 0,
      high_count: 3,
    } as T;
  }
  if (path.includes("/agent/capabilities")) {
    return {
      role: "LEADER",
      model_id: "anthropic.claude-sonnet-4-20250514-v1:0",
      model_region: "us-east-1",
      tool_count: 30,
      tools: [],
      automatic: ["get_event", "list_tasks", "create_task"],
      requires_approval: ["record_expense", "confirm_speaker"],
      withheld_from_role: [],
      notes: ["Mock capabilities."],
    } as T;
  }
  if (path.startsWith("/agent/chat") && method === "POST") {
    return {
      session_id: "mock-session",
      reply:
        "One decision needs you: accommodation for Kavya Nair at ₹12,500. Everything else is being handled.",
      tools_used: ["get_event_risk", "list_approvals"],
      approvals_created: [],
      turns_taken: 2,
      latency_ms: 900,
      truncated: false,
      evidence: [
        { tool: "get_event_risk", summary: "ORANGE at 52/100" },
        { tool: "list_approvals", summary: "5 records" },
      ],
    } as T;
  }

  // Anything not explicitly mocked returns empty rather than fabricating a shape the UI would
  // then render as real operational state.
  return {} as T;
}
