"""End-to-end behaviour against the real query paths and the seeded demo data.

These tests exercise handlers through their actual entry points with real API Gateway events, so
they cover the parts most likely to be wrong: index sort keys, the authorization chain, and the
status transitions that have to rewrite a key or become invisible to a query.
"""

from __future__ import annotations

from services.shared.aggregate import load_event_snapshot
from services.shared.health import compute_health
from services.shared.models.event import HealthBand
from tests.conftest import (
    DEMO_SUB,
    EVENT_ID,
    LEADER_SUB,
    MAIN_TABLE,
    ORG_ID,
    OTHER_ORG_ID,
    TEAM_SUB,
    api_event,
    body_of,
)


class TestSeededSnapshot:
    """The aggregation has to find everything the seed wrote, through the real indexes."""

    def test_the_snapshot_loads_the_whole_event(self, seeded) -> None:  # noqa: ANN001
        snapshot = load_event_snapshot(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        assert snapshot.event.get("name", "").startswith("AWS Community Day")
        assert len(snapshot.teams) == 8
        assert len(snapshot.tasks) == 31
        assert len(snapshot.speakers) == 5
        assert len(snapshot.incidents) == 3
        assert len(snapshot.approvals) == 8

    def test_team_membership_is_found_through_the_index(self, seeded) -> None:  # noqa: ANN001
        """Members are indexed twice; this covers the event-scoped read."""
        snapshot = load_event_snapshot(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        assert sum(len(t.members) for t in snapshot.teams) == 20

    def test_incident_comments_are_excluded_from_the_incident_list(self, seeded) -> None:  # noqa: ANN001
        """Comments nest under the incident prefix, so a missing entity_type filter would leak."""
        snapshot = load_event_snapshot(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        assert all(i.get("entity_type") == "INCIDENT" for i in snapshot.incidents)

    def test_the_demo_story_is_present(self, seeded) -> None:  # noqa: ANN001
        """The specific situation the agent is supposed to be able to reason about."""
        snapshot = load_event_snapshot(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        assert len(snapshot.overdue_tasks) >= 2
        assert len(snapshot.blocked_tasks) >= 2
        assert len(snapshot.silent_speakers) == 1
        assert snapshot.silent_speakers[0]["name"] == "Raj Malhotra"
        assert snapshot.speaker_silent_hours(snapshot.silent_speakers[0]) >= 72
        assert len(snapshot.open_incidents_by_severity("HIGH")) == 1
        assert len(snapshot.pending_approvals) == 5
        assert snapshot.budget.remaining == 75_000

    def test_the_dependency_chain_is_intact(self, seeded) -> None:  # noqa: ANN001
        """Ticket generation is blocked on payment reconciliation, not independently late."""
        snapshot = load_event_snapshot(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        blocked = next(t for t in snapshot.tasks if t["task_id"] == "TSK-rg03")
        assert blocked["status"] == "BLOCKED"
        assert "TSK-rg02" in blocked["depends_on"]
        assert blocked["blocked_reason"]

    def test_decided_approvals_are_not_reported_as_pending(self, seeded) -> None:  # noqa: ANN001
        """Guards the stale-index-key bug: filtering on the attribute, not the sort key."""
        snapshot = load_event_snapshot(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        assert all(a["status"] == "PENDING" for a in snapshot.pending_approvals)
        decided = {a["approval_id"] for a in snapshot.approvals if a["status"] != "PENDING"}
        assert {"APR-006", "APR-007", "APR-008"} <= decided

    def test_health_computes_to_orange(self, seeded) -> None:  # noqa: ANN001
        """The documented demo state. Nothing writes the band; it is derived."""
        snapshot = load_event_snapshot(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        result = compute_health(snapshot)
        assert result.band is HealthBand.ORANGE, result.to_dict()
        assert result.reasons
        assert sum(r.points for r in result.reasons) == result.score


class TestTenantIsolation:
    """The boundary that matters most. Every route enforces it before any read."""

    def test_a_caller_cannot_read_another_organization(self, seeded) -> None:  # noqa: ANN001
        from services.api.operations_handler import handler

        response = handler(
            api_event(
                path="/events/{eventId}/health",
                organization_id=OTHER_ORG_ID,
                # Group membership is for their own org, but they ask for someone else's.
                groups=[ORG_ID, "LEADER"],
                path_parameters={"eventId": EVENT_ID},
            ),
            None,
        )
        assert response["statusCode"] == 403

    def test_a_role_group_cannot_be_passed_as_an_organization(self, seeded) -> None:  # noqa: ANN001
        """`cognito:groups` carries both roles and orgs, so a bare membership test would match."""
        from services.api.operations_handler import handler

        response = handler(
            api_event(
                path="/events/{eventId}/health",
                organization_id="LEADER",
                groups=[ORG_ID, "LEADER"],
                path_parameters={"eventId": EVENT_ID},
            ),
            None,
        )
        # Refused with the same response as any other unauthorized organization, so the route
        # cannot be used to probe which identifiers are well-formed.
        assert response["statusCode"] == 403

    def test_a_missing_groups_claim_fails_closed(self, seeded) -> None:  # noqa: ANN001
        from services.api.operations_handler import handler

        response = handler(
            api_event(
                path="/events/{eventId}/health",
                groups=[],
                path_parameters={"eventId": EVENT_ID},
            ),
            None,
        )
        assert response["statusCode"] == 403


class TestRoleEnforcement:
    def test_a_team_member_cannot_create_a_team(self, seeded) -> None:  # noqa: ANN001
        from services.api.teams_handler import handler

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/teams",
                groups=[ORG_ID, "TEAM_MEMBER"],
                user_id=TEAM_SUB,
                path_parameters={"eventId": EVENT_ID},
                body={"name": "My Own Team"},
            ),
            None,
        )
        assert response["statusCode"] == 403
        assert "leader" in body_of(response)["message"].lower()

    def test_a_team_member_cannot_decide_an_approval(self, seeded) -> None:  # noqa: ANN001
        """The central promise: only a human leader releases a consequential action."""
        from services.api.approvals_handler import handler

        response = handler(
            api_event(
                method="PUT",
                path="/events/{eventId}/approvals/{approvalId}",
                groups=[ORG_ID, "TEAM_MEMBER"],
                user_id=TEAM_SUB,
                path_parameters={"eventId": EVENT_ID, "approvalId": "APR-001"},
                body={"decision": "APPROVED"},
            ),
            None,
        )
        assert response["statusCode"] == 403

    def test_a_team_member_cannot_touch_the_budget(self, seeded) -> None:  # noqa: ANN001
        from services.api.budget_handler import handler

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/budget/allocations",
                groups=[ORG_ID, "TEAM_MEMBER"],
                user_id=TEAM_SUB,
                path_parameters={"eventId": EVENT_ID},
                body={"category": "EMERGENCY", "amount_inr": 5000},
            ),
            None,
        )
        assert response["statusCode"] == 403

    def test_a_team_member_can_read_the_budget(self, seeded) -> None:  # noqa: ANN001
        """Reading is not the restricted part; a volunteer may see what is left to spend."""
        from services.api.budget_handler import handler

        response = handler(
            api_event(
                path="/events/{eventId}/budget",
                groups=[ORG_ID, "TEAM_MEMBER"],
                user_id=TEAM_SUB,
                path_parameters={"eventId": EVENT_ID},
            ),
            None,
        )
        assert response["statusCode"] == 200
        assert body_of(response)["remaining"] == 75_000

    def test_a_team_member_can_report_an_incident(self, seeded) -> None:  # noqa: ANN001
        """The person who notices the problem is usually not the leader."""
        from services.api.incidents_handler import handler

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/incidents",
                groups=[ORG_ID, "TEAM_MEMBER"],
                user_id=TEAM_SUB,
                path_parameters={"eventId": EVENT_ID},
                body={
                    "title": "Spare microphone battery is flat",
                    "severity": "LOW",
                    "category": "TECHNICAL",
                    "team_id": "TEAM-tech",
                },
            ),
            None,
        )
        assert response["statusCode"] == 201

    def test_a_team_member_cannot_report_against_another_team(self, seeded) -> None:  # noqa: ANN001
        from services.api.incidents_handler import handler

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/incidents",
                groups=[ORG_ID, "TEAM_MEMBER"],
                user_id=TEAM_SUB,
                path_parameters={"eventId": EVENT_ID},
                body={"title": "Something", "team_id": "TEAM-venue"},
            ),
            None,
        )
        assert response["statusCode"] == 403

    def test_a_team_member_cannot_resolve_an_incident(self, seeded) -> None:  # noqa: ANN001
        from services.api.incidents_handler import handler

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/incidents/{incidentId}/resolve",
                groups=[ORG_ID, "TEAM_MEMBER"],
                user_id=TEAM_SUB,
                path_parameters={"eventId": EVENT_ID, "incidentId": "INC-001"},
                body={"resolution_summary": "Fixed it"},
            ),
            None,
        )
        assert response["statusCode"] == 403


