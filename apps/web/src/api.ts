/** Typed API client. Backend responses remain authoritative. */
import { getIdToken, storeDemoSession } from "./auth";
import { resolveOrganization, type ResolvedOrganization } from "./orgContext";
import type {
  AgentActivityResponse, AgentCapabilities, AgentChatRequest, AgentChatResponse,
  ApprovalDecisionResponse, ApprovalDetailResponse, ApprovalListResponse,
  AttendeeOpsResponse, AttentionResponse, AuditEvent, BudgetProjection, BudgetSummary,
  CommandCenterData, CompleteCheckinResponse, DemoSession, Event, EventHealth, Expense,
  FollowupDraft, IncidentDetailResponse, IncidentListResponse, IncidentUpdateInput, OperationsBrief,
  ReconcileResult, SearchResult, SpeakerListResponse, Task, TaskListResponse, Team,
  TeamMember, TicketResult, VerifyCheckinResponse, VerifyQrResponse, WorkloadResponse,
} from "./types";

const API_BASE = import.meta.env.VITE_API_URL || "";
const FALLBACK_ORGANIZATION_ID = import.meta.env.VITE_ORG_ID || "ORG-wemakedev";
const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";
export const isMockMode = USE_MOCK;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly category?: string) { super(message); }
  get isForbidden(): boolean { return this.status === 403; }
  get isUnauthenticated(): boolean { return this.status === 401; }
}

type ScopedRequest = { readonly path: string; readonly init?: RequestInit };
interface ErrorPayload { message?: string; error?: string; }

export async function getOrganizationContext(): Promise<ResolvedOrganization> {
  if (USE_MOCK) return { organizationId: FALLBACK_ORGANIZATION_ID, selectable: [FALLBACK_ORGANIZATION_ID], source: "fallback" };
  const token = await getIdToken();
  if (!token) throw new ApiError("Your session has expired. Please sign in again.", 401, "UNAUTHORIZED");
  return resolveAuthenticatedOrganization(token);
}

function resolveAuthenticatedOrganization(token: string): ResolvedOrganization {
  const organization = resolveOrganization({
    idToken: token,
    fallbackOrganizationId: FALLBACK_ORGANIZATION_ID,
  });
  if (organization.selectable.length === 0) {
    throw new ApiError(
      "Your account is not assigned to a CommunityOps organization.",
      403,
      "FORBIDDEN",
    );
  }
  return organization;
}

function isErrorPayload(value: unknown): value is ErrorPayload {
  return typeof value === "object" && value !== null;
}

async function readResponse<T>(response: Response): Promise<T> {
  const text = typeof response.text === "function" ? await response.text() : "";
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  } else if (typeof response.json === "function") {
    parsed = await response.json().catch(() => null);
  }
  if (!response.ok) {
    const shaped = isErrorPayload(parsed) ? parsed : null;
    throw new ApiError(shaped?.message || `Request failed (HTTP ${response.status})`, response.status, shaped?.error);
  }
  return (parsed ?? {}) as T;
}

async function apiFetch<T>(buildRequest: (organizationId: string) => ScopedRequest): Promise<T> {
  if (USE_MOCK) {
    const request = buildRequest(FALLBACK_ORGANIZATION_ID);
    return mockFetch<T>(request.path, request.init);
  }
  if (!API_BASE) throw new ApiError("No API URL is configured.", 0, "CONFIGURATION_ERROR");
  const token = await getIdToken();
  if (!token) throw new ApiError("Your session has expired. Please sign in again.", 401, "UNAUTHORIZED");
  const { organizationId } = resolveAuthenticatedOrganization(token);
  const { path, init } = buildRequest(organizationId);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", Authorization: token, ...init?.headers } });
  } catch {
    throw new ApiError("Could not reach CommunityOps. Check your connection and try again.", 0, "NETWORK_ERROR");
  }
  return readResponse<T>(response);
}

async function anonymousFetch<T>(path: string, init: RequestInit): Promise<T> {
  if (USE_MOCK) return mockFetch<T>(path, init);
  if (!API_BASE) throw new ApiError("No API URL is configured.", 0, "CONFIGURATION_ERROR");
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", ...init.headers } });
  } catch {
    throw new ApiError("Could not reach CommunityOps. Check your connection and try again.", 0, "NETWORK_ERROR");
  }
  return readResponse<T>(response);
}

