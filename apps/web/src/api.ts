/**
 * API client for the CommunityOps backend.
 *
 * Talks to API Gateway, attaching the Cognito ID token that the deployed
 * user-pool authorizer requires.
 *
 * Every request is scoped to an organization, and that organization is derived
 * from the token's `cognito:groups` claim inside this module (requirement 16.3).
 * No caller passes one in: `src/orgContext.ts` holds the resolution rules and
 * why a UI-supplied value is never accepted.
 *
 * Mock data is opt-in via VITE_USE_MOCK=true and is intended for local UI work
 * without a backend. It is deliberately NOT a fallback: when a real API URL is
 * configured and the backend fails, the error surfaces to the user rather than
 * being masked by fabricated operational data.
 */

import { getIdToken } from "./auth";
import { resolveOrganization, type ResolvedOrganization } from "./orgContext";
import type {
  Approval,
  AuditEvent,
  CommandCenterData,
  Event,
  Incident,
  SearchResult,
  Speaker,
  Task,
  Team,
  TicketResult,
  VerificationCheck,
} from "./types";

const API_BASE = import.meta.env.VITE_API_URL || "";

/**
 * Organization of last resort.
 *
 * The organization a request is scoped to comes from the ID token's
 * `cognito:groups` claim (requirement 16.3) — see `src/orgContext.ts`. This
 * build-time value is used **only when no session resolves an organization**:
 * before sign-in, or with a token that carries no group claim. It is a
 * fallback, not the primary path, and not a second source of truth. Whenever a
 * session names an organization, the token wins and this value is ignored.
 *
 * It also names the organization the mock fixtures below belong to, since mock
 * mode deliberately resolves no session.
 */
const FALLBACK_ORGANIZATION_ID = import.meta.env.VITE_ORG_ID || "ORG-wemakedev";

/**
 * Mock mode is explicit opt-in. A missing API URL does not silently switch to
 * mock data, because that would present fabricated operational state as real.
 */
const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";

export const isMockMode = USE_MOCK;

/**
 * The organization this client is scoping requests to, plus the full set the
 * session may act for, for surfaces that display or offer a choice between
 * them: the sidebar account block (requirement 3.6) and any organization
 * selector (requirement 1.12).
 *
 * Read-only. Nothing a caller passes back can change what the client sends —
 * the organization is re-derived from the token inside every request, so a UI
 * value cannot be substituted for it (requirement 16.4).
 */
export async function getOrganizationContext(): Promise<ResolvedOrganization> {
  if (USE_MOCK) {
    return {
      organizationId: FALLBACK_ORGANIZATION_ID,
      selectable: [FALLBACK_ORGANIZATION_ID],
      source: "fallback",
    };
  }

  return resolveOrganization({
    idToken: await getIdToken(),
    fallbackOrganizationId: FALLBACK_ORGANIZATION_ID,
  });
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly category?: string,
  ) {
    super(message);
  }
}

/** A request, built once the organization to scope it to is known. */
type ScopedRequest = {
  readonly path: string;
  readonly init?: RequestInit;
};

/**
 * Issue a request scoped to the session's organization.
 *
 * The caller receives the resolved `organization_id` and places it where the
 * endpoint expects it — the query string for reads, the body for writes — but
 * cannot supply one. Resolution happens here, from the same token that becomes
 * the `Authorization` header, so the organization a request claims and the
 * token it presents are read from one value and cannot drift apart.
 *
 * `organization_id` is still caller-supplied data as far as the backend is
 * concerned: `tenancy.authorize_organization` re-derives the caller's groups
 * from its own copy of the claims and refuses anything outside them. This
 * resolution makes the client send the right value; it does not make the value
 * trusted (requirement 16.2).
 */
async function apiFetch<T>(
  buildRequest: (organizationId: string) => ScopedRequest,
): Promise<T> {
  if (USE_MOCK) {
    // Mock mode is local UI work with no backend and no session, so there is no
    // token to derive an organization from: the fixtures use the fallback.
    const mockRequest = buildRequest(FALLBACK_ORGANIZATION_ID);
    return mockFetch<T>(mockRequest.path, mockRequest.init);
  }

  if (!API_BASE) {
    throw new ApiError(
      "No API URL is configured. Set VITE_API_URL to the deployed API, or VITE_USE_MOCK=true for local demo data.",
      0,
      "CONFIGURATION_ERROR",
    );
  }

  const token = await getIdToken();
  if (!token) {
    throw new ApiError("Your session has expired. Please sign in again.", 401, "UNAUTHORIZED");
  }

  const { organizationId } = resolveOrganization({
    idToken: token,
    fallbackOrganizationId: FALLBACK_ORGANIZATION_ID,
  });
  const { path, init } = buildRequest(organizationId);

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(
      err.message || `Request failed (HTTP ${res.status})`,
      res.status,
      err.error,
    );
  }
  return res.json();
}

