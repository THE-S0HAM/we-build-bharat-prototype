/** Strict frontend contracts for the CommunityOps HTTP API. */

export type Role = "LEADER" | "TEAM_MEMBER";
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type HealthBand = "GREEN" | "YELLOW" | "ORANGE" | "RED";

export interface Event {
  event_id: string;
  name: string;
  description: string;
  status: "DRAFT" | "PUBLISHED" | "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED" | "ARCHIVED";
  venue: string;
  city: string;
  start_date: string;
  end_date: string;
  timezone?: string;
  expected_attendees: number;
  registration_target?: number;
  registration_open: boolean;
  tags: string[];
  health_band?: HealthBand;
  health_score?: number;
  health_reasons?: string[];
}

export interface HealthReason {
  signal: string;
  points: number;
  detail: string;
}

export interface EventHealth {
  event_id: string;
  event_name: string;
  health_band: HealthBand;
  health_score: number;
  health_reasons: string[];
  health_signals: HealthReason[];
  health_summary: string;
  computed_at: string;
  inputs: {
    overdue_tasks: number;
    blocked_tasks: number;
    open_incidents: number;
    silent_speakers: number;
    stale_approvals: number;
    budget_utilization_percent: number;
    hours_until_start: number | null;
    attendee_data_completeness_percent: number;
  };
}

export interface AttentionItem {
  kind: "INCIDENT" | "APPROVAL" | "TASK" | "SPEAKER" | "WORKLOAD" | "BUDGET";
  severity: Severity;
  title: string;
  detail: string;
  resource_type: string;
  resource_id: string;
  event_id?: string;
}

export interface CommandCenterSummary {
  active_events: number;
  total_events: number;
  pending_approvals: number;
  critical_incidents: number;
  open_incidents?: number;
  overdue_tasks: number;
  blocked_tasks?: number;
  unresponsive_speakers?: number;
  budget_remaining_inr?: number;
  budget_remaining_formatted?: string;
  attention_required?: number;
}

export interface EventSummary {
  event_id: string;
  name: string;
  status: string;
  start_date?: string;
  health_band?: HealthBand;
  health_score?: number;
  health_reasons?: string[];
  detailed?: boolean;
  pending_approvals: number;
  critical_incidents: number;
  open_incidents?: number;
  overdue_tasks: number;
  blocked_tasks: number;
  total_tasks: number;
  completed_tasks?: number;
  teams?: number;
  speakers?: number;
  confirmed_speakers?: number;
  registered?: number;
  checked_in?: number;
  budget_remaining_inr?: number;
  budget_utilization_percent?: number;
}

export interface CommandCenterData {
  organization_id: string;
  role?: Role;
  summary: CommandCenterSummary;
  events: EventSummary[];
  attention_items?: AttentionItem[];
  recent_actions: AuditEvent[];
}

export interface AttentionResponse {
  event_id: string;
  attention_items: AttentionItem[];
  count: number;
  critical_count: number;
  high_count: number;
}

export interface OperationsBrief {
  event_id: string;
  event_name: string;
  generated_at: string;
  health_band: HealthBand;
  health_score: number;
  health_reasons: string[];
  decisions_required: number;
  high_risk_items: number;
  tasks_progressing: number;
  overdue_tasks: number;
  blocked_tasks: number;
  open_incidents: number;
  incidents_needing_attention: number;
  budget: {
    total_inr: number;
    remaining_inr: number;
    remaining_formatted: string;
    committed_inr: number;
    spent_inr: number;
    utilization_percent: number;
    pending_exposure_inr: number;
  };
  speakers: {
    total: number;
    confirmed: number;
    pending: number;
    unresponsive: number;
    needing_accommodation: number;
  };
  attention_items: AttentionItem[];
  recommended_priority: string[];
  hours_until_start: number | null;
}

export interface Team {
  team_id: string;
  event_id: string;
  name: string;
  is_active: boolean;
  lead_user_id?: string;
  lead_name?: string;
  member_count?: number;
  total_tasks?: number;
  open_tasks?: number;
  completed_tasks?: number;
  overdue_tasks?: number;
  blocked_tasks?: number;
  in_progress_tasks?: number;
  progress_percent?: number;
  workload_per_member?: number;
  risk?: "HIGH" | "MEDIUM" | "LOW";
}