function pathId(value: string): string { return encodeURIComponent(value); }
function orgQuery(org: string, params: ReadonlyArray<readonly [string, string | number | boolean | undefined]> = []): string {
  const query = new URLSearchParams({ organization_id: org });
  for (const [key, value] of params) if (value !== undefined && value !== "") query.set(key, String(value));
  return query.toString();
}
function jsonBody<T extends object>(organizationId: string, payload: T): string {
  return JSON.stringify({ ...payload, organization_id: organizationId });
}

function isDemoSessionPayload(value: unknown): value is DemoSession {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DemoSession>;
  return (
    typeof candidate.id_token === "string" &&
    candidate.id_token.trim() !== "" &&
    typeof candidate.expires_in === "number" &&
    Number.isFinite(candidate.expires_in) &&
    candidate.expires_in > 0 &&
    typeof candidate.email === "string" &&
    candidate.email.trim() !== "" &&
    typeof candidate.organization_id === "string" &&
    candidate.organization_id.startsWith("ORG-") &&
    candidate.role === "TEAM_MEMBER" &&
    candidate.is_demo === true &&
    typeof candidate.message === "string"
  );
}

export async function startDemoSession(): Promise<DemoSession> {
  const candidate = await anonymousFetch<unknown>("/demo/session", { method: "POST", body: "{}" });
  if (!isDemoSessionPayload(candidate)) {
    throw new ApiError("Demo access returned an invalid session.", 502, "EXTERNAL_SERVICE_ERROR");
  }
  storeDemoSession(candidate);
  return candidate;
}

export const getCommandCenter = (): Promise<CommandCenterData> => apiFetch((org) => ({ path: `/command-center?${orgQuery(org)}` }));
export const getAttention = (eventId: string): Promise<AttentionResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/attention?${orgQuery(org)}` }));
export const getBrief = (eventId: string): Promise<OperationsBrief> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/brief?${orgQuery(org)}` }));
export const getEventHealth = (eventId: string): Promise<EventHealth> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/health?${orgQuery(org)}` }));
export const getWorkload = (eventId: string): Promise<WorkloadResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/workload?${orgQuery(org)}` }));
export const getAttendeeOps = (eventId: string): Promise<AttendeeOpsResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/attendees?${orgQuery(org)}` }));

export const getEvents = (): Promise<{ events: Event[]; count: number }> => apiFetch((org) => ({ path: `/events?${orgQuery(org)}` }));
export const getEvent = (eventId: string): Promise<Event> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}?${orgQuery(org)}` }));

export const getTeams = (eventId: string): Promise<{ teams: Team[]; count: number }> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/teams?${orgQuery(org)}` }));
export const getTeam = (eventId: string, teamId: string): Promise<{ team: Team; members: TeamMember[]; tasks: Task[] }> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/teams/${pathId(teamId)}?${orgQuery(org)}` }));
export const getEventTasks = (eventId: string, filters: { status?: string; team_id?: string; assigned_to?: string; mine?: boolean } = {}): Promise<TaskListResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/tasks?${orgQuery(org, [["status", filters.status], ["team_id", filters.team_id], ["assigned_to", filters.assigned_to], ["mine", filters.mine]])}` }));
export const getTasks = (eventId: string, teamId: string): Promise<TaskListResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/teams/${pathId(teamId)}/tasks?${orgQuery(org)}` }));
export const getTeamTasks = getTasks;
export function updateTask(eventId: string, teamId: string, taskId: string, updates: Partial<Pick<Task, "status" | "priority" | "notes" | "blocked_reason" | "due_date" | "risk" | "escalation_level">>): Promise<{ task_id: string; status: string; message: string }> {
  return apiFetch((org) => ({ path: `/events/${pathId(eventId)}/teams/${pathId(teamId)}/tasks/${pathId(taskId)}`, init: { method: "PUT", body: jsonBody(org, updates) } }));
}