// =============================================================
// Public API
// =============================================================

/**
 * `organization_id` as a query-string pair.
 *
 * Encoded rather than interpolated raw: the value is a Cognito group name, so
 * one containing a `&` or `=` would otherwise append parameters of its own to
 * the request the client builds.
 */
function orgQuery(organizationId: string): string {
  return `organization_id=${encodeURIComponent(organizationId)}`;
}

export async function getCommandCenter(): Promise<CommandCenterData> {
  return apiFetch((org) => ({ path: `/command-center?${orgQuery(org)}` }));
}

export async function getEvents(): Promise<{ events: Event[]; count: number }> {
  return apiFetch((org) => ({ path: `/events?${orgQuery(org)}` }));
}

export async function getEvent(eventId: string): Promise<Event> {
  return apiFetch((org) => ({ path: `/events/${eventId}?${orgQuery(org)}` }));
}

export async function getSpeakers(eventId: string): Promise<{ speakers: Speaker[]; count: number }> {
  return apiFetch((org) => ({ path: `/events/${eventId}/speakers?${orgQuery(org)}` }));
}

/**
 * The event's team directory.
 *
 * This route does **not** exist in `template.yaml` yet (design.md A5): the API
 * exposes tasks per team and nothing else under `teams`. The client is written
 * against the specified contract — `{ teams[], count }`, filtered server-side to
 * `entity_type == "TEAM"` — so TeamOps works the day the route lands, and
 * `src/teamDirectory.ts` turns today's absent response into the honest
 * "Team directory unavailable" state rather than a fabricated team list
 * (requirements 7.2, 7.3).
 *
 * Deliberately no mock fixture: a mock team directory would be this console
 * inventing the organization's team structure, which is the exact defect A5
 * records. In mock mode the response carries no `teams`, which the page reads as
 * unavailable.
 */
export async function getTeams(eventId: string): Promise<{ teams: Team[]; count: number }> {
  return apiFetch((org) => ({ path: `/events/${eventId}/teams?${orgQuery(org)}` }));
}

export async function getTasks(eventId: string, teamId: string): Promise<{ tasks: Task[]; count: number }> {
  return apiFetch((org) => ({
    path: `/events/${eventId}/teams/${teamId}/tasks?${orgQuery(org)}`,
  }));
}

export async function getApprovals(eventId: string): Promise<{ approvals: Approval[]; count: number }> {
  return apiFetch((org) => ({ path: `/events/${eventId}/approvals?${orgQuery(org)}` }));
}

/**
 * Record a decision on one prepared action.
 *
 * `editedAction` is a single free-text string because that is the whole of the
 * contract: `approvals_handler._decide_approval` accepts `decision="EDITED"`
 * plus one `edited_action`, and `Approval.edited_action` is a plain string
 * (design.md A4). There is no field-level schema for an action, so no structured
 * shape is invented here. The key is omitted entirely for the other two
 * decisions rather than sent empty.
 */
export async function decideApproval(
  eventId: string,
  approvalId: string,
  decision: string,
  notes: string,
  editedAction?: string,
): Promise<unknown> {
  return apiFetch((org) => ({
    path: `/events/${eventId}/approvals/${approvalId}`,
    init: {
      method: "PUT",
      body: JSON.stringify({
        organization_id: org,
        decision,
        notes,
        ...(editedAction === undefined ? {} : { edited_action: editedAction }),
      }),
    },
  }));
}

export async function getIncidents(eventId: string): Promise<{ incidents: Incident[]; count: number }> {
  return apiFetch((org) => ({ path: `/events/${eventId}/incidents?${orgQuery(org)}` }));
}

export async function getAuditLog(eventId: string): Promise<{ audit_events: AuditEvent[]; count: number }> {
  return apiFetch((org) => ({ path: `/events/${eventId}/audit?${orgQuery(org)}` }));
}

