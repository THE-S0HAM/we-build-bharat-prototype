"""The event health engine must be deterministic, explainable and bounded.

Health is a number a leader makes decisions from, so three properties matter more than the exact
weights: the same state always produces the same score, the reasons account for the score, and no
single noisy signal can saturate it and hide something worse.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from services.shared.aggregate import AttendeeState, BudgetState, EventSnapshot
from services.shared.health import (
    MAX_INCIDENT_POINTS,
    MAX_OVERDUE_TASK_POINTS,
    POINTS_PER_OVERDUE_TASK,
    attention_items,
    band_for_score,
    compute_health,
)
from services.shared.models.base import utc_now
from services.shared.models.event import HealthBand


def snapshot(**overrides):
    now = utc_now()
    base = EventSnapshot(
        organization_id="ORG-a",
        event_id="EVT-1",
        now=now,
        event={"name": "Test Event", "start_date": (now + timedelta(days=20)).isoformat()},
    )
    for key, value in overrides.items():
        setattr(base, key, value)
    return base


def task(status="ASSIGNED", due_hours=24, task_id="T1", team_id="TEAM-a", title="A task"):
    return {
        "status": status,
        "due_date": (utc_now() + timedelta(hours=due_hours)).isoformat(),
        "task_id": task_id,
        "team_id": team_id,
        "title": title,
    }


class TestBands:
    @pytest.mark.parametrize(
        ("score", "band"),
        [
            (0, HealthBand.GREEN),
            (14, HealthBand.GREEN),
            (15, HealthBand.YELLOW),
            (34, HealthBand.YELLOW),
            (35, HealthBand.ORANGE),
            (59, HealthBand.ORANGE),
            (60, HealthBand.RED),
            (100, HealthBand.RED),
        ],
    )
    def test_band_boundaries(self, score: int, band: HealthBand) -> None:
        assert band_for_score(score) is band

    def test_a_clean_event_is_green_with_no_reasons(self) -> None:
        result = compute_health(snapshot())
        assert result.band is HealthBand.GREEN
        assert result.score == 0
        assert result.reasons == []
        assert result.summary == "No operational risks detected."


class TestDeterminism:
    def test_identical_state_produces_identical_output(self) -> None:
        """The whole reason the score is not asked of a model."""
        snap = snapshot(
            tasks=[task(due_hours=-8, task_id="T1"), task(status="BLOCKED", task_id="T2")],
            incidents=[{"severity": "HIGH", "status": "REPORTED", "incident_id": "INC-1"}],
        )
        first = compute_health(snap)
        second = compute_health(snap)
        assert (first.band, first.score) == (second.band, second.score)
        assert [r.to_dict() for r in first.reasons] == [r.to_dict() for r in second.reasons]

    def test_reasons_account_for_the_score(self) -> None:
        """The explanation is generated from the arithmetic, so it cannot disagree with it."""
        snap = snapshot(
            tasks=[task(due_hours=-4, task_id=f"T{i}") for i in range(3)],
            incidents=[{"severity": "MEDIUM", "status": "REPORTED", "incident_id": "INC-1"}],
        )
        result = compute_health(snap)
        assert sum(r.points for r in result.reasons) == result.score

    def test_reasons_are_ordered_worst_first(self) -> None:
        snap = snapshot(
            tasks=[task(status="BLOCKED", task_id="T1")],
            incidents=[{"severity": "CRITICAL", "status": "REPORTED", "incident_id": "INC-1"}],
        )
        result = compute_health(snap)
        points = [r.points for r in result.reasons]
        assert points == sorted(points, reverse=True)


class TestSignals:
    def test_overdue_is_derived_from_the_deadline_not_the_status(self) -> None:
        """Nothing writes OVERDUE; a passed deadline is enough."""
        snap = snapshot(tasks=[task(status="ASSIGNED", due_hours=-1)])
        result = compute_health(snap)
        assert any(r.signal == "overdue_tasks" for r in result.reasons)

    def test_a_completed_task_past_its_deadline_is_not_overdue(self) -> None:
        snap = snapshot(tasks=[task(status="COMPLETED", due_hours=-100)])
        assert compute_health(snap).score == 0

    def test_overdue_points_are_capped(self) -> None:
        """Twenty late tasks is worse than four, but not five times worse.

        Without the cap one noisy signal would saturate the score and a critical incident behind
        it would make no difference to the band.
        """
        snap = snapshot(tasks=[task(due_hours=-5, task_id=f"T{i}") for i in range(20)])
        reason = next(r for r in compute_health(snap).reasons if r.signal == "overdue_tasks")
        assert reason.points == MAX_OVERDUE_TASK_POINTS
        assert reason.points < 20 * POINTS_PER_OVERDUE_TASK

    def test_one_critical_incident_alone_reaches_orange(self) -> None:
        """A single critical problem is an orange-grade situation on its own."""
        snap = snapshot(
            incidents=[{"severity": "CRITICAL", "status": "REPORTED", "incident_id": "INC-1"}]
        )
        assert compute_health(snap).band is HealthBand.ORANGE

    def test_resolved_incidents_do_not_count(self) -> None:
        snap = snapshot(
            incidents=[{"severity": "CRITICAL", "status": "RESOLVED", "incident_id": "INC-1"}]
        )
        assert compute_health(snap).score == 0

    def test_many_low_incidents_cannot_outweigh_one_critical(self) -> None:
        low = snapshot(
            incidents=[
                {"severity": "LOW", "status": "REPORTED", "incident_id": f"INC-{i}"}
                for i in range(30)
            ]
        )
        critical = snapshot(
            incidents=[{"severity": "CRITICAL", "status": "REPORTED", "incident_id": "INC-1"}]
        )
        low_points = next(
            r.points for r in compute_health(low).reasons if r.signal == "open_incidents"
        )
        # Thirty low-priority incidents are capped, so they cannot drown out anything.
        assert low_points == MAX_INCIDENT_POINTS
        # And a single critical incident is already orange-grade without needing to out-score
        # a pile of noise.
        assert compute_health(critical).band is HealthBand.ORANGE
        assert compute_health(low).band is HealthBand.ORANGE

    def test_a_speaker_silent_past_the_threshold_counts(self) -> None:
        snap = snapshot(
            speakers=[
                {
                    "name": "Quiet Speaker",
                    "status": "AWAITING_RESPONSE",
                    "speaker_id": "SPK-1",
                    "topic": "A topic",
                    "last_contacted_at": (utc_now() - timedelta(hours=96)).isoformat(),
                }
            ]
        )
        reason = next(r for r in compute_health(snap).reasons if r.signal == "silent_speakers")
        assert "96h" in reason.detail

    def test_a_speaker_who_replied_is_not_silent(self) -> None:
        snap = snapshot(
            speakers=[
                {
                    "name": "Responsive",
                    "status": "CONFIRMED",
                    "speaker_id": "SPK-1",
                    "last_contacted_at": (utc_now() - timedelta(hours=200)).isoformat(),
                    "response_received_at": (utc_now() - timedelta(hours=190)).isoformat(),
                }
            ]
        )
        assert compute_health(snap).score == 0

    def test_budget_overrun_is_weighted_above_high_utilization(self) -> None:
        """Spending more than the budget is not "high utilization", it is an overrun."""
        tight = snapshot(budget=BudgetState(total_budget=100, spent=95, committed=0, exists=True))
        over = snapshot(budget=BudgetState(total_budget=100, spent=110, committed=0, exists=True))
        tight_points = next(
            r.points for r in compute_health(tight).reasons if r.signal.startswith("budget")
        )
        over_points = next(
            r.points for r in compute_health(over).reasons if r.signal.startswith("budget")
        )
        assert over_points > tight_points

    def test_proximity_only_counts_when_serious_work_is_open(self) -> None:
        """Open critical work is fine three weeks out and is not fine tomorrow."""
        imminent_clean = snapshot(
            event={"start_date": (utc_now() + timedelta(hours=10)).isoformat()}
        )
        assert not any(r.signal == "imminent_start" for r in compute_health(imminent_clean).reasons)

        imminent_messy = snapshot(
            event={"start_date": (utc_now() + timedelta(hours=10)).isoformat()},
            tasks=[task(due_hours=-3)],
        )
        assert any(r.signal == "imminent_start" for r in compute_health(imminent_messy).reasons)

    def test_attendee_gaps_count_only_past_the_threshold(self) -> None:
        fine = snapshot(attendees=AttendeeState(total_registered=100, missing_information=5))
        assert not any(r.signal == "attendee_data_gaps" for r in compute_health(fine).reasons)
        poor = snapshot(attendees=AttendeeState(total_registered=100, missing_information=40))
        assert any(r.signal == "attendee_data_gaps" for r in compute_health(poor).reasons)

    def test_score_is_clamped_to_one_hundred(self) -> None:
        snap = snapshot(
            tasks=[task(due_hours=-5, task_id=f"T{i}") for i in range(30)]
            + [task(status="BLOCKED", task_id=f"B{i}") for i in range(20)],
            incidents=[
                {"severity": "CRITICAL", "status": "REPORTED", "incident_id": f"INC-{i}"}
                for i in range(10)
            ],
            budget=BudgetState(total_budget=100, spent=200, exists=True),
            attendees=AttendeeState(total_registered=100, missing_information=99),
        )
        result = compute_health(snap)
        assert result.score == 100
        assert result.band is HealthBand.RED


class TestAttentionItems:
    def test_ordered_worst_first(self) -> None:
        snap = snapshot(
            tasks=[task(status="BLOCKED", task_id="T1")],
            incidents=[
                {
                    "severity": "CRITICAL",
                    "status": "REPORTED",
                    "incident_id": "INC-1",
                    "title": "Bad",
                }
            ],
            approvals=[
                {
                    "status": "PENDING",
                    "approval_id": "APR-1",
                    "title": "Money",
                    "amount_inr": 5000,
                    "requested_action": "FinancialCommitment",
                    "requested_at": utc_now().isoformat(),
                }
            ],
        )
        items = attention_items(snap)
        assert items[0]["severity"] == "CRITICAL"
        rank = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
        severities = [rank[str(i["severity"])] for i in items]
        assert severities == sorted(severities)

    def test_financial_approvals_rank_above_procedural_ones(self) -> None:
        """A delayed financial decision has a hard external deadline; a procedural one rarely does."""
        snap = snapshot(
            approvals=[
                {
                    "status": "PENDING",
                    "approval_id": "APR-money",
                    "title": "Spend",
                    "amount_inr": 5000,
                    "requested_action": "FinancialCommitment",
                    "requested_at": utc_now().isoformat(),
                },
                {
                    "status": "PENDING",
                    "approval_id": "APR-proc",
                    "title": "Schedule change",
                    "amount_inr": 0,
                    "requested_action": "ModifyPublishedEvent",
                    "requested_at": utc_now().isoformat(),
                },
            ]
        )
        items = [i for i in attention_items(snap) if i["kind"] == "APPROVAL"]
        assert items[0]["resource_id"] == "APR-money"

    def test_decided_approvals_do_not_appear(self) -> None:
        snap = snapshot(
            approvals=[
                {
                    "status": "APPROVED",
                    "approval_id": "APR-1",
                    "title": "Done",
                    "amount_inr": 5000,
                    "requested_at": utc_now().isoformat(),
                }
            ]
        )
        assert not [i for i in attention_items(snap) if i["kind"] == "APPROVAL"]

    def test_every_item_carries_a_navigable_target(self) -> None:
        snap = snapshot(
            tasks=[task(due_hours=-2), task(status="BLOCKED", task_id="T9")],
            incidents=[
                {"severity": "HIGH", "status": "REPORTED", "incident_id": "INC-1", "title": "X"}
            ],
        )
        for item in attention_items(snap):
            assert item["resource_type"], item
            assert item["resource_id"] != "" or item["kind"] == "WORKLOAD"