export interface TeamMember {
  user_id: string;
  team_id: string;
  display_name: string;
  email: string;
  team_role: "LEAD" | "MEMBER";
  skills: string[];
  is_active: boolean;
  active_task_count?: number;
  completed_task_count?: number;
}

export type TaskStatus = "BACKLOG" | "PENDING" | "ASSIGNED" | "IN_PROGRESS" | "BLOCKED" | "REVIEW" | "COMPLETED" | "CANCELLED" | "OVERDUE";

export interface Task {
  task_id: string;
  event_id: string;
  team_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Severity;
  risk?: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  assigned_to: string;
  assigned_to_name?: string;
  due_date: string;
  depends_on: string[];
  blocks: string[];
  escalation_level: number;
  blocked_reason?: string;
  notes?: string;
  estimated_effort_hours?: number;
  source_comment_id?: string;
  source_incident_id?: string;
  is_overdue?: boolean;
  hours_until_due?: number | null;
}

export interface TaskListResponse {
  tasks: Task[];
  count: number;
  overdue_count: number;
  blocked_count?: number;
  completed_count?: number;
  in_progress_count?: number;
}

export interface MemberWorkload {
  user_id: string;
  display_name: string;
  team_id?: string;
  team_name?: string;
  open_tasks: number;
  overdue_tasks: number;
  blocked_tasks?: number;
}

export interface WorkloadResponse {
  event_id: string;
  teams: Team[];
  members: MemberWorkload[];
  busiest_member: MemberWorkload | null;
  most_available_member: MemberWorkload | null;
}

export type SpeakerStatus = "IDENTIFIED" | "INVITED" | "AWAITING_RESPONSE" | "FOLLOWUP_SENT" | "CONFIRMED" | "DECLINED" | "CANCELLED" | "BACKUP";

export interface Speaker {
  speaker_id: string;
  event_id: string;
  name: string;
  email: string;
  phone?: string;
  status: SpeakerStatus;
  topic: string;
  bio?: string;
  session_type: string;
  session_duration_minutes?: number;
  session_time?: string;
  followup_count: number;
  max_followups?: number;
  travel_required: boolean;
  travel_origin?: string;
  travel_details?: string;
  accommodation_required: boolean;
  accommodation_nights?: number;
  accommodation_details?: string;
  estimated_travel_cost?: number;
  estimated_accommodation_cost?: number;
  special_requirements?: string;
  availability_notes?: string;
  availability_confirmed?: boolean;
  slides_submitted?: boolean;
  av_requirements?: string;
  is_backup: boolean;
  backup_for_speaker_id?: string;
  silent_hours?: number;
  needs_followup?: boolean;
}

export interface SpeakerListResponse {
  speakers: Speaker[];
  count: number;
  confirmed: number;
  pending: number;
  unresponsive_over_72h: number;
  needing_accommodation: number;
  estimated_travel_cost_inr: number;
  estimated_accommodation_cost_inr: number;
}

export interface FollowupDraft {
  speaker_id: string;
  speaker_name: string;
  silent_hours: number;
  followup_count: number;
  draft: string;
  sent: false;
  message: string;
  approval_id?: string;
  status?: string;
}

export interface AttendeeException {
  registration_id: string;
  attendee_name: string;
  ticket_type: string;
  nights?: string;
  arrival_date?: string;
}

export interface AttendeeOpsResponse {
  event_id: string;
  event_name: string;
  summary: {
    total_registered: number;
    confirmed: number;
    cancelled: number;
    waitlisted: number;
    checked_in: number;
    not_checked_in: number;
    accommodation_required: number;
    dietary_provided: number;
    dietary_missing: number;
    arrival_confirmed: number;
    arrival_conflicts: number;
    missing_information: number;
    data_completeness_percent: number;
    expected_attendees: number;
    registration_target: number;
  };
  funnel: Array<{ stage: string; count: number; detail: string }>;
  exceptions: {
    missing_dietary: AttendeeException[];
    missing_dietary_total: number;
    accommodation_pending: AttendeeException[];
    accommodation_pending_total: number;
    arrival_unconfirmed: AttendeeException[];
    arrival_unconfirmed_total: number;
  };
}

