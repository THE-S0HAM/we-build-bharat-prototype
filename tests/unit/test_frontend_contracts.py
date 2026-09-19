"""The two routes the frontend needed that did not exist.

Both were added because a UI requirement had no backend contract, which is the only reason to touch
the backend during a frontend pass. These tests pin the contracts the console depends on, and — for
the demo endpoint — the security properties that make an unauthenticated route acceptable.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from tests.conftest import EVENT_ID, ORG_ID, api_event, body_of


class TestAttendeeOpsContract:
    """GET /events/{eventId}/attendees — aggregates plus actionable exceptions."""

    def test_it_returns_the_readiness_funnel_and_summary(self, seeded) -> None:  # noqa: ANN001
        from services.api.operations_handler import handler

        response = handler(
            api_event(
                path="/events/{eventId}/attendees",
                path_parameters={"eventId": EVENT_ID},
            ),
            None,
        )
        assert response["statusCode"] == 200
        body = body_of(response)

        assert body["summary"]["total_registered"] > 0
        assert body["summary"]["data_completeness_percent"] > 0
        assert [stage["stage"] for stage in body["funnel"]] == [
            "Registered",
            "Confirmed",
            "Information complete",
            "Checked in",
        ]

    def test_the_funnel_narrows_monotonically(self, seeded) -> None:  # noqa: ANN001
        """Each stage is a subset of the one above it.

        A funnel that widens is not a funnel, and it would mean the stages were counted from
        different populations.
        """
        from services.api.operations_handler import handler

        body = body_of(
            handler(
                api_event(
                    path="/events/{eventId}/attendees",
                    path_parameters={"eventId": EVENT_ID},
                ),
                None,
            )
        )
        counts = [int(stage["count"]) for stage in body["funnel"]]
        assert counts == sorted(counts, reverse=True), counts

    def test_the_figures_match_the_agent_tool(self, seeded, leader) -> None:  # noqa: ANN001
        """The screen and the agent must not disagree about the same event.

        Both read the one AttendeeState aggregation. If either recomputed, they could report
        different numbers of missing dietary details for the same registrations.
        """
        from services.api.operations_handler import handler
        from tests.conftest import MAIN_TABLE
        from tools.community_ops import registry
        from tools.registry import ToolContext

        endpoint = body_of(
            handler(
                api_event(
                    path="/events/{eventId}/attendees",
                    path_parameters={"eventId": EVENT_ID},
                ),
                None,
            )
        )["summary"]

        tool = registry.invoke(
            "get_attendee_summary",
            {"event_id": EVENT_ID},
            ToolContext(
                principal=leader,
                organization_id=ORG_ID,
                table_name=MAIN_TABLE,
                default_event_id=EVENT_ID,
            ),
        )

        for field in (
            "total_registered",
            "confirmed",
            "checked_in",
            "dietary_missing",
            "missing_information",
            "data_completeness_percent",
        ):
            assert endpoint[field] == tool[field], field

    def test_exception_lists_are_capped_but_report_the_true_total(self, seeded) -> None:  # noqa: ANN001
        """A leader acts on a list they can read; the count tells them the real size."""
        from services.api.operations_handler import handler

        body = body_of(
            handler(
                api_event(
                    path="/events/{eventId}/attendees",
                    path_parameters={"eventId": EVENT_ID},
                ),
                None,
            )
        )
        exceptions = body["exceptions"]
        assert len(exceptions["missing_dietary"]) <= 25
        assert exceptions["missing_dietary_total"] >= len(exceptions["missing_dietary"])

    def test_exceptions_carry_no_contact_details(self, seeded) -> None:  # noqa: ANN001
        """The operational question is who we still need something from, not everyone's address."""
        from services.api.operations_handler import handler

        body = body_of(
            handler(
                api_event(
                    path="/events/{eventId}/attendees",
                    path_parameters={"eventId": EVENT_ID},
                ),
                None,
            )
        )
        for group in ("missing_dietary", "accommodation_pending", "arrival_unconfirmed"):
            for entry in body["exceptions"][group]:
                assert "attendee_email" not in entry, group
                assert "attendee_phone" not in entry, group

    def test_cancelled_registrations_are_excluded_from_exceptions(self, seeded) -> None:  # noqa: ANN001
        """A cancelled registration is not an operational data gap."""
        from services.api.operations_handler import handler

        body = body_of(
            handler(
                api_event(
                    path="/events/{eventId}/attendees",
                    path_parameters={"eventId": EVENT_ID},
                ),
                None,
            )
        )
        # Neha Gupta is the seeded CANCELLED registration.
        all_ids = {
            entry["registration_id"]
            for group in body["exceptions"].values()
            if isinstance(group, list)
            for entry in group
        }
        assert "REG-2026-004805" not in all_ids

    def test_a_team_member_outside_the_event_is_refused(self, seeded) -> None:  # noqa: ANN001
        from services.api.operations_handler import handler

        response = handler(
            api_event(
                path="/events/{eventId}/attendees",
                groups=[ORG_ID, "TEAM_MEMBER"],
                user_id="member-with-no-teams",
                path_parameters={"eventId": EVENT_ID},
            ),
            None,
        )
        assert response["statusCode"] == 403

    def test_cross_tenant_is_refused(self, seeded) -> None:  # noqa: ANN001
        from services.api.operations_handler import handler

        response = handler(
            api_event(
                path="/events/{eventId}/attendees",
                organization_id="ORG-someone-else",
                groups=[ORG_ID, "LEADER"],
                path_parameters={"eventId": EVENT_ID},
            ),
            None,
        )
        assert response["statusCode"] == 403


