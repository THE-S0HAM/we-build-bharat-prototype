/**
 * API client for OrbitOps backend.
 *
 * In production, this talks to API Gateway. For local dev,
 * Vite proxies /api to the local backend.
 *
 * For the demo/hackathon, we include mock data fallback so the
 * frontend works without a deployed backend.
 */

import type {
  Approval,
  AuditEvent,
  CommandCenterData,
  Event,
  Incident,
  SearchResult,
  Speaker,
  Task,
  TicketResult,
  VerificationCheck,
} from "./types";

const API_BASE = import.meta.env.VITE_API_URL || "";
const ORG_ID = import.meta.env.VITE_ORG_ID || "ORG-wemakedev";
const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true" || !API_BASE;

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  if (USE_MOCK) {
    return mockFetch<T>(path, options);
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: "Request failed" }));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  return res.json();
}

// =============================================================
// Public API
// =============================================================

export async function getCommandCenter(): Promise<CommandCenterData> {
  return apiFetch(`/command-center?organization_id=${ORG_ID}`);
}

export async function getEvents(): Promise<{ events: Event[]; count: number }> {
  return apiFetch(`/events?organization_id=${ORG_ID}`);
}

export async function getEvent(eventId: string): Promise<Event> {
  return apiFetch(`/events/${eventId}?organization_id=${ORG_ID}`);
}

export async function getSpeakers(eventId: string): Promise<{ speakers: Speaker[]; count: number }> {
  return apiFetch(`/events/${eventId}/speakers?organization_id=${ORG_ID}`);
}

export async function getTasks(eventId: string, teamId: string): Promise<{ tasks: Task[]; count: number }> {
  return apiFetch(`/events/${eventId}/teams/${teamId}/tasks?organization_id=${ORG_ID}`);
}

export async function getApprovals(eventId: string): Promise<{ approvals: Approval[]; count: number }> {
  return apiFetch(`/events/${eventId}/approvals?organization_id=${ORG_ID}`);
}

export async function decideApproval(eventId: string, approvalId: string, decision: string, notes: string): Promise<unknown> {
  return apiFetch(`/events/${eventId}/approvals/${approvalId}`, {
    method: "PUT",
    body: JSON.stringify({ organization_id: ORG_ID, decision, notes }),
  });
}

export async function getIncidents(eventId: string): Promise<{ incidents: Incident[]; count: number }> {
  return apiFetch(`/events/${eventId}/incidents?organization_id=${ORG_ID}`);
}

export async function getAuditLog(eventId: string): Promise<{ audit_events: AuditEvent[]; count: number }> {
  return apiFetch(`/events/${eventId}/audit?organization_id=${ORG_ID}`);
}

export async function searchCheckin(eventId: string, searchParams: Record<string, string>): Promise<SearchResult> {
  return apiFetch(`/events/${eventId}/checkin/search`, {
    method: "POST",
    body: JSON.stringify({ organization_id: ORG_ID, ...searchParams }),
  });
}

export async function verifyCheckin(eventId: string, registrationId: string): Promise<{ verification: { all_passed: boolean; checks: VerificationCheck[] }; registration: Record<string, string> }> {
  return apiFetch(`/events/${eventId}/checkin/verify`, {
    method: "POST",
    body: JSON.stringify({ organization_id: ORG_ID, registration_id: registrationId }),
  });
}

export async function recoverTicket(eventId: string, registrationId: string): Promise<TicketResult> {
  return apiFetch(`/events/${eventId}/checkin/recover`, {
    method: "POST",
    body: JSON.stringify({ organization_id: ORG_ID, registration_id: registrationId }),
  });
}

export async function completeCheckin(eventId: string, registrationId: string): Promise<unknown> {
  return apiFetch(`/events/${eventId}/checkin/complete`, {
    method: "POST",
    body: JSON.stringify({ organization_id: ORG_ID, registration_id: registrationId }),
  });
}

export async function reconcilePayment(eventId: string, transactionId: string): Promise<unknown> {
  return apiFetch(`/events/${eventId}/checkin/reconcile`, {
    method: "POST",
    body: JSON.stringify({ organization_id: ORG_ID, transaction_id: transactionId }),
  });
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
  { audit_id: "AUD-001", organization_id: ORG_ID, event_id: MOCK_EVENT_ID, timestamp: new Date(Date.now() - 60000).toISOString(), action: "SPEAKER_FOLLOWUP_SENT", actor_type: "agent", actor_id: "SpeakerOps", resource_type: "Speaker", resource_id: "SPK-002", outcome: "success", tool_used: "send_speaker_invite" },
  { audit_id: "AUD-002", organization_id: ORG_ID, event_id: MOCK_EVENT_ID, timestamp: new Date(Date.now() - 120000).toISOString(), action: "INCIDENT_DETECTED", actor_type: "agent", actor_id: "IncidentOps", resource_type: "Incident", resource_id: "INC-001", outcome: "success" },
  { audit_id: "AUD-003", organization_id: ORG_ID, event_id: MOCK_EVENT_ID, timestamp: new Date(Date.now() - 180000).toISOString(), action: "APPROVAL_REQUESTED", actor_type: "agent", actor_id: "IncidentOps", resource_type: "Approval", resource_id: "APR-001", outcome: "success" },
  { audit_id: "AUD-004", organization_id: ORG_ID, event_id: MOCK_EVENT_ID, timestamp: new Date(Date.now() - 300000).toISOString(), action: "TASK_CREATED", actor_type: "user", actor_id: "user-001", resource_type: "Task", resource_id: "TSK-001", outcome: "success" },
  { audit_id: "AUD-005", organization_id: ORG_ID, event_id: MOCK_EVENT_ID, timestamp: new Date(Date.now() - 600000).toISOString(), action: "CHECKIN_COMPLETED", actor_type: "user", actor_id: "volunteer-001", resource_type: "CheckIn", resource_id: "REG-2026-004829", outcome: "success" },
];

const MOCK_REGISTRATIONS = [
  { registration_id: "REG-2026-004821", event_id: MOCK_EVENT_ID, attendee_name: "Priya Sharma", attendee_email: "priya.sharma@example.com", attendee_phone: "+919876543210", status: "CONFIRMED" as const, payment_status: "CAPTURED" as const, ticket_type: "GENERAL", is_checked_in: false },
  { registration_id: "REG-2026-004822", event_id: MOCK_EVENT_ID, attendee_name: "Arjun Patel", attendee_email: "arjun.patel@example.com", attendee_phone: "+919876543211", status: "CONFIRMED" as const, payment_status: "CAPTURED" as const, ticket_type: "GENERAL", is_checked_in: false },
];

/* eslint-disable @typescript-eslint/no-unused-vars */
async function mockFetch<T>(path: string, _options?: RequestInit): Promise<T> {
  await new Promise((r) => setTimeout(r, 200)); // Simulate network latency

  if (path.includes("/command-center")) {
    return {
      organization_id: ORG_ID,
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