class TestTaskScope:
    def test_a_team_member_sees_only_their_teams_work(self, seeded) -> None:  # noqa: ANN001
        from services.api.tasks_handler import handler

        response = handler(
            api_event(
                path="/events/{eventId}/tasks",
                groups=[ORG_ID, "TEAM_MEMBER"],
                user_id=TEAM_SUB,
                path_parameters={"eventId": EVENT_ID},
            ),
            None,
        )
        assert response["statusCode"] == 200
        tasks = body_of(response)["tasks"]
        assert tasks
        assert {t["team_id"] for t in tasks} == {"TEAM-tech"}

    def test_a_leader_sees_every_task(self, seeded) -> None:  # noqa: ANN001
        from services.api.tasks_handler import handler

        response = handler(
            api_event(path="/events/{eventId}/tasks", path_parameters={"eventId": EVENT_ID}),
            None,
        )
        body = body_of(response)
        assert body["count"] == 31
        assert body["overdue_count"] >= 2

    def test_overdue_is_a_derived_filter_not_a_stored_status(self, seeded) -> None:  # noqa: ANN001
        from services.api.tasks_handler import handler

        response = handler(
            api_event(
                path="/events/{eventId}/tasks",
                path_parameters={"eventId": EVENT_ID},
                query={"status": "OVERDUE"},
            ),
            None,
        )
        tasks = body_of(response)["tasks"]
        assert tasks
        assert all(t["is_overdue"] for t in tasks)
        # None of them store OVERDUE as their status.
        assert all(t["status"] != "OVERDUE" for t in tasks)

    def test_overdue_cannot_be_set_directly(self, seeded) -> None:  # noqa: ANN001
        from services.api.tasks_handler import handler

        response = handler(
            api_event(
                method="PUT",
                path="/events/{eventId}/teams/{teamId}/tasks/{taskId}",
                path_parameters={
                    "eventId": EVENT_ID,
                    "teamId": "TEAM-tech",
                    "taskId": "TSK-tc01",
                },
                body={"status": "OVERDUE"},
            ),
            None,
        )
        assert response["statusCode"] == 400
        assert "derived" in body_of(response)["message"]

    def test_blocking_requires_a_reason(self, seeded) -> None:  # noqa: ANN001
        """A blocked task with no stated blocker is work nobody can unblock."""
        from services.api.tasks_handler import handler

        response = handler(
            api_event(
                method="PUT",
                path="/events/{eventId}/teams/{teamId}/tasks/{taskId}",
                path_parameters={
                    "eventId": EVENT_ID,
                    "teamId": "TEAM-tech",
                    "taskId": "TSK-tc01",
                },
                body={"status": "BLOCKED"},
            ),
            None,
        )
        assert response["statusCode"] == 400

    def test_a_team_member_cannot_rewrite_the_scope_of_their_task(self, seeded) -> None:  # noqa: ANN001
        """They report progress; they do not move their own deadline."""
        from services.api.tasks_handler import handler

        response = handler(
            api_event(
                method="PUT",
                path="/events/{eventId}/teams/{teamId}/tasks/{taskId}",
                groups=[ORG_ID, "TEAM_MEMBER"],
                user_id=TEAM_SUB,
                path_parameters={
                    "eventId": EVENT_ID,
                    "teamId": "TEAM-tech",
                    "taskId": "TSK-tc01",
                },
                body={"due_date": "2030-01-01T00:00:00Z"},
            ),
            None,
        )
        assert response["statusCode"] == 403

    def test_a_team_member_can_progress_their_own_task(self, seeded) -> None:  # noqa: ANN001
        from services.api.tasks_handler import handler

        response = handler(
            api_event(
                method="PUT",
                path="/events/{eventId}/teams/{teamId}/tasks/{taskId}",
                groups=[ORG_ID, "TEAM_MEMBER"],
                user_id=TEAM_SUB,
                path_parameters={
                    "eventId": EVENT_ID,
                    "teamId": "TEAM-tech",
                    "taskId": "TSK-tc01",
                },
                body={"status": "IN_PROGRESS"},
            ),
            None,
        )
        assert response["statusCode"] == 200

    def test_a_team_member_cannot_edit_a_teammates_task(self, seeded) -> None:  # noqa: ANN001
        """Two people silently editing one task is how work gets lost."""
        from services.api.tasks_handler import handler

        response = handler(
            api_event(
                method="PUT",
                path="/events/{eventId}/teams/{teamId}/tasks/{taskId}",
                groups=[ORG_ID, "TEAM_MEMBER"],
                user_id=DEMO_SUB,
                path_parameters={
                    "eventId": EVENT_ID,
                    "teamId": "TEAM-tech",
                    # Assigned to TEAM_SUB, not DEMO_SUB.
                    "taskId": "TSK-tc01",
                },
                body={"status": "COMPLETED"},
            ),
            None,
        )
        assert response["statusCode"] == 403

    def test_completing_a_task_rewrites_both_index_keys(self, seeded, dynamodb) -> None:  # noqa: ANN001
        """A status in a sort key that is not rewritten makes the record invisible to a query."""
        from services.api.tasks_handler import handler
        from services.shared.keys import task_sk

        handler(
            api_event(
                method="PUT",
                path="/events/{eventId}/teams/{teamId}/tasks/{taskId}",
                path_parameters={
                    "eventId": EVENT_ID,
                    "teamId": "TEAM-tech",
                    "taskId": "TSK-tc01",
                },
                body={"status": "COMPLETED"},
            ),
            None,
        )
        item = dynamodb.Table(MAIN_TABLE).get_item(
            Key={"PK": ORG_ID, "SK": task_sk(EVENT_ID, "TEAM-tech", "TSK-tc01")}
        )["Item"]
        assert item["status"] == "COMPLETED"
        assert item["GSI1SK"].startswith("TASK#COMPLETED#")
        assert item["GSI2SK"].startswith("COMPLETED#")
        assert item["completed_at"]


