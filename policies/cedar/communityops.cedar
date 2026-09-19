// CommunityOps Cedar Policies
// Defines what actions agents and users may perform,
// and which actions require human approval.

// =====================================================
// LOW RISK — agents may perform without approval
// =====================================================

permit(
    principal,
    action == Action::"ReadOperationalState",
    resource
);

permit(
    principal,
    action == Action::"CreateInternalTask",
    resource
);

permit(
    principal,
    action == Action::"DraftMessage",
    resource
);

permit(
    principal,
    action == Action::"ScheduleReminder",
    resource
);

permit(
    principal,
    action == Action::"SummarizeData",
    resource
);

// =====================================================
// MEDIUM RISK — agents may perform, logged
// =====================================================

permit(
    principal,
    action == Action::"SendRoutineCommunication",
    resource
) when {
    principal.role == "ORGANIZER" || principal.role == "ADMIN"
};

permit(
    principal,
    action == Action::"UpdateEventMetadata",
    resource
) when {
    principal.role == "ORGANIZER" || principal.role == "ADMIN"
};

// =====================================================
// HIGH RISK — require human approval
// =====================================================

forbid(
    principal,
    action == Action::"ProcessRefund",
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
    action == Action::"ConfirmSpeaker",
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
    action == Action::"ModifyPublishedEvent",
    resource
) unless {
    context.has_approval == true
};

// =====================================================
// TENANT ISOLATION — enforce organization boundaries
// =====================================================

forbid(
    principal,
    action,
    resource
) unless {
    principal.organization_id == resource.organization_id
};
