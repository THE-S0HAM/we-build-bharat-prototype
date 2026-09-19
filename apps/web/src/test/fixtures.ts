/**
 * Fixtures mirroring the seeded demo event.
 *
 * The figures are the real ones from `scripts/seed-demo.py`: a ₹2,50,000 budget with ₹75,000
 * remaining, an ORANGE event at 52/100, and APR-001 as a ₹12,500 accommodation commitment. Using
 * the actual seeded values means a test failure points at a real regression rather than at a
 * number somebody invented for the test.
 */

import type {
  AgentActivityResponse,
  Approval,
  ApprovalDetailResponse,
  BudgetSummary,
  CommandCenterData,
  Incident,
  IncidentDetailResponse,
} from "../types";

export const ORG_ID = "ORG-wemakedev";
export const EVENT_ID = "EVT-acd-mh-2026";

export const APPROVAL_001: Approval = {
  approval_id: "APR-001",
  event_id: EVENT_ID,
  title: "Accommodation for Kavya Nair — 2 nights",
  description: "Two nights near the venue so she can deliver the opening keynote.",
  status: "PENDING",
  risk_level: "HIGH",
  requested_action: "AccommodationCommitment",
  reason: "Speaker travelling from Bengaluru with a 9am session.",
  evidence: { nights: 2, speaker_id: "SPK-004", confirmed: true },
  affected_resource_type: "Speaker",
  affected_resource_id: "SPK-004",
  amount_inr: 12500,
  currency: "INR",
  budget_category: "ACCOMMODATION",
  budget_impact: "Remaining 75,000 -> 62,500",
  agent_name: "CommunityOps",
  agent_recommendation: "Affordable within the accommodation allocation.",
  requested_at: new Date(Date.now() - 5 * 36e5).toISOString(),
};

export const BUDGET_BEFORE: BudgetSummary = {
  event_id: EVENT_ID,
  currency: "INR",
  total_budget: 250000,
  allocated: 240000,
  spent: 130000,
  committed: 45000,
  remaining: 75000,
  unallocated: 10000,
  utilization_percent: 70,
  exists: true,
  categories: [
    {
      category: "ACCOMMODATION",
      allocated: 60000,
      spent: 20000,
      committed: 15000,
      remaining: 25000,
      utilization_percent: 58,
    },
    {
      category: "EQUIPMENT",
      allocated: 40000,
      spent: 30000,
      committed: 8000,
      remaining: 2000,
      utilization_percent: 95,
    },
  ],
};

export const COMMAND_CENTER: CommandCenterData = {
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
    attention_required: 4,
  },
  events: [
    {
      event_id: EVENT_ID,
      name: "AWS Community Day — Maharashtra 2026",
      status: "ACTIVE",
      start_date: new Date(Date.now() + 21 * 864e5).toISOString(),
      health_band: "ORANGE",
      health_score: 52,
      health_reasons: ["Unresolved: 1 high-severity incident", "2 overdue tasks"],
      detailed: true,
      pending_approvals: 5,
      open_incidents: 2,
      overdue_tasks: 2,
      budget_remaining_inr: 75000,
      budget_utilization_percent: 70,
    },
  ],
  attention_items: [
    {
      kind: "APPROVAL",
      severity: "HIGH",
      title: "Accommodation for Kavya Nair — 2 nights",
      detail: "AccommodationCommitment — 12,500 INR",
      resource_type: "Approval",
      resource_id: "APR-001",
      event_id: EVENT_ID,
    },
    {
      kind: "INCIDENT",
      severity: "HIGH",
      title: "Main hall projector failed during AV testing",
      detail: "HIGH incident, status RECOMMENDATION_READY",
      resource_type: "Incident",
      resource_id: "INC-001",
      event_id: EVENT_ID,
    },
  ],
  recent_actions: [],
};

export const APPROVAL_DETAIL: ApprovalDetailResponse = {
  approval: APPROVAL_001,
  budget_projection: {
    category: "ACCOMMODATION",
    amount_inr: 12500,
    affordable: true,
    blockers: [],
    current_remaining: 75000,
    projected_remaining: 62500,
    current_committed: 45000,
    projected_committed: 57500,
    current_utilization_percent: 70,
    projected_utilization_percent: 75,
    impact_summary: "Affordable. Remaining would go from 75,000 to 62,500.",
  },
};

export const AGENT_ACTIVITY: AgentActivityResponse = {
  activity: [
    {
      audit_id: "AUD-1",
      timestamp: new Date(Date.now() - 2 * 36e5).toISOString(),
      action: "AGENT_PREPARE_SPEAKER_FOLLOWUP",
      resource_type: "Speaker",
      resource_id: "SPK-002",
      tool_used: "prepare_speaker_followup",
      outcome: "success",
      summary: "Drafted a follow-up to Raj Malhotra after 96 hours of silence.",
    },
  ],
  count: 1,
  refused_count: 0,
  awaiting_approval_count: 0,
};

export const INCIDENT_001: Incident = {
  incident_id: "INC-001",
  event_id: EVENT_ID,
  title: "Main hall projector failed during AV testing",
  description: "The primary projector shut down twice during the AV run-through.",
  severity: "HIGH",
  status: "RECOMMENDATION_READY",
  category: "EQUIPMENT",
  team_id: "TEAM-tech",
  affected_resource_type: "Venue",
  affected_resource_id: "MAIN-HALL",
  detected_at: new Date(Date.now() - 6 * 36e5).toISOString(),
  reported_by_name: "Rahul Patil",
  dependencies: ["Opening keynote"],
  backup_options: ["Hire a replacement unit"],
  recommendation: "Hire a replacement projector and keep the current unit as backup.",
  comment_count: 1,
};

export const INCIDENT_DETAIL: IncidentDetailResponse = {
  incident: INCIDENT_001,
  comments: [
    {
      comment_id: "CMT-001",
      incident_id: "INC-001",
      event_id: EVENT_ID,
      body: "Confirmed the projector overheats after about twenty minutes.",
      author_id: "demo-team-rahul",
      author_name: "Rahul Patil",
      author_type: "user",
      created_at: new Date(Date.now() - 5 * 36e5).toISOString(),
    },
    {
      comment_id: "CMT-004",
      incident_id: "INC-001",
      event_id: EVENT_ID,
      body: "Two vendors nearby can deliver a replacement within four hours.",
      author_id: "CommunityOps",
      author_name: "CommunityOps",
      author_type: "agent",
      created_at: new Date(Date.now() - 3 * 36e5).toISOString(),
    },
  ],
  comment_count: 2,
};