class TestApprovalToBudget:
    """The headline demo workflow, verified arithmetically."""

    def test_approving_a_financial_request_commits_the_money(self, seeded) -> None:  # noqa: ANN001
        from services.api.approvals_handler import handler
        from services.shared import budget_service

        before = budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        assert before.remaining == 75_000

        response = handler(
            api_event(
                method="PUT",
                path="/events/{eventId}/approvals/{approvalId}",
                path_parameters={"eventId": EVENT_ID, "approvalId": "APR-001"},
                body={"decision": "APPROVED", "notes": "Approved for the demo"},
            ),
            None,
        )
        assert response["statusCode"] == 200
        body = body_of(response)
        assert body["budget"]["remaining"] == 62_500
        assert body["budget"]["committed"] == 57_500

        after = budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        assert after.remaining == 62_500

    def test_deciding_rewrites_the_index_key(self, seeded, dynamodb) -> None:  # noqa: ANN001
        """Without this, a query for pending approvals keeps returning it forever."""
        from services.api.approvals_handler import handler
        from services.shared.keys import approval_sk

        handler(
            api_event(
                method="PUT",
                path="/events/{eventId}/approvals/{approvalId}",
                path_parameters={"eventId": EVENT_ID, "approvalId": "APR-001"},
                body={"decision": "APPROVED"},
            ),
            None,
        )
        item = dynamodb.Table(MAIN_TABLE).get_item(
            Key={"PK": ORG_ID, "SK": approval_sk(EVENT_ID, "APR-001")}
        )["Item"]
        assert item["status"] == "APPROVED"
        assert item["GSI1SK"].startswith("APPROVAL#APPROVED#")

    def test_an_approval_cannot_be_decided_twice(self, seeded) -> None:  # noqa: ANN001
        """Otherwise a double-click commits the same money twice."""
        from services.api.approvals_handler import handler
        from services.shared import budget_service

        def decide():  # noqa: ANN202
            return handler(
                api_event(
                    method="PUT",
                    path="/events/{eventId}/approvals/{approvalId}",
                    path_parameters={"eventId": EVENT_ID, "approvalId": "APR-001"},
                    body={"decision": "APPROVED"},
                ),
                None,
            )

        assert decide()["statusCode"] == 200
        second = decide()
        assert second["statusCode"] == 409

        after = budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        assert after.remaining == 62_500

    def test_declining_does_not_move_money(self, seeded) -> None:  # noqa: ANN001
        from services.api.approvals_handler import handler
        from services.shared import budget_service

        handler(
            api_event(
                method="PUT",
                path="/events/{eventId}/approvals/{approvalId}",
                path_parameters={"eventId": EVENT_ID, "approvalId": "APR-001"},
                body={"decision": "DECLINED", "notes": "Not this time"},
            ),
            None,
        )
        after = budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        assert after.remaining == 75_000

    def test_an_unaffordable_approval_leaves_the_request_pending(self, seeded, dynamodb) -> None:  # noqa: ANN001
        """A refused budget write must not leave an approval marked APPROVED with no money moved."""
        from services.api.approvals_handler import handler
        from services.shared import budget_service
        from services.shared.keys import approval_sk

        table = dynamodb.Table(MAIN_TABLE)
        table.update_item(
            Key={"PK": ORG_ID, "SK": approval_sk(EVENT_ID, "APR-001")},
            UpdateExpression="SET amount_inr = :a",
            ExpressionAttributeValues={":a": 500_000},
        )

        response = handler(
            api_event(
                method="PUT",
                path="/events/{eventId}/approvals/{approvalId}",
                path_parameters={"eventId": EVENT_ID, "approvalId": "APR-001"},
                body={"decision": "APPROVED"},
            ),
            None,
        )
        assert response["statusCode"] == 409
        assert "not applied" in body_of(response)["message"]

        item = table.get_item(Key={"PK": ORG_ID, "SK": approval_sk(EVENT_ID, "APR-001")})["Item"]
        assert item["status"] == "PENDING"
        after = budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        assert after.remaining == 75_000

    def test_health_is_refreshed_after_a_decision(self, seeded, dynamodb) -> None:  # noqa: ANN001
        from services.api.approvals_handler import handler
        from services.shared.keys import event_sk

        handler(
            api_event(
                method="PUT",
                path="/events/{eventId}/approvals/{approvalId}",
                path_parameters={"eventId": EVENT_ID, "approvalId": "APR-001"},
                body={"decision": "APPROVED"},
            ),
            None,
        )
        event_record = dynamodb.Table(MAIN_TABLE).get_item(
            Key={"PK": ORG_ID, "SK": event_sk(EVENT_ID)}
        )["Item"]
        assert event_record["health_computed_at"]
        assert event_record["health_band"] in ("GREEN", "YELLOW", "ORANGE", "RED")