export async function searchCheckin(eventId: string, searchParams: Record<string, string>): Promise<SearchResult> {
  return apiFetch((org) => ({
    path: `/events/${eventId}/checkin/search`,
    init: {
      method: "POST",
      // The resolved organization is written *last*, so a caller's search field
      // named `organization_id` cannot overwrite it. Spread order is the whole
      // guarantee here: this is the only endpoint that carries caller-shaped
      // keys into a request body, and the organization must come from the token
      // this request is about to present (requirement 16.4, design.md Property 4).
      body: JSON.stringify({ ...searchParams, organization_id: org }),
    },
  }));
}

export async function verifyCheckin(eventId: string, registrationId: string): Promise<{ verification: { all_passed: boolean; checks: VerificationCheck[] }; registration: Record<string, string> }> {
  return apiFetch((org) => ({
    path: `/events/${eventId}/checkin/verify`,
    init: {
      method: "POST",
      body: JSON.stringify({ organization_id: org, registration_id: registrationId }),
    },
  }));
}

export async function recoverTicket(eventId: string, registrationId: string): Promise<TicketResult> {
  return apiFetch((org) => ({
    path: `/events/${eventId}/checkin/recover`,
    init: {
      method: "POST",
      body: JSON.stringify({ organization_id: org, registration_id: registrationId }),
    },
  }));
}

export async function completeCheckin(eventId: string, registrationId: string): Promise<unknown> {
  return apiFetch((org) => ({
    path: `/events/${eventId}/checkin/complete`,
    init: {
      method: "POST",
      body: JSON.stringify({ organization_id: org, registration_id: registrationId }),
    },
  }));
}

export async function reconcilePayment(eventId: string, transactionId: string): Promise<unknown> {
  return apiFetch((org) => ({
    path: `/events/${eventId}/checkin/reconcile`,
    init: {
      method: "POST",
      body: JSON.stringify({ organization_id: org, transaction_id: transactionId }),
    },
  }));
}

// =============================================================
// Mock data for demo/hackathon (when no backend deployed)
// =============================================================

const MOCK_EVENT_ID = "EVT-devcon-2026";

const MOCK_EVENTS: Event[] = [{
  event_id: MOCK_EVENT_ID, name: "DevCon Bengaluru 2026",
  description: "The largest developer conference in South India",
  status: "ACTIVE", venue: "NIMHANS Convention Centre", city: "Bengaluru",
  start_date: "2026-10-15T09:00:00Z", end_date: "2026-10-15T18:00:00Z",
  expected_attendees: 500, registration_open: true, tags: ["developer", "community"],
}];

const MOCK_SPEAKERS: Speaker[] = [
  { speaker_id: "SPK-001", event_id: MOCK_EVENT_ID, name: "Dr. Ananya Krishnan", email: "ananya@example.com", status: "CONFIRMED", topic: "Building Responsible AI Systems", session_type: "KEYNOTE", followup_count: 0, travel_required: true, accommodation_required: true, is_backup: false },
  { speaker_id: "SPK-002", event_id: MOCK_EVENT_ID, name: "Raj Malhotra", email: "raj@example.com", status: "AWAITING_RESPONSE", topic: "Cloud-Native Architecture Patterns", session_type: "TALK", followup_count: 2, travel_required: false, accommodation_required: false, is_backup: false },
  { speaker_id: "SPK-003", event_id: MOCK_EVENT_ID, name: "Fatima Shaikh", email: "fatima@example.com", status: "INVITED", topic: "Scaling Community-Led Developer Programs", session_type: "TALK", followup_count: 0, travel_required: false, accommodation_required: false, is_backup: false },
  { speaker_id: "SPK-004", event_id: MOCK_EVENT_ID, name: "Suresh Rajan", email: "suresh@example.com", status: "CONFIRMED", topic: "Zero Trust Security for Startups", session_type: "WORKSHOP", followup_count: 0, travel_required: false, accommodation_required: false, is_backup: false },
  { speaker_id: "SPK-005", event_id: MOCK_EVENT_ID, name: "Meera Joshi", email: "meera@example.com", status: "CONFIRMED", topic: "AI in Healthcare", session_type: "TALK", followup_count: 0, travel_required: false, accommodation_required: false, is_backup: true },
  { speaker_id: "SPK-006", event_id: MOCK_EVENT_ID, name: "James Chen", email: "james@example.com", status: "CANCELLED", topic: "Microservices Anti-Patterns", session_type: "TALK", followup_count: 0, travel_required: true, accommodation_required: true, is_backup: false },
];

