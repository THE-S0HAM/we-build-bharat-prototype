/** Domain types matching the Python backend models. */

export interface Event {
  event_id: string;
  name: string;
  description: string;
  status: "DRAFT" | "PUBLISHED" | "ACTIVE" | "COMPLETED" | "CANCELLED";
  venue: string;
  city: string;
  start_date: string;
  end_date: string;
  expected_attendees: number;
  registration_open: boolean;
  tags: string[];
}

export interface Registration {
  registration_id: string;
  event_id: string;
  attendee_name: string;
  attendee_email: string;
  attendee_phone: string;
  status: "CONFIRMED" | "PENDING" | "CANCELLED" | "WAITLISTED";
  payment_status: "CAPTURED" | "PENDING" | "FAILED" | "REFUNDED" | "NOT_REQUIRED";
  ticket_type: string;
  is_checked_in: boolean;
}

export interface Speaker {
  speaker_id: string;
  event_id: string;
  name: string;
  email: string;
  status: "IDENTIFIED" | "INVITED" | "AWAITING_RESPONSE" | "FOLLOWUP_SENT" | "CONFIRMED" | "DECLINED" | "CANCELLED" | "BACKUP";
  topic: string;
  session_type: string;
  followup_count: number;
  travel_required: boolean;
  accommodation_required: boolean;
  is_backup: boolean;
}

export interface Task {
  task_id: string;
  event_id: string;
  team_id: string;
  title: string;
  description: string;
  status: "PENDING" | "IN_PROGRESS" | "BLOCKED" | "COMPLETED" | "CANCELLED" | "OVERDUE";
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  assigned_to: string;
  due_date: string;
  depends_on: string[];
  blocks: string[];
  escalation_level: number;
}

export interface Team {
  team_id: string;
  event_id: string;
  name: string;
  is_active: boolean;
}

export interface Incident {
  incident_id: string;
  event_id: string;
  title: string;
  description: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: string;
  affected_resource_type: string;
  affected_resource_id: string;
  recommendation: string;
  backup_options: string[];
  detected_at: string;
  resolved_at?: string;
}

export interface Approval {
  approval_id: string;
  event_id: string;
  title: string;
  description: string;
  status: "PENDING" | "APPROVED" | "DECLINED" | "EXPIRED" | "EDITED";
  risk_level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  requested_action: string;
  reason: string;
  evidence: Record<string, unknown>;
  affected_resource_type: string;
  affected_resource_id: string;
  agent_name: string;
  requested_at: string;
  decided_at?: string;
}

export interface AuditEvent {
  audit_id: string;
  organization_id: string;
  event_id: string;
  timestamp: string;
  action: string;
  actor_type: string;
  actor_id: string;
  resource_type: string;
  resource_id: string;
  outcome: string;
  tool_used?: string;
  policy_evaluated?: string;
}

export interface CommandCenterData {
  organization_id: string;
  summary: {
    active_events: number;
    total_events: number;
    pending_approvals: number;
    critical_incidents: number;
    overdue_tasks: number;
  };
  events: EventSummary[];
  recent_actions: AuditEvent[];
}

export interface EventSummary {
  event_id: string;
  name: string;
  status: string;
  pending_approvals: number;
  critical_incidents: number;
  overdue_tasks: number;
  blocked_tasks: number;
  total_tasks: number;
}

export interface VerificationCheck {
  name: string;
  status: "PASS" | "FAIL" | "WARN";
  message: string;
}

export interface SearchResult {
  found: boolean;
  count: number;
  registrations: Registration[];
  requires_disambiguation?: boolean;
  message?: string;
}

export interface TicketResult {
  ticket_id: string;
  registration_id: string;
  download_url: string;
  already_existed: boolean;
  message: string;
}

export type StatusLevel = "healthy" | "attention" | "warning" | "critical" | "completed" | "awaiting_approval";