class TestNeverAutonomous:
    def test_a_never_tier_action_cannot_be_approved(self, seeded, dynamodb) -> None:  # noqa: ANN001
        """An approval must not create the impression that an automated path exists."""
        from services.api.approvals_handler import handler
        from services.shared.keys import approval_sk

        dynamodb.Table(MAIN_TABLE).update_item(
            Key={"PK": ORG_ID, "SK": approval_sk(EVENT_ID, "APR-004")},
            UpdateExpression="SET requested_action = :a",
            ExpressionAttributeValues={":a": "ContractSigning"},
        )
        response = handler(
            api_event(
                method="PUT",
                path="/events/{eventId}/approvals/{approvalId}",
                path_parameters={"eventId": EVENT_ID, "approvalId": "APR-004"},
                body={"decision": "APPROVED"},
            ),
            None,
        )
        assert response["statusCode"] == 403
        assert "never" in body_of(response)["message"].lower()


class TestIncidentDiscussion:
    def test_a_comment_increments_the_count_atomically(self, seeded, dynamodb) -> None:  # noqa: ANN001
        from services.api.incidents_handler import handler
        from services.shared.keys import incident_sk

        table = dynamodb.Table(MAIN_TABLE)
        before = table.get_item(Key={"PK": ORG_ID, "SK": incident_sk(EVENT_ID, "INC-001")})["Item"][
            "comment_count"
        ]

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/incidents/{incidentId}/comments",
                path_parameters={"eventId": EVENT_ID, "incidentId": "INC-001"},
                body={"body": "Backup tested and working."},
            ),
            None,
        )
        assert response["statusCode"] == 201
        after = table.get_item(Key={"PK": ORG_ID, "SK": incident_sk(EVENT_ID, "INC-001")})["Item"][
            "comment_count"
        ]
        assert int(after) == int(before) + 1

    def test_a_task_created_from_a_comment_links_back_to_it(self, seeded) -> None:  # noqa: ANN001
        """The reasoning that produced the work stays reachable from the work."""
        from services.api.incidents_handler import handler
        from services.api.tasks_handler import handler as tasks_handler

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/incidents/{incidentId}/comments",
                path_parameters={"eventId": EVENT_ID, "incidentId": "INC-001"},
                body={
                    "body": "Technical must test the backup before 5pm.",
                    "create_task": True,
                    "task_team_id": "TEAM-tech",
                    "task_title": "Test the backup projector before 5pm",
                    "task_priority": "CRITICAL",
                },
            ),
            None,
        )
        body = body_of(response)
        task_id = body["created_task_id"]
        comment_id = body["comment_id"]
        assert task_id

        listing = tasks_handler(
            api_event(
                path="/events/{eventId}/teams/{teamId}/tasks",
                path_parameters={"eventId": EVENT_ID, "teamId": "TEAM-tech"},
            ),
            None,
        )
        created = next(t for t in body_of(listing)["tasks"] if t["task_id"] == task_id)
        assert created["source_comment_id"] == comment_id
        assert created["source_incident_id"] == "INC-001"

    def test_resolving_requires_a_summary(self, seeded) -> None:  # noqa: ANN001
        """An incident closed with no explanation teaches nobody anything."""
        from services.api.incidents_handler import handler

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/incidents/{incidentId}/resolve",
                path_parameters={"eventId": EVENT_ID, "incidentId": "INC-001"},
                body={},
            ),
            None,
        )
        assert response["statusCode"] == 400

    def test_resolving_rewrites_the_index_key_and_improves_health(self, seeded) -> None:  # noqa: ANN001
        from services.api.incidents_handler import handler

        before = compute_health(load_event_snapshot(ORG_ID, EVENT_ID, table_name=MAIN_TABLE))
        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/incidents/{incidentId}/resolve",
                path_parameters={"eventId": EVENT_ID, "incidentId": "INC-001"},
                body={
                    "resolution_summary": "Backup projector tested and working.",
                    "root_cause": "Lamp failure with no pre-event backup check.",
                    "actions_taken": ["Tested the backup", "Added a checklist item"],
                },
            ),
            None,
        )
        assert response["statusCode"] == 200
        after = compute_health(load_event_snapshot(ORG_ID, EVENT_ID, table_name=MAIN_TABLE))
        assert after.score < before.score

    def test_an_already_resolved_incident_cannot_be_resolved_again(self, seeded) -> None:  # noqa: ANN001
        from services.api.incidents_handler import handler

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/incidents/{incidentId}/resolve",
                path_parameters={"eventId": EVENT_ID, "incidentId": "INC-002"},
                body={"resolution_summary": "Again"},
            ),
            None,
        )
        assert response["statusCode"] == 409