export type IncidentStatus = "OPEN" | "REPORTED" | "DETECTED" | "ACKNOWLEDGED" | "ANALYZING" | "RECOMMENDATION_READY" | "AWAITING_APPROVAL" | "APPROVED" | "EXECUTING" | "RESOLVED" | "REOPENED" | "CLOSED" | "REJECTED" | "ESCALATED";
export type GenericIncidentStatus = Exclude<
  IncidentStatus,
  "RESOLVED" | "REOPENED" | "CLOSED" | "REJECTED" | "ESCALATED"
>;

export type IncidentUpdateInput = Partial<
  Omit<
    Pick<
      Incident,
      | "title"
      | "description"
      | "severity"
      | "status"
      | "category"
      | "assigned_to"
      | "assigned_to_name"
      | "team_id"
    >,
    "status"
  >
> & { readonly status?: GenericIncidentStatus };

export interface Incident {
  incident_id: string;
  event_id: string;
  title: string;
  description: string;
  severity: Severity;
  status: IncidentStatus;
  category?: string;
  team_id?: string;
  affected_resource_type: string;
  affected_resource_id: string;
  detected_at: string;
  assigned_to?: string;
  assigned_to_name?: string;
  impact_analysis?: string;
  dependencies?: string[];
  backup_options: string[];
  recommendation: string;
  evidence?: string;
  resolved_at?: string | null;
  resolution_summary?: string;
  root_cause?: string;
  actions_taken?: string[];
  reopened_count?: number;
  comment_count?: number;
}

export interface IncidentComment {
  comment_id: string;
  incident_id: string;
  event_id: string;
  body: string;
  author_id: string;
  author_name: string;
  author_type: "user" | "agent" | "system";
  author_role?: string;
  team_id?: string;
  parent_comment_id?: string | null;
  created_task_id?: string | null;
  created_approval_id?: string | null;
  created_at: string;
}

export interface AddIncidentCommentResponse {
  comment_id: string;
  created_task_id: string | null;
  created_approval_id?: string | null;
  message: string;
}

export interface IncidentListResponse {
  incidents: Incident[];
  count: number;
  open_count: number;
  critical_open_count: number;
}

export interface IncidentDetailResponse {
  incident: Incident;
  comments: IncidentComment[];
  comment_count: number;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue; }
export type ApprovalEvidence = JsonObject;

export type ApprovalStatus = "PENDING" | "APPROVED" | "DECLINED" | "EXPIRED" | "EDITED";
export interface Approval {
  approval_id: string;
  event_id: string;
  title: string;
  description: string;
  status: ApprovalStatus;
  risk_level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  requested_action: string;
  reason: string;
  evidence: unknown;
  affected_resource_type: string;
  affected_resource_id: string;
  amount_inr?: number;
  currency?: "INR";
  budget_category?: string;
  budget_impact?: string;
  requested_by?: string;
  requested_by_name?: string;
  requested_by_role?: Role;
  agent_name: string;
  agent_recommendation?: string;
  requested_at: string;
  decided_at?: string;
  decided_by?: string;
  decision_notes?: string;
  edited_action?: string;
}

export interface ApprovalListResponse {
  approvals: Approval[];
  count: number;
  pending_count: number;
  pending_financial_exposure_inr: number;
}

export interface BudgetProjection {
  category: string;
  amount_inr: number;
  affordable: boolean;
  blockers: string[];
  current_remaining: number;
  projected_remaining: number;
  current_committed: number;
  projected_committed: number;
  current_utilization_percent: number;
  projected_utilization_percent: number;
  impact_summary: string;
}

export interface BudgetCategoryLine {
  category: string;
  allocated: number;
  spent: number;
  committed: number;
  remaining: number;
  utilization_percent: number;
  notes?: string;
}

export interface BudgetSummary {
  event_id: string;
  currency: "INR";
  total_budget: number;
  allocated: number;
  spent: number;
  committed: number;
  remaining: number;
  unallocated: number;
  utilization_percent: number;
  categories: BudgetCategoryLine[];
  exists: boolean;
  total_budget_formatted: string;
  remaining_formatted: string;
  categories_available: string[];
}

export interface ApprovalDetailResponse {
  approval: Approval;
  budget_projection: BudgetProjection | null;
}
export interface ApprovalDecisionResponse {
  approval_id: string;
  status: ApprovalStatus;
  message: string;
  budget?: BudgetSummary;
}