export function reassignTask(
  eventId: string,
  teamId: string,
  taskId: string,
  reassignment: { assigned_to: string; reason: string },
): Promise<{ task_id: string; assigned_to: string; message: string }> {
  return apiFetch((org) => ({
    path: `/events/${pathId(eventId)}/teams/${pathId(teamId)}/tasks/${pathId(taskId)}/reassign`,
    init: { method: "POST", body: jsonBody(org, reassignment) },
  }));
}

export const getSpeakers = (eventId: string, status?: string): Promise<SpeakerListResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/speakers?${orgQuery(org, [["status", status]])}` }));
export const draftSpeakerFollowup = (eventId: string, speakerId: string): Promise<FollowupDraft> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/speakers/${pathId(speakerId)}/followup`, init: { method: "POST", body: jsonBody(org, {}) } }));
export function updateSpeaker(eventId: string, speakerId: string, updates: Partial<Pick<import("./types").Speaker, "status" | "topic" | "session_type" | "travel_required" | "accommodation_required" | "is_backup">>): Promise<{ speaker_id: string; message: string }> {
  return apiFetch((org) => ({ path: `/events/${pathId(eventId)}/speakers/${pathId(speakerId)}`, init: { method: "PUT", body: jsonBody(org, updates) } }));
}

export const getIncidents = (eventId: string, openOnly = false): Promise<IncidentListResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/incidents?${orgQuery(org, [["open_only", openOnly || undefined]])}` }));
export const getIncident = (eventId: string, incidentId: string): Promise<IncidentDetailResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/incidents/${pathId(incidentId)}?${orgQuery(org)}` }));
export const getIncidentComments = (eventId: string, incidentId: string): Promise<{ comments: import("./types").IncidentComment[]; count: number }> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/incidents/${pathId(incidentId)}/comments?${orgQuery(org)}` }));
export interface IncidentCommentInput { body: string; parent_comment_id?: string; team_id?: string; create_task?: boolean; task_team_id?: string; task_title?: string; task_due_date?: string; task_description?: string; task_priority?: SeverityString; task_assigned_to?: string; task_assigned_to_name?: string; }
type SeverityString = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export const addIncidentComment = (eventId: string, incidentId: string, input: IncidentCommentInput): Promise<import("./types").AddIncidentCommentResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/incidents/${pathId(incidentId)}/comments`, init: { method: "POST", body: jsonBody(org, input) } }));
export const updateIncident = (eventId: string, incidentId: string, updates: IncidentUpdateInput): Promise<{ incident_id: string; message: string }> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/incidents/${pathId(incidentId)}`, init: { method: "PUT", body: jsonBody(org, updates) } }));
export const resolveIncident = (eventId: string, incidentId: string, resolution: { resolution_summary: string; root_cause?: string; actions_taken?: string[] }): Promise<{ incident_id: string; status: "RESOLVED"; message: string }> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/incidents/${pathId(incidentId)}/resolve`, init: { method: "POST", body: jsonBody(org, resolution) } }));
export const reopenIncident = (eventId: string, incidentId: string, reason = ""): Promise<{ incident_id: string; status: "REOPENED"; message: string }> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/incidents/${pathId(incidentId)}/reopen`, init: { method: "POST", body: jsonBody(org, { reason }) } }));

export const getApprovals = (eventId: string, status?: string): Promise<ApprovalListResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/approvals?${orgQuery(org, [["status", status]])}` }));
export const getApproval = (eventId: string, approvalId: string): Promise<ApprovalDetailResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/approvals/${pathId(approvalId)}?${orgQuery(org)}` }));
export function decideApproval(eventId: string, approvalId: string, decision: "APPROVED" | "DECLINED" | "EDITED", notes = "", editedAction?: string): Promise<ApprovalDecisionResponse> {
  return apiFetch((org) => ({ path: `/events/${pathId(eventId)}/approvals/${pathId(approvalId)}`, init: { method: "PUT", body: jsonBody(org, { decision, notes, ...(editedAction === undefined ? {} : { edited_action: editedAction }) }) } }));
}

export interface SetBudgetInput { readonly total_budget: number; }
export interface BudgetAllocationInput { readonly category: string; readonly amount_inr: number; readonly notes?: string; }
export interface RecordExpenseInput { readonly category: string; readonly amount_inr: number; readonly description: string; readonly vendor?: string; readonly approval_id?: string; }
export interface BudgetMutationResponse { readonly message: string; }
export interface RecordExpenseResponse extends BudgetMutationResponse { readonly expense_id: string; readonly budget: BudgetSummary; }

export const getBudget = (eventId: string): Promise<BudgetSummary> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/budget?${orgQuery(org)}` }));
export const setBudget = (eventId: string, input: SetBudgetInput): Promise<BudgetMutationResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/budget`, init: { method: "PUT", body: jsonBody(org, input) } }));
export const allocateBudget = (eventId: string, input: BudgetAllocationInput): Promise<BudgetMutationResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/budget/allocations`, init: { method: "POST", body: jsonBody(org, input) } }));
export const getExpenses = (eventId: string): Promise<{ expenses: Expense[]; count: number; total_inr: number }> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/budget/expenses?${orgQuery(org)}` }));
export const recordExpense = (eventId: string, input: RecordExpenseInput): Promise<RecordExpenseResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/budget/expenses`, init: { method: "POST", body: jsonBody(org, input) } }));
export const projectBudget = (eventId: string, category: string, amountInr: number): Promise<{ projection: BudgetProjection; budget: BudgetSummary }> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/budget/projection`, init: { method: "POST", body: jsonBody(org, { category, amount_inr: amountInr }) } }));

export const getAuditLog = (eventId: string, limit = 100): Promise<{ audit_events: AuditEvent[]; count: number }> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/audit?${orgQuery(org, [["limit", limit]])}` }));
export const agentChat = (request: AgentChatRequest): Promise<AgentChatResponse> => apiFetch((org) => ({ path: "/agent/chat", init: { method: "POST", body: jsonBody(org, request) } }));
export const getAgentCapabilities = (): Promise<AgentCapabilities> => apiFetch((org) => ({ path: `/agent/capabilities?${orgQuery(org)}` }));
export const getAgentActivity = (eventId?: string): Promise<AgentActivityResponse> => apiFetch((org) => ({ path: `/agent/activity?${orgQuery(org, [["event_id", eventId]])}` }));