class TestEventLifecycle:
    def test_an_illegal_transition_is_refused_with_the_legal_ones(self, seeded) -> None:  # noqa: ANN001
        from services.api.events_handler import handler

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/lifecycle",
                path_parameters={"eventId": EVENT_ID},
                body={"status": "DRAFT"},
            ),
            None,
        )
        assert response["statusCode"] == 409
        assert "cannot move from ACTIVE" in body_of(response)["message"]

    def test_a_legal_transition_rewrites_the_index_key(self, seeded, dynamodb) -> None:  # noqa: ANN001
        from services.api.events_handler import handler
        from services.shared.keys import event_sk

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/lifecycle",
                path_parameters={"eventId": EVENT_ID},
                body={"status": "PAUSED"},
            ),
            None,
        )
        assert response["statusCode"] == 200
        item = dynamodb.Table(MAIN_TABLE).get_item(Key={"PK": ORG_ID, "SK": event_sk(EVENT_ID)})[
            "Item"
        ]
        assert item["status"] == "PAUSED"
        assert item["GSI1SK"].startswith("STATUS#PAUSED#")
        assert item["paused_at"]

    def test_a_running_event_cannot_be_archived(self, seeded) -> None:  # noqa: ANN001
        """Archiving a live event hides work that is still somebody's problem."""
        from services.api.events_handler import handler

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/archive",
                path_parameters={"eventId": EVENT_ID},
            ),
            None,
        )
        assert response["statusCode"] == 409

    def test_status_cannot_be_changed_through_the_update_route(self, seeded) -> None:  # noqa: ANN001
        """Otherwise the transition validation is trivially bypassed."""
        from services.api.events_handler import handler

        response = handler(
            api_event(
                method="PUT",
                path="/events/{eventId}",
                path_parameters={"eventId": EVENT_ID},
                body={"status": "COMPLETED"},
            ),
            None,
        )
        assert response["statusCode"] == 400
        assert "lifecycle" in body_of(response)["message"]

    def test_duplicating_copies_structure_but_not_history(self, seeded) -> None:  # noqa: ANN001
        from services.api.events_handler import handler

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/duplicate",
                path_parameters={"eventId": EVENT_ID},
                body={"name": "AWS Community Day Maharashtra 2027"},
            ),
            None,
        )
        assert response["statusCode"] == 201
        body = body_of(response)
        assert body["teams_copied"] == 8
        assert body["tasks_copied"] == 31

        new_event_id = body["event_id"]
        snapshot = load_event_snapshot(ORG_ID, new_event_id, table_name=MAIN_TABLE)
        assert snapshot.event["status"] == "DRAFT"
        # No incidents, approvals or registrations came along.
        assert snapshot.incidents == []
        assert snapshot.approvals == []
        assert snapshot.attendees.total_registered == 0
        # Copied tasks start clean rather than importing last year's deadlines.
        assert all(not t.get("due_date") for t in snapshot.tasks)
        assert all(t["status"] == "BACKLOG" for t in snapshot.tasks)
        assert not snapshot.overdue_tasks


class TestPlanGeneration:
    def test_preparing_an_event_creates_teams_and_dated_tasks(self, seeded) -> None:  # noqa: ANN001
        from services.api.events_handler import handler

        created = handler(
            api_event(
                method="POST",
                path="/events",
                body={
                    "name": "Pune Cloud Meetup",
                    "start_date": "2027-03-01T09:00:00+00:00",
                    "total_budget": 50_000,
                },
            ),
            None,
        )
        new_event_id = body_of(created)["event_id"]

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/prepare",
                path_parameters={"eventId": new_event_id},
            ),
            None,
        )
        assert response["statusCode"] == 201
        body = body_of(response)
        assert len(body["teams_created"]) == 8
        assert body["tasks_created"] > 20
        # Approvals the plan will need are listed, not raised.
        assert body["anticipated_approvals"]
        snapshot = load_event_snapshot(ORG_ID, new_event_id, table_name=MAIN_TABLE)
        assert snapshot.pending_approvals == []

    def test_preparing_twice_does_not_duplicate_the_checklist(self, seeded) -> None:  # noqa: ANN001
        from services.api.events_handler import handler

        created = handler(
            api_event(
                method="POST",
                path="/events",
                body={"name": "Idempotent Meetup", "start_date": "2027-04-01T09:00:00+00:00"},
            ),
            None,
        )
        new_event_id = body_of(created)["event_id"]

        def prepare():  # noqa: ANN202
            return body_of(
                handler(
                    api_event(
                        method="POST",
                        path="/events/{eventId}/prepare",
                        path_parameters={"eventId": new_event_id},
                    ),
                    None,
                )
            )

        first = prepare()
        second = prepare()
        assert first["tasks_created"] > 0
        assert second["tasks_created"] == 0
        assert second["teams_created"] == []

    def test_plan_deadlines_are_never_already_overdue(self, seeded) -> None:  # noqa: ANN001
        """An event starting tomorrow must not be planned with three-week lead times in the past."""
        from datetime import timedelta

        from services.api.events_handler import handler
        from services.shared.models.base import utc_now

        created = handler(
            api_event(
                method="POST",
                path="/events",
                body={
                    "name": "Tomorrow Meetup",
                    "start_date": (utc_now() + timedelta(days=1)).isoformat(),
                },
            ),
            None,
        )
        new_event_id = body_of(created)["event_id"]
        handler(
            api_event(
                method="POST",
                path="/events/{eventId}/prepare",
                path_parameters={"eventId": new_event_id},
            ),
            None,
        )
        snapshot = load_event_snapshot(ORG_ID, new_event_id, table_name=MAIN_TABLE)
        assert snapshot.tasks
        assert snapshot.overdue_tasks == []