const MOCK_TASKS: Task[] = [
  { task_id: "TSK-001", event_id: MOCK_EVENT_ID, team_id: "TEAM-marketing", title: "Send final event reminder email", description: "", status: "PENDING", priority: "HIGH", assigned_to: "", due_date: "2026-10-14T18:00:00Z", depends_on: [], blocks: [], escalation_level: 0 },
  { task_id: "TSK-004", event_id: MOCK_EVENT_ID, team_id: "TEAM-registration", title: "Prepare check-in kits", description: "", status: "BLOCKED", priority: "CRITICAL", assigned_to: "", due_date: "2026-10-14T20:00:00Z", depends_on: ["TSK-008"], blocks: [], escalation_level: 1 },
  { task_id: "TSK-005", event_id: MOCK_EVENT_ID, team_id: "TEAM-speakers", title: "Confirm AV requirements with keynote", description: "", status: "OVERDUE", priority: "CRITICAL", assigned_to: "", due_date: "2026-10-13T12:00:00Z", depends_on: [], blocks: [], escalation_level: 2 },
  { task_id: "TSK-009", event_id: MOCK_EVENT_ID, team_id: "TEAM-tech", title: "Deploy event app update", description: "", status: "OVERDUE", priority: "HIGH", assigned_to: "", due_date: "2026-10-13T20:00:00Z", depends_on: [], blocks: [], escalation_level: 2 },
];

const MOCK_APPROVALS: Approval[] = [
  { approval_id: "APR-001", event_id: MOCK_EVENT_ID, title: "Replace cancelled speaker with backup", description: "IncidentOps recommends replacing James Chen (cancelled) with Meera Joshi for the 14:00 session.", status: "PENDING", risk_level: "HIGH", requested_action: "RESOLVE_INCIDENT", reason: "Speaker cancellation — backup available with relevant topic", evidence: { incident_id: "INC-001", backup_speaker: "SPK-005" }, affected_resource_type: "Incident", affected_resource_id: "INC-001", agent_name: "IncidentOps", requested_at: new Date().toISOString() },
  { approval_id: "APR-002", event_id: MOCK_EVENT_ID, title: "Send 3rd follow-up to Raj Malhotra", description: "SpeakerOps wants to send a 3rd follow-up to Raj Malhotra who hasn't responded.", status: "PENDING", risk_level: "MEDIUM", requested_action: "SEND_SPEAKER_FOLLOWUP", reason: "Follow-up count exceeds auto-send threshold", evidence: { speaker_id: "SPK-002", followup_count: 2 }, affected_resource_type: "Speaker", affected_resource_id: "SPK-002", agent_name: "SpeakerOps", requested_at: new Date().toISOString() },
];

const MOCK_INCIDENTS: Incident[] = [
  { incident_id: "INC-001", event_id: MOCK_EVENT_ID, title: "Speaker James Chen cancelled — 2 hours before session", description: "James Chen has cancelled his talk due to a family emergency. Session was scheduled for 14:00.", severity: "CRITICAL", status: "RECOMMENDATION_READY", affected_resource_type: "Speaker", affected_resource_id: "SPK-006", recommendation: "Replace with backup speaker Meera Joshi (SPK-005)", backup_options: ["SPK-005"], detected_at: new Date().toISOString() },
];

const MOCK_AUDIT: AuditEvent[] = [
  { audit_id: "AUD-001", organization_id: FALLBACK_ORGANIZATION_ID, event_id: MOCK_EVENT_ID, timestamp: new Date(Date.now() - 60000).toISOString(), action: "SPEAKER_FOLLOWUP_SENT", actor_type: "agent", actor_id: "SpeakerOps", resource_type: "Speaker", resource_id: "SPK-002", outcome: "success", tool_used: "send_speaker_invite" },
  { audit_id: "AUD-002", organization_id: FALLBACK_ORGANIZATION_ID, event_id: MOCK_EVENT_ID, timestamp: new Date(Date.now() - 120000).toISOString(), action: "INCIDENT_DETECTED", actor_type: "agent", actor_id: "IncidentOps", resource_type: "Incident", resource_id: "INC-001", outcome: "success" },
  { audit_id: "AUD-003", organization_id: FALLBACK_ORGANIZATION_ID, event_id: MOCK_EVENT_ID, timestamp: new Date(Date.now() - 180000).toISOString(), action: "APPROVAL_REQUESTED", actor_type: "agent", actor_id: "IncidentOps", resource_type: "Approval", resource_id: "APR-001", outcome: "success" },
  { audit_id: "AUD-004", organization_id: FALLBACK_ORGANIZATION_ID, event_id: MOCK_EVENT_ID, timestamp: new Date(Date.now() - 300000).toISOString(), action: "TASK_CREATED", actor_type: "user", actor_id: "user-001", resource_type: "Task", resource_id: "TSK-001", outcome: "success" },
  { audit_id: "AUD-005", organization_id: FALLBACK_ORGANIZATION_ID, event_id: MOCK_EVENT_ID, timestamp: new Date(Date.now() - 600000).toISOString(), action: "CHECKIN_COMPLETED", actor_type: "user", actor_id: "volunteer-001", resource_type: "CheckIn", resource_id: "REG-2026-004829", outcome: "success" },
];