export interface CheckinSearchInput { registration_id?: string; email?: string; phone?: string; name?: string; }
export const searchCheckin = (eventId: string, input: CheckinSearchInput): Promise<SearchResult> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/checkin/search`, init: { method: "POST", body: jsonBody(org, input) } }));
export const verifyCheckin = (eventId: string, registrationId: string): Promise<VerifyCheckinResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/checkin/verify`, init: { method: "POST", body: jsonBody(org, { registration_id: registrationId }) } }));
export const recoverTicket = (eventId: string, registrationId: string): Promise<TicketResult> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/checkin/recover`, init: { method: "POST", body: jsonBody(org, { registration_id: registrationId }) } }));
export const reconcilePayment = (eventId: string, transactionId: string): Promise<ReconcileResult> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/checkin/reconcile`, init: { method: "POST", body: jsonBody(org, { transaction_id: transactionId }) } }));
export const completeCheckin = (eventId: string, registrationId: string): Promise<CompleteCheckinResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/checkin/complete`, init: { method: "POST", body: jsonBody(org, { registration_id: registrationId }) } }));
export const verifyQrPayload = (eventId: string, qrPayload: string): Promise<VerifyQrResponse> => apiFetch((org) => ({ path: `/events/${pathId(eventId)}/checkin/verify-qr`, init: { method: "POST", body: jsonBody(org, { qr_payload: qrPayload }) } }));

export function formatInr(amount: number | null | undefined): string { return amount == null ? "—" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(amount); }
export function formatInrWithSymbol(amount: number | null | undefined): string { return amount == null ? "—" : `₹${formatInr(amount)}`; }
export function humanize(value: string): string { const words = value.replace(/_/g, " ").toLowerCase(); return words.charAt(0).toUpperCase() + words.slice(1); }

const MOCK_EVENT_ID = "EVT-devcon-2026";
const MOCK_EVENT: Event = { event_id: MOCK_EVENT_ID, name: "DevCon Bengaluru 2026", description: "Developer community conference", status: "ACTIVE", venue: "NIMHANS Convention Centre", city: "Bengaluru", start_date: "2026-10-15T09:00:00Z", end_date: "2026-10-15T18:00:00Z", expected_attendees: 500, registration_open: true, tags: ["developer", "community"] };
const MOCK_AUDIT: AuditEvent[] = [];
async function mockFetch<T>(path: string, init?: RequestInit): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (path === "/demo/session") return { id_token: "mock.demo.token", expires_in: 3600, email: "demo@communityops.local", organization_id: FALLBACK_ORGANIZATION_ID, role: "TEAM_MEMBER", is_demo: true, message: "Demo session ready." } as T;
  if ((init?.method ?? "GET") !== "GET") throw new ApiError("This mock operation is not configured.", 501, "NOT_IMPLEMENTED");
  if (path.includes("/command-center")) return { organization_id: FALLBACK_ORGANIZATION_ID, role: "LEADER", summary: { active_events: 1, total_events: 1, pending_approvals: 0, critical_incidents: 0, open_incidents: 0, overdue_tasks: 0, blocked_tasks: 0, unresponsive_speakers: 0, budget_remaining_inr: 0, budget_remaining_formatted: "0", attention_required: 0 }, events: [], attention_items: [], recent_actions: MOCK_AUDIT } as T;
  if (path.match(/\/events\/[^/?]+\?/)) return MOCK_EVENT as T;
  if (path.startsWith("/events?") || path.includes("/events?")) return { events: [MOCK_EVENT], count: 1 } as T;
  if (path.includes("/speakers")) return { speakers: [], count: 0, confirmed: 0, pending: 0, unresponsive_over_72h: 0, needing_accommodation: 0, estimated_travel_cost_inr: 0, estimated_accommodation_cost_inr: 0 } as T;
  if (path.includes("/teams") && path.includes("/tasks")) return { tasks: [], count: 0, overdue_count: 0, blocked_count: 0, completed_count: 0, in_progress_count: 0 } as T;
  if (path.includes("/teams")) return { teams: [], count: 0 } as T;
  if (path.includes("/tasks")) return { tasks: [], count: 0, overdue_count: 0 } as T;
  if (path.includes("/approvals")) return { approvals: [], count: 0, pending_count: 0, pending_financial_exposure_inr: 0 } as T;
  if (path.includes("/incidents")) return { incidents: [], count: 0, open_count: 0, critical_open_count: 0 } as T;
  if (path.includes("/attendees")) return { event_id: MOCK_EVENT_ID, event_name: MOCK_EVENT.name, summary: { total_registered: 0, confirmed: 0, cancelled: 0, waitlisted: 0, checked_in: 0, not_checked_in: 0, accommodation_required: 0, dietary_provided: 0, dietary_missing: 0, arrival_confirmed: 0, arrival_conflicts: 0, missing_information: 0, data_completeness_percent: 0, expected_attendees: 0, registration_target: 0 }, funnel: [], exceptions: { missing_dietary: [], missing_dietary_total: 0, accommodation_pending: [], accommodation_pending_total: 0, arrival_unconfirmed: [], arrival_unconfirmed_total: 0 } } as T;
  if (path.includes("/audit")) return { audit_events: [], count: 0 } as T;
  if (path.includes("/budget/expenses")) return { expenses: [], count: 0, total_inr: 0 } as T;
  if (path.includes("/budget")) return { event_id: MOCK_EVENT_ID, currency: "INR", total_budget: 0, allocated: 0, spent: 0, committed: 0, remaining: 0, unallocated: 0, utilization_percent: 0, categories: [], exists: false, total_budget_formatted: "0", remaining_formatted: "0", categories_available: [] } as T;
  if (path.includes("/agent/capabilities")) return { role: "LEADER", model_id: "", model_region: "", tool_count: 0, tools: [], automatic: [], requires_approval: [], withheld_from_role: [], notes: [] } as T;
  if (path.includes("/agent/activity")) return { activity: [], count: 0, refused_count: 0, awaiting_approval_count: 0 } as T;
  if (path.includes("/checkin/search")) return { found: false, count: 0, registrations: [], message: "No matching registration found." } as T;
  if (init?.method && init.method !== "GET") throw new ApiError("This mock operation is not configured.", 501, "NOT_IMPLEMENTED");
  return {} as T;
}