class TestDemoSessionEndpoint:
    """POST /demo/session — the only unauthenticated route in the API.

    Its security rests on one property: the username is a module constant, so there is no input that
    changes which account is authenticated. These tests pin that.
    """

    @staticmethod
    def _reload(monkeypatch: pytest.MonkeyPatch, **env: str) -> Any:
        """Re-import the handler so module-level env constants are re-read."""
        import importlib

        for key in ("DEMO_PASSWORD", "USER_POOL_ID", "USER_POOL_CLIENT_ID", "DEMO_USERNAME"):
            monkeypatch.delenv(key, raising=False)
        for key, value in env.items():
            monkeypatch.setenv(key, value)

        import services.api.demo_handler as demo_handler

        return importlib.reload(demo_handler)

    def test_it_refuses_clearly_when_not_configured(self, monkeypatch) -> None:  # noqa: ANN001
        """A deployment without demo credentials degrades honestly.

        The console hides the demo action on this response rather than offering a broken button.
        """
        module = self._reload(monkeypatch)
        response = module.handler({"httpMethod": "POST"}, None)
        assert response["statusCode"] == 404
        assert "not configured" in body_of(response)["message"]

    def test_only_post_is_accepted(self, monkeypatch) -> None:  # noqa: ANN001
        module = self._reload(monkeypatch)
        response = module.handler({"httpMethod": "GET"}, None)
        assert response["statusCode"] == 400

    def test_the_username_is_not_taken_from_the_request(self, monkeypatch) -> None:  # noqa: ANN001
        """The property that stops this being a sign-in oracle for the whole pool.

        A body naming another account must not change who gets authenticated.
        """
        module = self._reload(
            monkeypatch,
            DEMO_PASSWORD="fake-password",
            USER_POOL_ID="ap-south-1_test",
            USER_POOL_CLIENT_ID="client-test",
        )

        captured: dict[str, Any] = {}

        class FakeCognito:
            def admin_initiate_auth(self, **kwargs: Any) -> dict[str, Any]:
                captured.update(kwargs)
                return {
                    "AuthenticationResult": {
                        "IdToken": "fake.id.token",
                        "ExpiresIn": 3600,
                    }
                }

        monkeypatch.setattr(module.boto3, "client", lambda *a, **k: FakeCognito())

        response = module.handler(
            {
                "httpMethod": "POST",
                "body": json.dumps(
                    {"username": "leader.demo@communityops.local", "email": "admin@evil.example"}
                ),
            },
            None,
        )
        assert response["statusCode"] == 200
        # The constant, not anything from the body.
        assert captured["AuthParameters"]["USERNAME"] == "demo@communityops.local"

    def test_a_successful_session_returns_a_token_and_no_secret(self, monkeypatch) -> None:  # noqa: ANN001
        module = self._reload(
            monkeypatch,
            DEMO_PASSWORD="fake-password",
            USER_POOL_ID="ap-south-1_test",
            USER_POOL_CLIENT_ID="client-test",
        )

        class FakeCognito:
            def admin_initiate_auth(self, **kwargs: Any) -> dict[str, Any]:
                return {"AuthenticationResult": {"IdToken": "fake.id.token", "ExpiresIn": 3600}}

        monkeypatch.setattr(module.boto3, "client", lambda *a, **k: FakeCognito())

        response = module.handler({"httpMethod": "POST"}, None)
        body = body_of(response)

        assert body["id_token"] == "fake.id.token"
        assert body["is_demo"] is True
        # A demo visitor is a team member, and the console reads this to avoid rendering
        # leader-only affordances.
        assert body["role"] == "TEAM_MEMBER"
        # The password must never travel back.
        assert "fake-password" not in json.dumps(body)
        assert "password" not in json.dumps(body).lower()

    def test_an_auth_challenge_is_reported_as_a_setup_problem(self, monkeypatch) -> None:  # noqa: ANN001
        """NEW_PASSWORD_REQUIRED means the account was left with a temporary password.

        There is no interactive party to answer a challenge, so this is a setup failure rather than
        something to prompt about.
        """
        module = self._reload(
            monkeypatch,
            DEMO_PASSWORD="fake-password",
            USER_POOL_ID="ap-south-1_test",
            USER_POOL_CLIENT_ID="client-test",
        )

        class FakeCognito:
            def admin_initiate_auth(self, **kwargs: Any) -> dict[str, Any]:
                return {"ChallengeName": "NEW_PASSWORD_REQUIRED", "Session": "x"}

        monkeypatch.setattr(module.boto3, "client", lambda *a, **k: FakeCognito())

        response = module.handler({"httpMethod": "POST"}, None)
        assert response["statusCode"] == 502
        assert "setup-demo-users" in body_of(response)["message"]

    def test_cognito_errors_do_not_leak_detail(self, monkeypatch) -> None:  # noqa: ANN001
        """Cognito error text can name the account and the pool. It is logged, not forwarded."""
        from botocore.exceptions import ClientError

        module = self._reload(
            monkeypatch,
            DEMO_PASSWORD="fake-password",
            USER_POOL_ID="ap-south-1_test",
            USER_POOL_CLIENT_ID="client-test",
        )

        class FakeCognito:
            def admin_initiate_auth(self, **kwargs: Any) -> dict[str, Any]:
                raise ClientError(
                    {
                        "Error": {
                            "Code": "NotAuthorizedException",
                            "Message": "Incorrect username or password for pool ap-south-1_test",
                        }
                    },
                    "AdminInitiateAuth",
                )

        monkeypatch.setattr(module.boto3, "client", lambda *a, **k: FakeCognito())

        response = module.handler({"httpMethod": "POST"}, None)
        message = body_of(response)["message"]
        assert response["statusCode"] == 502
        assert "ap-south-1_test" not in message
        assert "password" not in message.lower()