export interface Expense {
  expense_id: string;
  event_id: string;
  category: string;
  amount_inr: number;
  description: string;
  status: string;
  vendor?: string;
  approval_id?: string;
  incurred_at?: string;
  recorded_by?: string;
}

export interface AuditEvent {
  audit_id: string;
  organization_id: string;
  event_id: string;
  timestamp: string;
  action: string;
  actor_type: "user" | "agent" | "system";
  actor_id: string;
  resource_type: string;
  resource_id: string;
  outcome: "success" | "failure" | "pending";
  tool_used?: string;
  policy_evaluated?: string;
  approval_id?: string;
}

export interface AgentChatRequest { message: string; session_id?: string; event_id?: string; fun_mode?: boolean; }
export interface AgentEvidence { tool: string; summary: string; }
export interface AgentChatResponse {
  session_id: string;
  reply: string;
  tools_used: string[];
  approvals_created: string[];
  turns_taken: number;
  latency_ms: number;
  truncated: boolean;
  evidence: AgentEvidence[];
}
export interface AgentTool {
  name: string;
  description: string;
  risk_action: string;
  risk_tier: "LOW" | "MEDIUM" | "HIGH" | "NEVER";
  requires_approval: boolean;
  mutating: boolean;
  roles: Role[];
}
export interface AgentCapabilities {
  role: Role;
  model_id: string;
  model_region: string;
  tool_count: number;
  tools: AgentTool[];
  automatic: string[];
  requires_approval: string[];
  withheld_from_role: string[];
  notes: string[];
}
export interface AgentActivityEntry {
  audit_id: string;
  timestamp: string;
  action: string;
  resource_type: string;
  resource_id: string;
  tool_used?: string;
  policy_evaluated?: string;
  approval_id?: string;
  outcome: string;
  summary: string;
}
export interface AgentActivityResponse {
  activity: AgentActivityEntry[];
  count: number;
  refused_count: number;
  awaiting_approval_count: number;
}

export interface Registration {
  registration_id: string;
  event_id: string;
  attendee_name: string;
  attendee_email: string;
  attendee_phone: string;
  ticket_type: string;
  status: "CONFIRMED" | "PENDING" | "CANCELLED" | "WAITLISTED";
  payment_status: "CAPTURED" | "PENDING" | "FAILED" | "REFUNDED" | "NOT_REQUIRED";
  is_checked_in: boolean;
}
export interface RegistrationMatch {
  registration_id: string;
  attendee_name: string;
  attendee_email?: string;
  ticket_type?: string;
  status?: Registration["status"];
  payment_status?: Registration["payment_status"];
  is_checked_in?: boolean;
}
export interface VerificationCheck { name: string; status: "PASS" | "FAIL" | "WARN"; message: string; }
export interface VerifiedRegistration { attendee_name: string; ticket_type?: string; status: string; payment_status: string; }
export interface SearchResult {
  found: boolean;
  count: number;
  registrations: RegistrationMatch[];
  requires_disambiguation?: boolean;
  message?: string;
}
export interface VerifyCheckinResponse {
  registration_id: string;
  verification: { all_passed: boolean; checks: VerificationCheck[] };
  registration: VerifiedRegistration;
}
export interface TicketResult { ticket_id: string; registration_id: string; download_url: string; already_existed: boolean; message: string; }
export interface CompleteCheckinResponse { registration_id: string; status: "CHECKED_IN"; checked_in_at: string; message: string; was_already_checked_in: boolean; }
export interface ReconcileResult {
  reconciled: boolean;
  message: string;
  registration_id?: string;
  registration?: VerifiedRegistration;
  recovery_case_created?: boolean;
}
export interface VerifyQrResponse { valid: true; registration_id: string; attendee_name: string; ticket_status: string; message: string; }

export interface DemoSession {
  id_token: string;
  expires_in: number;
  email: string;
  organization_id: string;
  role: "TEAM_MEMBER";
  is_demo: true;
  message: string;
}

export interface SignedInUser {
  userId: string;
  email: string;
  name: string;
  role: Role;
  organizations: string[];
  isDemo: boolean;
}

export type StatusLevel = "healthy" | "attention" | "warning" | "critical" | "completed" | "awaiting_approval";
