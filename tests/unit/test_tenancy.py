"""Tests for tenant authorization.

These cover the guard that prevents cross-tenant access (IDOR): the
caller-supplied `organization_id` must match an organization the authenticated
principal is a member of, as carried by the Cognito `cognito:groups` claim.
"""

from services.shared.tenancy import (
    authorize_organization,
    get_caller_organizations,
    get_user_id,
)

ORG_A = "ORG-wemakedev"
ORG_B = "ORG-tenant-b"


def _event(groups=None, sub="user-123", include_authorizer=True):
    """Build a minimal API Gateway event with Cognito authorizer claims."""
    claims = {"sub": sub}
    if groups is not None:
        claims["cognito:groups"] = groups
    if not include_authorizer:
        return {}
    return {"requestContext": {"authorizer": {"claims": claims}}}


class TestGetCallerOrganizations:
    def test_single_group(self):
        assert get_caller_organizations(_event(ORG_A)) == {ORG_A}

    def test_comma_separated(self):
        assert get_caller_organizations(_event(f"{ORG_A},{ORG_B}")) == {ORG_A, ORG_B}

    def test_comma_space_separated(self):
        assert get_caller_organizations(_event(f"{ORG_A}, {ORG_B}")) == {ORG_A, ORG_B}

    def test_bracketed_space_separated(self):
        assert get_caller_organizations(_event(f"[{ORG_A} {ORG_B}]")) == {ORG_A, ORG_B}

    def test_actual_list(self):
        assert get_caller_organizations(_event([ORG_A, ORG_B])) == {ORG_A, ORG_B}

    def test_missing_claim_returns_empty(self):
        assert get_caller_organizations(_event()) == set()

    def test_empty_claim_returns_empty(self):
        assert get_caller_organizations(_event("")) == set()

    def test_whitespace_claim_returns_empty(self):
        assert get_caller_organizations(_event("   ")) == set()

    def test_no_authorizer_context_returns_empty(self):
        assert get_caller_organizations(_event(include_authorizer=False)) == set()


class TestGetUserId:
    def test_extracts_sub(self):
        assert get_user_id(_event(ORG_A, sub="abc-789")) == "abc-789"

    def test_defaults_to_anonymous(self):
        assert get_user_id({}) == "anonymous"


class TestAuthorizeOrganization:
    def test_member_is_allowed(self):
        assert authorize_organization(_event(ORG_A), ORG_A) is None

    def test_member_of_multiple_orgs_allowed_for_each(self):
        ev = _event(f"{ORG_A},{ORG_B}")
        assert authorize_organization(ev, ORG_A) is None
        assert authorize_organization(ev, ORG_B) is None

    def test_cross_tenant_request_denied(self):
        response = authorize_organization(_event(ORG_A), ORG_B)
        assert response is not None
        assert response["statusCode"] == 403

    def test_denial_uses_forbidden_error_category(self):
        import json

        response = authorize_organization(_event(ORG_A), ORG_B)
        assert json.loads(response["body"])["error"] == "FORBIDDEN"

    def test_denial_message_does_not_leak_org_membership(self):
        response = authorize_organization(_event(ORG_A), ORG_B)
        body = response["body"]
        assert ORG_A not in body

    def test_missing_groups_claim_fails_closed(self):
        response = authorize_organization(_event(), ORG_A)
        assert response is not None
        assert response["statusCode"] == 403

    def test_no_authorizer_context_fails_closed(self):
        response = authorize_organization(_event(include_authorizer=False), ORG_A)
        assert response is not None
        assert response["statusCode"] == 403

    def test_empty_requested_org_fails_closed(self):
        response = authorize_organization(_event(ORG_A), "")
        assert response is not None
        assert response["statusCode"] == 403

    def test_substring_org_id_is_not_a_match(self):
        """A caller in ORG-wemakedev must not gain access to ORG-wemakedev-staging."""
        response = authorize_organization(_event(ORG_A), f"{ORG_A}-staging")
        assert response is not None
        assert response["statusCode"] == 403