class TestTeamMembership:
    def test_adding_a_member_increments_the_count_atomically(self, seeded, dynamodb) -> None:  # noqa: ANN001
        from services.api.teams_handler import handler
        from services.shared.keys import team_sk

        table = dynamodb.Table(MAIN_TABLE)
        before = int(
            table.get_item(Key={"PK": ORG_ID, "SK": team_sk(EVENT_ID, "TEAM-venue")})["Item"][
                "member_count"
            ]
        )
        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/teams/{teamId}/members",
                path_parameters={"eventId": EVENT_ID, "teamId": "TEAM-venue"},
                body={"user_id": "member-new", "display_name": "New Person"},
            ),
            None,
        )
        assert response["statusCode"] == 201
        after = int(
            table.get_item(Key={"PK": ORG_ID, "SK": team_sk(EVENT_ID, "TEAM-venue")})["Item"][
                "member_count"
            ]
        )
        assert after == before + 1

    def test_removing_a_member_deactivates_and_surfaces_their_open_work(self, seeded) -> None:  # noqa: ANN001
        """Deleting the record would leave tasks attributed to somebody unnameable."""
        from services.api.teams_handler import handler

        response = handler(
            api_event(
                method="DELETE",
                path="/events/{eventId}/teams/{teamId}/members/{userId}",
                path_parameters={
                    "eventId": EVENT_ID,
                    "teamId": "TEAM-tech",
                    "userId": TEAM_SUB,
                },
            ),
            None,
        )
        assert response["statusCode"] == 200
        body = body_of(response)
        assert body["tasks_needing_reassignment"]

    def test_a_deactivated_membership_no_longer_confers_scope(self, seeded) -> None:  # noqa: ANN001
        """Scope comes from DynamoDB precisely so removal takes effect immediately."""
        from services.api.teams_handler import handler as teams_handler
        from services.shared.principal import resolve_principal

        teams_handler(
            api_event(
                method="DELETE",
                path="/events/{eventId}/teams/{teamId}/members/{userId}",
                path_parameters={
                    "eventId": EVENT_ID,
                    "teamId": "TEAM-tech",
                    "userId": TEAM_SUB,
                },
            ),
            None,
        )
        principal = resolve_principal(
            api_event(groups=[ORG_ID, "TEAM_MEMBER"], user_id=TEAM_SUB),
            ORG_ID,
            table_name=MAIN_TABLE,
        )
        assert "TEAM-tech" not in principal.team_ids


class TestPrincipalResolution:
    def test_team_scope_is_loaded_from_membership_records(self, seeded) -> None:  # noqa: ANN001
        from services.shared.principal import Role, resolve_principal

        principal = resolve_principal(
            api_event(groups=[ORG_ID, "TEAM_MEMBER"], user_id=TEAM_SUB),
            ORG_ID,
            table_name=MAIN_TABLE,
        )
        assert principal.role is Role.TEAM_MEMBER
        assert principal.team_ids == frozenset({"TEAM-tech"})
        assert principal.event_ids == frozenset({EVENT_ID})

    def test_a_leader_needs_no_scope_lookup(self, seeded) -> None:  # noqa: ANN001
        from services.shared.principal import Role, resolve_principal

        principal = resolve_principal(
            api_event(groups=[ORG_ID, "LEADER"], user_id=LEADER_SUB),
            ORG_ID,
            table_name=MAIN_TABLE,
        )
        assert principal.role is Role.LEADER
        assert principal.may_see_event("EVT-anything")
        assert principal.may_see_team("TEAM-anything")

    def test_leader_wins_when_both_role_groups_are_present(self, seeded) -> None:  # noqa: ANN001
        """A leader who is also on a team keeps organization-wide authority."""
        from services.shared.principal import Role, resolve_principal

        principal = resolve_principal(
            api_event(groups=[ORG_ID, "TEAM_MEMBER", "LEADER"], user_id=LEADER_SUB),
            ORG_ID,
            table_name=MAIN_TABLE,
        )
        assert principal.role is Role.LEADER

    def test_an_unknown_role_group_resolves_to_the_least_privilege(self, seeded) -> None:  # noqa: ANN001
        from services.shared.principal import Role, resolve_principal

        principal = resolve_principal(
            api_event(groups=[ORG_ID, "SUPERADMIN"], user_id="someone"),
            ORG_ID,
            table_name=MAIN_TABLE,
        )
        assert principal.role is Role.TEAM_MEMBER