const MOCK_REGISTRATIONS = [
  { registration_id: "REG-2026-004821", event_id: MOCK_EVENT_ID, attendee_name: "Priya Sharma", attendee_email: "priya.sharma@example.com", attendee_phone: "+919876543210", status: "CONFIRMED" as const, payment_status: "CAPTURED" as const, ticket_type: "GENERAL", is_checked_in: false },
  { registration_id: "REG-2026-004822", event_id: MOCK_EVENT_ID, attendee_name: "Arjun Patel", attendee_email: "arjun.patel@example.com", attendee_phone: "+919876543211", status: "CONFIRMED" as const, payment_status: "CAPTURED" as const, ticket_type: "GENERAL", is_checked_in: false },
];

async function mockFetch<T>(path: string, _options?: RequestInit): Promise<T> {
  await new Promise((r) => setTimeout(r, 200)); // Simulate network latency

  if (path.includes("/command-center")) {
    return {
      organization_id: FALLBACK_ORGANIZATION_ID,
      summary: { active_events: 1, total_events: 1, pending_approvals: 2, critical_incidents: 1, overdue_tasks: 2 },
      events: [{ event_id: MOCK_EVENT_ID, name: "DevCon Bengaluru 2026", status: "ACTIVE", pending_approvals: 2, critical_incidents: 1, overdue_tasks: 2, blocked_tasks: 1, total_tasks: 9 }],
      recent_actions: MOCK_AUDIT.slice(0, 5),
    } as T;
  }
  if (path.includes("/speakers")) return { speakers: MOCK_SPEAKERS, count: MOCK_SPEAKERS.length } as T;
  if (path.includes("/approvals") && !path.includes("PUT")) return { approvals: MOCK_APPROVALS, count: MOCK_APPROVALS.length } as T;
  if (path.includes("/incidents")) return { incidents: MOCK_INCIDENTS, count: MOCK_INCIDENTS.length } as T;
  if (path.includes("/audit")) return { audit_events: MOCK_AUDIT, count: MOCK_AUDIT.length } as T;
  if (path.includes("/checkin/search")) {
    return { found: true, count: 1, registrations: [MOCK_REGISTRATIONS[0]], requires_disambiguation: false } as T;
  }
  if (path.includes("/checkin/verify")) {
    return { verification: { all_passed: true, checks: [
      { name: "registration_exists", status: "PASS", message: "Registration record found" },
      { name: "event_match", status: "PASS", message: "Registration belongs to the correct event" },
      { name: "registration_status", status: "PASS", message: "Registration is confirmed" },
      { name: "payment_status", status: "PASS", message: "Payment status: CAPTURED" },
      { name: "not_cancelled", status: "PASS", message: "Registration is not cancelled" },
      { name: "not_refunded", status: "PASS", message: "No refund recorded" },
      { name: "checkin_eligibility", status: "PASS", message: "Attendee is eligible for check-in" },
    ] }, registration: { attendee_name: "Priya Sharma", status: "CONFIRMED", payment_status: "CAPTURED" } } as T;
  }
  if (path.includes("/checkin/recover")) {
    return { ticket_id: "REG-2026-004821", registration_id: "REG-2026-004821", download_url: "#", already_existed: false, message: "Ticket generated successfully." } as T;
  }
  if (path.includes("/checkin/complete")) {
    return { registration_id: "REG-2026-004821", status: "CHECKED_IN", checked_in_at: new Date().toISOString(), was_already_checked_in: false } as T;
  }
  if (path.match(/\/events\/[^/]+$/)) return MOCK_EVENTS[0] as T;
  if (path.includes("/events")) return { events: MOCK_EVENTS, count: 1 } as T;
  if (path.includes("/tasks")) return { tasks: MOCK_TASKS, count: MOCK_TASKS.length } as T;

  return {} as T;
}
