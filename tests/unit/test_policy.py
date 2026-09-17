"""Tests for Cedar policy evaluation."""

from services.shared.policy import PolicyDecision, evaluate_policy


ORG = "ORG-wemakedev"


class TestTenantIsolation:
    """The most critical policy: no cross-tenant access."""

    def test_same_org_allowed(self) -> None:
        result = evaluate_policy("ReadOperationalState", "user-1", "ADMIN", ORG, ORG)
        assert result.decision == PolicyDecision.ALLOW

    def test_different_org_denied(self) -> None:
        result = evaluate_policy("ReadOperationalState", "user-1", "ADMIN", ORG, "ORG-other")
        assert result.decision == PolicyDecision.DENY
        assert "tenant" in result.reason.lower()

    def test_tenant_violation_blocks_even_low_risk(self) -> None:
        result = evaluate_policy("CreateInternalTask", "user-1", "OWNER", ORG, "ORG-other")
        assert result.decision == PolicyDecision.DENY


class TestLowRiskActions:
    def test_read_state_allowed(self) -> None:
        result = evaluate_policy("ReadOperationalState", "user-1", "VOLUNTEER", ORG, ORG)
        assert result.decision == PolicyDecision.ALLOW

    def test_create_task_allowed(self) -> None:
        result = evaluate_policy("CreateInternalTask", "user-1", "VOLUNTEER", ORG, ORG)
        assert result.decision == PolicyDecision.ALLOW

    def test_draft_message_allowed(self) -> None:
        result = evaluate_policy("DraftMessage", "agent-1", "ORGANIZER", ORG, ORG)
        assert result.decision == PolicyDecision.ALLOW


class TestMediumRiskActions:
    def test_organizer_can_send_communication(self) -> None:
        result = evaluate_policy("SendRoutineCommunication", "user-1", "ORGANIZER", ORG, ORG)
        assert result.decision == PolicyDecision.ALLOW

    def test_admin_can_send_communication(self) -> None:
        result = evaluate_policy("SendRoutineCommunication", "user-1", "ADMIN", ORG, ORG)
        assert result.decision == PolicyDecision.ALLOW

    def test_volunteer_cannot_send_communication(self) -> None:
        result = evaluate_policy("SendRoutineCommunication", "user-1", "VOLUNTEER", ORG, ORG)
        assert result.decision == PolicyDecision.DENY

    def test_viewer_cannot_update_metadata(self) -> None:
        result = evaluate_policy("UpdateEventMetadata", "user-1", "VIEWER", ORG, ORG)
        assert result.decision == PolicyDecision.DENY


class TestHighRiskActions:
    def test_refund_requires_approval(self) -> None:
        result = evaluate_policy("ProcessRefund", "user-1", "ADMIN", ORG, ORG)
        assert result.decision == PolicyDecision.REQUIRES_APPROVAL

    def test_refund_allowed_with_approval(self) -> None:
        result = evaluate_policy("ProcessRefund", "user-1", "ADMIN", ORG, ORG, has_approval=True)
        assert result.decision == PolicyDecision.ALLOW

    def test_booking_requires_approval(self) -> None:
        result = evaluate_policy("BookAccommodation", "agent-1", "ORGANIZER", ORG, ORG)
        assert result.decision == PolicyDecision.REQUIRES_APPROVAL

    def test_confirm_speaker_requires_approval(self) -> None:
        result = evaluate_policy("ConfirmSpeaker", "agent-1", "ORGANIZER", ORG, ORG)
        assert result.decision == PolicyDecision.REQUIRES_APPROVAL

    def test_cancel_registration_requires_approval(self) -> None:
        result = evaluate_policy("CancelRegistration", "user-1", "OWNER", ORG, ORG)
        assert result.decision == PolicyDecision.REQUIRES_APPROVAL

    def test_unknown_action_defaults_to_high_risk(self) -> None:
        """Unknown actions are treated as HIGH_RISK by default — fail closed."""
        result = evaluate_policy("UnknownDangerousAction", "user-1", "ADMIN", ORG, ORG)
        assert result.decision == PolicyDecision.REQUIRES_APPROVAL