class TestOperationsViews:
    def test_the_brief_is_assembled_from_state(self, seeded) -> None:  # noqa: ANN001
        from services.api.operations_handler import handler

        response = handler(
            api_event(path="/events/{eventId}/brief", path_parameters={"eventId": EVENT_ID}),
            None,
        )
        assert response["statusCode"] == 200
        brief = body_of(response)
        assert brief["health_band"] == "ORANGE"
        assert brief["decisions_required"] == 5
        assert brief["budget"]["remaining_inr"] == 75_000
        assert brief["budget"]["remaining_formatted"] == "75,000"
        assert brief["speakers"]["unresponsive"] == 1
        assert brief["recommended_priority"]

    def test_the_agent_tool_and_the_endpoint_return_the_same_brief(self, seeded, leader) -> None:  # noqa: ANN001
        """Two implementations of the brief would eventually disagree."""
        from services.api.operations_handler import handler
        from tools.community_ops import registry
        from tools.registry import ToolContext

        endpoint = body_of(
            handler(
                api_event(
                    path="/events/{eventId}/brief",
                    path_parameters={"eventId": EVENT_ID},
                ),
                None,
            )
        )
        tool = registry.invoke(
            "generate_event_brief",
            {"event_id": EVENT_ID},
            ToolContext(
                principal=leader,
                organization_id=ORG_ID,
                table_name=MAIN_TABLE,
                default_event_id=EVENT_ID,
            ),
        )
        for field in (
            "health_band",
            "decisions_required",
            "overdue_tasks",
            "open_incidents",
        ):
            assert endpoint[field] == tool[field], field
        assert endpoint["budget"]["remaining_inr"] == tool["budget"]["remaining_inr"]

    def test_the_attention_list_is_ordered_and_navigable(self, seeded) -> None:  # noqa: ANN001
        from services.api.operations_handler import handler

        response = handler(
            api_event(path="/events/{eventId}/attention", path_parameters={"eventId": EVENT_ID}),
            None,
        )
        items = body_of(response)["attention_items"]
        assert items
        rank = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
        assert [rank[i["severity"]] for i in items] == sorted(rank[i["severity"]] for i in items)

    def test_the_command_centre_aggregates_the_organization(self, seeded) -> None:  # noqa: ANN001
        from services.api.operations_handler import handler

        response = handler(api_event(path="/command-center"), None)
        body = body_of(response)
        assert body["role"] == "LEADER"
        assert body["summary"]["active_events"] >= 1
        assert body["summary"]["pending_approvals"] == 5
        assert body["summary"]["budget_remaining_inr"] == 75_000
        assert body["events"]
        assert body["attention_items"]

    def test_a_team_member_sees_only_their_events_in_the_command_centre(self, seeded) -> None:  # noqa: ANN001
        from services.api.operations_handler import handler

        response = handler(
            api_event(
                path="/command-center",
                groups=[ORG_ID, "TEAM_MEMBER"],
                user_id=TEAM_SUB,
            ),
            None,
        )
        body = body_of(response)
        assert {e["event_id"] for e in body["events"]} <= {EVENT_ID}

    def test_workload_identifies_the_busiest_and_most_available(self, seeded) -> None:  # noqa: ANN001
        from services.api.operations_handler import handler

        response = handler(
            api_event(path="/events/{eventId}/workload", path_parameters={"eventId": EVENT_ID}),
            None,
        )
        body = body_of(response)
        assert body["teams"]
        assert body["busiest_member"]
        assert body["most_available_member"]
        assert int(body["busiest_member"]["open_tasks"]) >= int(
            body["most_available_member"]["open_tasks"]
        )

    def test_health_is_cached_back_onto_the_event(self, seeded, dynamodb) -> None:  # noqa: ANN001
        from services.api.operations_handler import handler
        from services.shared.keys import event_sk

        handler(
            api_event(path="/events/{eventId}/health", path_parameters={"eventId": EVENT_ID}),
            None,
        )
        item = dynamodb.Table(MAIN_TABLE).get_item(Key={"PK": ORG_ID, "SK": event_sk(EVENT_ID)})[
            "Item"
        ]
        assert item["health_band"] == "ORANGE"
        assert item["health_reasons"]


class TestNotifications:
    def test_a_user_sees_only_their_own_inbox(self, seeded) -> None:  # noqa: ANN001
        from services.api.notifications_handler import handler

        leader_inbox = body_of(handler(api_event(path="/notifications", user_id=LEADER_SUB), None))
        member_inbox = body_of(
            handler(
                api_event(
                    path="/notifications",
                    groups=[ORG_ID, "TEAM_MEMBER"],
                    user_id=TEAM_SUB,
                ),
                None,
            )
        )
        assert {n["user_id"] for n in leader_inbox["notifications"]} == {LEADER_SUB}
        assert {n["user_id"] for n in member_inbox["notifications"]} == {TEAM_SUB}

    def test_marking_read_is_confined_to_the_caller(self, seeded) -> None:  # noqa: ANN001
        """The sort key is derived from the caller, so another inbox is unreachable."""
        from services.api.notifications_handler import handler

        response = handler(
            api_event(
                method="PUT",
                path="/notifications/{notificationId}/read",
                groups=[ORG_ID, "TEAM_MEMBER"],
                user_id=TEAM_SUB,
                # NTF-001 belongs to the leader.
                path_parameters={"notificationId": "NTF-001"},
            ),
            None,
        )
        assert response["statusCode"] == 404

    def test_marking_own_notification_read_works(self, seeded) -> None:  # noqa: ANN001
        from services.api.notifications_handler import handler

        response = handler(
            api_event(
                method="PUT",
                path="/notifications/{notificationId}/read",
                user_id=LEADER_SUB,
                path_parameters={"notificationId": "NTF-001"},
            ),
            None,
        )
        assert response["statusCode"] == 200


class TestTicketAdmin:
    def test_transaction_verification_is_deterministic(self, seeded) -> None:  # noqa: ANN001
        from services.api.tickets_handler import handler

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/tickets/{registrationId}/verify-transaction",
                path_parameters={
                    "eventId": EVENT_ID,
                    "registrationId": "REG-2026-004801",
                },
            ),
            None,
        )
        assert response["statusCode"] == 200
        body = body_of(response)
        assert body["verified"] is True
        # Named checks rather than a bare verdict, so a failure is actionable.
        assert {c["name"] for c in body["checks"]} >= {
            "registration_exists",
            "registration_confirmed",
            "payment_status",
        }

    def test_a_cancelled_registration_fails_verification(self, seeded) -> None:  # noqa: ANN001
        from services.api.tickets_handler import handler

        body = body_of(
            handler(
                api_event(
                    method="POST",
                    path="/events/{eventId}/tickets/{registrationId}/verify-transaction",
                    path_parameters={
                        "eventId": EVENT_ID,
                        # Neha Gupta is CANCELLED and REFUNDED in the demo dataset.
                        "registrationId": "REG-2026-004805",
                    },
                ),
                None,
            )
        )
        assert body["verified"] is False
        assert body["can_issue_ticket"] is False

    def test_a_ticket_cannot_be_issued_on_a_pending_payment(self, seeded) -> None:  # noqa: ANN001
        from services.api.tickets_handler import handler

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/tickets/{registrationId}/issue",
                path_parameters={
                    "eventId": EVENT_ID,
                    # Tushar Jain's payment is PENDING.
                    "registrationId": "REG-2026-004812",
                },
            ),
            None,
        )
        assert response["statusCode"] == 409

    def test_revoking_requires_a_reason_and_keeps_the_record(self, seeded, dynamodb) -> None:  # noqa: ANN001
        from services.api.tickets_handler import handler
        from services.shared.keys import ticket_sk

        without_reason = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/tickets/{registrationId}/revoke",
                path_parameters={
                    "eventId": EVENT_ID,
                    "registrationId": "REG-2026-004801",
                },
                body={},
            ),
            None,
        )
        assert without_reason["statusCode"] == 400

        with_reason = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/tickets/{registrationId}/revoke",
                path_parameters={
                    "eventId": EVENT_ID,
                    "registrationId": "REG-2026-004801",
                },
                body={"reason": "Duplicate registration"},
            ),
            None,
        )
        assert with_reason["statusCode"] == 200
        # The record survives so QR verification can reject it rather than fail to recognise it.
        item = dynamodb.Table(MAIN_TABLE).get_item(
            Key={"PK": ORG_ID, "SK": ticket_sk(EVENT_ID, "REG-2026-004801")}
        )["Item"]
        assert item["status"] == "REVOKED"
        assert item["revocation_reason"]

    def test_masked_contact_details_in_the_list_view(self, seeded) -> None:  # noqa: ANN001
        from services.api.tickets_handler import handler

        body = body_of(
            handler(
                api_event(
                    path="/events/{eventId}/tickets",
                    path_parameters={"eventId": EVENT_ID},
                ),
                None,
            )
        )
        assert body["tickets"]
        assert all("*" in t["attendee_email"] for t in body["tickets"])


