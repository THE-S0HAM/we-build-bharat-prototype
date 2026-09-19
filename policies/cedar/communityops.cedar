// CommunityOps Cedar Policies
//
// GENERATED FILE — do not edit by hand.
// Source of truth: ACTION_RISK_LEVELS in services/shared/policy.py
// Regenerate with: python scripts/generate-cedar-policies.py
//
// This file is the declarative specification of the authority model. The runtime
// enforcement engine is services/shared/policy.py; see its module docstring for why
// there is one engine rather than two. tests/unit/test_policy_consistency.py fails if
// this file and the catalogue stop agreeing.
//
// Tier encoding:
//   LOW     -> permit, unconditional
//   MEDIUM  -> permit, guarded by an operational-role condition
//   HIGH    -> forbid, unless context.has_approval
//   NEVER   -> forbid, unconditional


// =====================================================================
// LOW RISK — reversible, internal, no external consequence.
// Agents may perform these without asking.
// =====================================================================

permit(
    principal,
    action == Action::"AddIncidentComment",
    resource
);

permit(
    principal,
    action == Action::"AssignTask",
    resource
);

permit(
    principal,
    action == Action::"AssignTeamMember",
    resource
);

permit(
    principal,
    action == Action::"CompleteTask",
    resource
);

permit(
    principal,
    action == Action::"ComputeEventHealth",
    resource
);

permit(
    principal,
    action == Action::"CreateIncident",
    resource
);

permit(
    principal,
    action == Action::"CreateInternalTask",
    resource
);

permit(
    principal,
    action == Action::"CreateTeam",
    resource
);

permit(
    principal,
    action == Action::"DraftMessage",
    resource
);

permit(
    principal,
    action == Action::"GenerateDraft",
    resource
);

permit(
    principal,
    action == Action::"GenerateEventBrief",
    resource
);

permit(
    principal,
    action == Action::"ReadNotifications",
    resource
);

permit(
    principal,
    action == Action::"ReadOperationalState",
    resource
);

permit(
    principal,
    action == Action::"ScheduleReminder",
    resource
);

permit(
    principal,
    action == Action::"SearchEventDocuments",
    resource
);

permit(
    principal,
    action == Action::"SendInternalReminder",
    resource
);

permit(
    principal,
    action == Action::"SummarizeData",
    resource
);

permit(
    principal,
    action == Action::"UpdateTask",
    resource
);

permit(
    principal,
    action == Action::"UpdateTeam",
    resource
);


// =====================================================================
// MEDIUM RISK — real operational effect.
// Permitted for operational roles, always audited.
// =====================================================================

permit(
    principal,
    action == Action::"AcknowledgeIncident",
    resource
) when {
    principal.role == "ADMIN" || principal.role == "LEADER" || principal.role == "ORGANIZER" || principal.role == "OWNER"
};

permit(
    principal,
    action == Action::"CompleteCheckIn",
    resource
) when {
    principal.role == "ADMIN" || principal.role == "LEADER" || principal.role == "ORGANIZER" || principal.role == "OWNER"
};

permit(
    principal,
    action == Action::"CreateEvent",
    resource
) when {
    principal.role == "ADMIN" || principal.role == "LEADER" || principal.role == "ORGANIZER" || principal.role == "OWNER"
};

permit(
    principal,
    action == Action::"EscalateIncident",
    resource
) when {
    principal.role == "ADMIN" || principal.role == "LEADER" || principal.role == "ORGANIZER" || principal.role == "OWNER"
};

permit(
    principal,
    action == Action::"GenerateTicket",
    resource
) when {
    principal.role == "ADMIN" || principal.role == "LEADER" || principal.role == "ORGANIZER" || principal.role == "OWNER"
};

permit(
    principal,
    action == Action::"ReassignTask",
    resource
) when {
    principal.role == "ADMIN" || principal.role == "LEADER" || principal.role == "ORGANIZER" || principal.role == "OWNER"
};

permit(
    principal,
    action == Action::"RequestApproval",
    resource
) when {
    principal.role == "ADMIN" || principal.role == "LEADER" || principal.role == "ORGANIZER" || principal.role == "OWNER"
};