class TestSimulation:
    def test_it_advances_one_step_at_a_time_and_reports_the_delta(self, seeded) -> None:  # noqa: ANN001
        from services.api.simulation_handler import handler

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/simulation",
                path_parameters={"eventId": EVENT_ID},
            ),
            None,
        )
        assert response["statusCode"] == 200
        body = body_of(response)
        assert body["step"] == 1
        assert body["health_before"]["health_band"]
        assert body["health_after"]["health_band"]
        assert "score_delta" in body

    def test_the_first_step_clears_the_silent_speaker_signal(self, seeded) -> None:  # noqa: ANN001
        from services.api.simulation_handler import handler

        before = compute_health(load_event_snapshot(ORG_ID, EVENT_ID, table_name=MAIN_TABLE))
        assert any(r.signal == "silent_speakers" for r in before.reasons)

        handler(
            api_event(
                method="POST",
                path="/events/{eventId}/simulation",
                path_parameters={"eventId": EVENT_ID},
            ),
            None,
        )
        after = compute_health(load_event_snapshot(ORG_ID, EVENT_ID, table_name=MAIN_TABLE))
        assert not any(r.signal == "silent_speakers" for r in after.reasons)
        assert after.score < before.score

    def test_a_team_member_cannot_run_the_simulation(self, seeded) -> None:  # noqa: ANN001
        from services.api.simulation_handler import handler

        response = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/simulation",
                groups=[ORG_ID, "TEAM_MEMBER"],
                user_id=TEAM_SUB,
                path_parameters={"eventId": EVENT_ID},
            ),
            None,
        )
        assert response["statusCode"] == 403

    def test_the_whole_sequence_runs_and_demonstrates_the_loop(self, seeded) -> None:  # noqa: ANN001
        """The loop the product claims, verified end to end against real records.

        The shape that matters is problem-appears-then-recovers, not "ends better than it
        started". The run legitimately leaves the event slightly different: a deadline passed in
        step 2 and money was committed in step 7, and both are real changes that should still be
        reflected. What must hold is that reporting the incident made health worse and resolving
        it made health better, because that is the claim — the score tracks state.
        """
        from services.api.simulation_handler import TOTAL_STEPS, handler

        scores: list[int] = []
        for step in range(1, TOTAL_STEPS + 1):
            response = handler(
                api_event(
                    method="POST",
                    path="/events/{eventId}/simulation",
                    path_parameters={"eventId": EVENT_ID},
                ),
                None,
            )
            assert response["statusCode"] == 200, body_of(response)
            body = body_of(response)
            assert body["step"] == step
            scores.append(int(body["health_after"]["health_score"]))

        finished = handler(
            api_event(
                method="POST",
                path="/events/{eventId}/simulation",
                path_parameters={"eventId": EVENT_ID},
            ),
            None,
        )
        assert body_of(finished)["finished"] is True

        # Step 3 reports the incident; step 8 resolves it.
        after_incident = scores[2]
        before_incident = scores[1]
        after_resolution = scores[7]

        assert after_incident > before_incident, scores
        assert after_resolution < after_incident, scores

    def test_the_run_resolves_its_own_incident_not_the_seeded_one(self, seeded) -> None:  # noqa: ANN001
        """The demo event already has an open HIGH incident of its own.

        A step that acted on "the first open high-severity incident" would analyse one and resolve
        another, leaving an incoherent narrative and an incident nobody closed.
        """
        from services.api.simulation_handler import handler

        for _ in range(8):
            response = handler(
                api_event(
                    method="POST",
                    path="/events/{eventId}/simulation",
                    path_parameters={"eventId": EVENT_ID},
                ),
                None,
            )
            assert response["statusCode"] == 200, body_of(response)

        snapshot = load_event_snapshot(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        by_id = {str(i["incident_id"]): i for i in snapshot.incidents}
        # The seeded incident is untouched; the one the run created is resolved.
        assert by_id["INC-001"]["status"] == "RECOMMENDATION_READY"
        created = [
            i
            for i in snapshot.incidents
            if str(i["incident_id"]) not in {"INC-001", "INC-002", "INC-003"}
        ]
        assert len(created) == 1
        assert created[0]["status"] == "RESOLVED"
        assert created[0]["root_cause"]

    def test_the_approval_step_commits_money_deterministically(self, seeded) -> None:  # noqa: ANN001
        from services.api.simulation_handler import handler
        from services.shared import budget_service

        # Advance to the approve-and-commit step.
        for _ in range(7):
            response = handler(
                api_event(
                    method="POST",
                    path="/events/{eventId}/simulation",
                    path_parameters={"eventId": EVENT_ID},
                ),
                None,
            )
            assert response["statusCode"] == 200, body_of(response)

        body = body_of(response)
        assert body["step"] == 7
        changed = body["result"]["changed"]
        after = budget_service.get_budget(ORG_ID, EVENT_ID, table_name=MAIN_TABLE)
        assert changed["remaining_after_inr"] == after.remaining
        assert changed["remaining_after_inr"] < changed["remaining_before_inr"]