permit(
    principal,
    action == Action::"SendRoutineCommunication",
    resource
) when {
    principal.role == "ADMIN" || principal.role == "LEADER" || principal.role == "ORGANIZER" || principal.role == "OWNER"
};

permit(
    principal,
    action == Action::"SendSpeakerFollowup",
    resource
) when {
    principal.role == "ADMIN" || principal.role == "LEADER" || principal.role == "ORGANIZER" || principal.role == "OWNER"
};

permit(
    principal,
    action == Action::"UpdateEventMetadata",
    resource
) when {
    principal.role == "ADMIN" || principal.role == "LEADER" || principal.role == "ORGANIZER" || principal.role == "OWNER"
};

permit(
    principal,
    action == Action::"UpdateIncident",
    resource
) when {
    principal.role == "ADMIN" || principal.role == "LEADER" || principal.role == "ORGANIZER" || principal.role == "OWNER"
};

permit(
    principal,
    action == Action::"UpdateSpeaker",
    resource
) when {
    principal.role == "ADMIN" || principal.role == "LEADER" || principal.role == "ORGANIZER" || principal.role == "OWNER"
};

permit(
    principal,
    action == Action::"UploadDocument",
    resource
) when {
    principal.role == "ADMIN" || principal.role == "LEADER" || principal.role == "ORGANIZER" || principal.role == "OWNER"
};


// =====================================================================
// HIGH RISK — money, irreversibility, or someone outside the organization.
// Forbidden unless a human approval backs the call.
// =====================================================================

forbid(
    principal,
    action == Action::"AccommodationCommitment",
    resource
) unless {
    context.has_approval == true
};

forbid(
    principal,
    action == Action::"AllocateBudget",
    resource
) unless {
    context.has_approval == true
};

forbid(
    principal,
    action == Action::"ApproveExpenditure",
    resource
) unless {
    context.has_approval == true
};

forbid(
    principal,
    action == Action::"ArchiveEvent",
    resource
) unless {
    context.has_approval == true
};

forbid(
    principal,
    action == Action::"BookAccommodation",
    resource
) unless {
    context.has_approval == true
};

forbid(
    principal,
    action == Action::"CancelRegistration",
    resource
) unless {
    context.has_approval == true
};

forbid(
    principal,
    action == Action::"ConfirmSpeaker",
    resource
) unless {
    context.has_approval == true
};

forbid(
    principal,
    action == Action::"DecideApproval",
    resource
) unless {
    context.has_approval == true
};

forbid(
    principal,
    action == Action::"FinancialCommitment",
    resource
) unless {
    context.has_approval == true
};

forbid(
    principal,
    action == Action::"ModifyPublishedEvent",
    resource
) unless {
    context.has_approval == true
};

forbid(
    principal,
    action == Action::"ProcessRefund",
    resource
) unless {
    context.has_approval == true
};

forbid(
    principal,
    action == Action::"RecordExpense",
    resource
) unless {
    context.has_approval == true
};

forbid(
    principal,
    action == Action::"ResolveIncident",
    resource
) unless {
    context.has_approval == true
};

forbid(
    principal,
    action == Action::"RevokeTicket",
    resource
) unless {
    context.has_approval == true
};

forbid(
    principal,
    action == Action::"SendExternalSpeakerMessage",
    resource
) unless {
    context.has_approval == true
};


// =====================================================================
// NEVER AUTONOMOUS — outside what an automated system may do at all.
// No approval unlocks these. Only a human acting directly.
// =====================================================================

forbid(
    principal,
    action == Action::"ContractSigning",
    resource
);

forbid(
    principal,
    action == Action::"DeleteAuditRecord",
    resource
);

forbid(
    principal,
    action == Action::"ModifyAuthorizationPolicy",
    resource
);


// =====================================================================
// TENANT ISOLATION — checked before anything else
// =====================================================================

// Every action, regardless of tier, is forbidden across an organization
// boundary. The runtime engine evaluates this first for the same reason: the
// boundary crossing is the failure, not the sensitivity of the data reached.
forbid(
    principal,
    action,
    resource
) unless {
    principal.organization_id == resource.organization_id
};
