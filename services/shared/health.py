"""Deterministic event health.

Health is a number the leader will make decisions from, so it is computed by arithmetic
over operational state rather than asked of a language model. A model asked to rate an
event would give a plausible answer that changed between identical calls, and "why is
this ORANGE?" would have no auditable answer.

The engine is a pure function of an :class:`~services.shared.aggregate.EventSnapshot`.
Same state in, same score out, every time. The agent is allowed to *explain* a score and
to argue about what to do; it is not allowed to produce one.

How the score works
-------------------
Each signal contributes penalty points. Points are summed and clamped to 100, then mapped
to a band. Every signal that fired is returned with the points it contributed, so the
explanation is generated from the same arithmetic that produced the number instead of
being narrated separately — the two cannot disagree.

Signals are individually capped. Twenty overdue tasks is a worse situation than four, but
it is not five times worse, and without a cap a single noisy signal would saturate the
score and hide an unresolved critical incident sitting behind it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from services.shared.models.event import HealthBand

if TYPE_CHECKING:  # pragma: no cover - types only
    from services.shared.aggregate import EventSnapshot


# --- signal weights ---------------------------------------------------------
# Tuned so that the demo event's genuinely mixed state lands in ORANGE rather than at a
# band edge, and so that one unresolved CRITICAL incident alone is enough to reach ORANGE.
# A single critical problem is an orange-grade situation on its own; that is the point.

POINTS_PER_OVERDUE_TASK = 6
MAX_OVERDUE_TASK_POINTS = 30

POINTS_PER_BLOCKED_TASK = 4
MAX_BLOCKED_TASK_POINTS = 16

INCIDENT_SEVERITY_POINTS = {
    # 36 rather than 30 so one unresolved critical incident crosses the ORANGE threshold on its
    # own. That is the intended behaviour: a critical problem is an orange-grade situation by
    # itself and should not need a second signal to be visible in the band.
    "CRITICAL": 36,
    "HIGH": 18,
    "MEDIUM": 8,
    "LOW": 3,
}
MAX_INCIDENT_POINTS = 48

POINTS_PER_SILENT_SPEAKER = 10
MAX_SILENT_SPEAKER_POINTS = 20

POINTS_PER_STALE_APPROVAL = 5
MAX_STALE_APPROVAL_POINTS = 15

BUDGET_CRITICAL_UTILIZATION = 90
BUDGET_CRITICAL_POINTS = 12
BUDGET_WARNING_UTILIZATION = 75
BUDGET_WARNING_POINTS = 6
BUDGET_OVERCOMMITTED_POINTS = 20

IMMINENT_EVENT_POINTS = 10
ATTENDEE_INCOMPLETE_THRESHOLD_PERCENT = 10
ATTENDEE_INCOMPLETE_POINTS = 6

# Band thresholds. Inclusive lower bounds.
BAND_THRESHOLDS: list[tuple[int, HealthBand]] = [
    (60, HealthBand.RED),
    (35, HealthBand.ORANGE),
    (15, HealthBand.YELLOW),
    (0, HealthBand.GREEN),
]


@dataclass
class HealthReason:
    """One signal that contributed to the score."""

    signal: str
    points: int
    detail: str

    def to_dict(self) -> dict[str, object]:
        return {"signal": self.signal, "points": self.points, "detail": self.detail}


@dataclass
class HealthResult:
    """A score, its band, and the arithmetic that produced it."""

    band: HealthBand
    score: int
    reasons: list[HealthReason] = field(default_factory=list)

    @property
    def summary(self) -> str:
        """A one-line explanation naming the largest contributors.

        Built from the reason list rather than written separately, so the sentence can
        never describe a different situation than the score does.
        """
        if not self.reasons:
            return "No operational risks detected."
        top = self.reasons[:3]
        return "; ".join(r.detail for r in top)

    def to_dict(self) -> dict[str, object]:
        return {
            "health_band": self.band.value,
            "health_score": self.score,
            "health_reasons": [r.detail for r in self.reasons],
            "health_signals": [r.to_dict() for r in self.reasons],
            "health_summary": self.summary,
        }


def band_for_score(score: int) -> HealthBand:
    """Map a score to a band. Higher score means worse health."""
    for threshold, band in BAND_THRESHOLDS:
        if score >= threshold:
            return band
    return HealthBand.GREEN  # pragma: no cover - the 0 threshold always matches


def _plural(count: int, singular: str, plural: str | None = None) -> str:
    return singular if count == 1 else (plural or f"{singular}s")


def compute_health(snapshot: EventSnapshot) -> HealthResult:
    """Score an event's health from its operational state.

    Returns the band, the clamped score, and the contributing signals ordered by how
    much each one cost, so a reader sees the biggest problem first.
    """
    reasons: list[HealthReason] = []

    # --- overdue work ------------------------------------------------------
    overdue = snapshot.overdue_tasks
    if overdue:
        points = min(len(overdue) * POINTS_PER_OVERDUE_TASK, MAX_OVERDUE_TASK_POINTS)
        reasons.append(
            HealthReason(
                signal="overdue_tasks",
                points=points,
                detail=f"{len(overdue)} overdue {_plural(len(overdue), 'task')}",
            )
        )

    # --- blocked work -----------------------------------------------------
    # Work blocked by an incident that is itself still open is not counted here. The incident
    # signal already accounts for that problem, and resolving the incident clears both, so
    # scoring them separately would charge one situation twice and overstate the event's risk.
    # The task still appears in the attention list; it just does not add to the score.
    open_incident_ids = {
        str(i.get("incident_id")) for i in snapshot.open_incidents if i.get("incident_id")
    }
    blocked = snapshot.blocked_tasks
    independently_blocked = [
        t for t in blocked if str(t.get("source_incident_id") or "") not in open_incident_ids
    ]
    if independently_blocked:
        points = min(len(independently_blocked) * POINTS_PER_BLOCKED_TASK, MAX_BLOCKED_TASK_POINTS)
        detail = (
            f"{len(independently_blocked)} blocked {_plural(len(independently_blocked), 'task')}"
        )
        if len(blocked) > len(independently_blocked):
            counted_elsewhere = len(blocked) - len(independently_blocked)
            detail += f" ({counted_elsewhere} more blocked by an open incident)"
        reasons.append(HealthReason(signal="blocked_tasks", points=points, detail=detail))

    # --- unresolved incidents ---------------------------------------------
    # Weighted by severity and capped as a group, so five low-priority incidents cannot
    # outweigh one critical one.
    incident_points = 0
    incident_details: list[str] = []
    for severity in ("CRITICAL", "HIGH", "MEDIUM", "LOW"):
        matching = snapshot.open_incidents_by_severity(severity)
        if not matching:
            continue
        incident_points += len(matching) * INCIDENT_SEVERITY_POINTS[severity]
        incident_details.append(
            f"{len(matching)} {severity.lower()}-severity {_plural(len(matching), 'incident')}"
        )
    if incident_points:
        reasons.append(
            HealthReason(
                signal="open_incidents",
                points=min(incident_points, MAX_INCIDENT_POINTS),
                detail=f"Unresolved: {', '.join(incident_details)}",
            )
        )

    # --- speakers who have gone quiet -------------------------------------
    silent = snapshot.silent_speakers
    if silent:
        points = min(len(silent) * POINTS_PER_SILENT_SPEAKER, MAX_SILENT_SPEAKER_POINTS)
        longest = max(snapshot.speaker_silent_hours(s) for s in silent)
        reasons.append(
            HealthReason(
                signal="silent_speakers",
                points=points,
                detail=(
                    f"{len(silent)} {_plural(len(silent), 'speaker')} "
                    f"unresponsive, longest {longest}h"
                ),
            )
        )

    # --- decisions nobody has made ----------------------------------------
    stale = snapshot.stale_approvals
    if stale:
        points = min(len(stale) * POINTS_PER_STALE_APPROVAL, MAX_STALE_APPROVAL_POINTS)
        reasons.append(
            HealthReason(
                signal="stale_approvals",
                points=points,
                detail=(
                    f"{len(stale)} {_plural(len(stale), 'approval')} "
                    f"waiting over 24h for a decision"
                ),
            )
        )

    # --- budget pressure ---------------------------------------------------
    budget = snapshot.budget
    if budget.total_budget > 0:
        utilization = budget.utilization_percent
        if budget.remaining < 0:
            # Spent plus committed exceeds the budget. This is not "high utilization",
            # it is an overrun, and it is weighted accordingly.
            reasons.append(
                HealthReason(
                    signal="budget_overcommitted",
                    points=BUDGET_OVERCOMMITTED_POINTS,
                    detail=f"Budget overcommitted by {abs(budget.remaining)} {budget.currency}",
                )
            )
        elif utilization >= BUDGET_CRITICAL_UTILIZATION:
            reasons.append(
                HealthReason(
                    signal="budget_utilization",
                    points=BUDGET_CRITICAL_POINTS,
                    detail=f"Budget {utilization}% utilized, little headroom left",
                )
            )
        elif utilization >= BUDGET_WARNING_UTILIZATION:
            reasons.append(
                HealthReason(
                    signal="budget_utilization",
                    points=BUDGET_WARNING_POINTS,
                    detail=f"Budget {utilization}% utilized",
                )
            )

    # --- the event is about to happen -------------------------------------
    # Open critical work is tolerable three weeks out and is not tolerable tomorrow, so
    # proximity only counts when something serious is still open.
    if snapshot.is_imminent:
        critical_open = (
            len(snapshot.open_incidents_by_severity("CRITICAL"))
            + len(snapshot.open_incidents_by_severity("HIGH"))
            + len(overdue)
        )
        if critical_open:
            hours = snapshot.hours_until_start
            reasons.append(
                HealthReason(
                    signal="imminent_start",
                    points=IMMINENT_EVENT_POINTS,
                    detail=(
                        f"Event starts in {int(hours or 0)}h with "
                        f"{critical_open} unresolved high-priority {_plural(critical_open, 'item')}"
                    ),
                )
            )

    # --- attendee data completeness ---------------------------------------
    attendees = snapshot.attendees
    if attendees.total_registered > 0:
        incomplete_percent = 100 - attendees.data_completeness_percent
        if incomplete_percent > ATTENDEE_INCOMPLETE_THRESHOLD_PERCENT:
            reasons.append(
                HealthReason(
                    signal="attendee_data_gaps",
                    points=ATTENDEE_INCOMPLETE_POINTS,
                    detail=(
                        f"{attendees.missing_information} of {attendees.total_registered} "
                        f"registrations missing operational details ({incomplete_percent}%)"
                    ),
                )
            )

    reasons.sort(key=lambda r: -r.points)
    score = min(100, sum(r.points for r in reasons))
    return HealthResult(band=band_for_score(score), score=score, reasons=reasons)


def attention_items(snapshot: EventSnapshot) -> list[dict[str, object]]:
    """What needs the leader's attention, worst first.

    Distinct from the health score: health answers "how is this event doing", this answers
    "what do I do next". Only items a leader can act on appear, and each carries the
    identifiers the console needs to navigate straight to it.

    Ordering is by an explicit severity rank rather than by insertion, because the first
    three entries are what the leader will actually read.
    """
    severity_rank = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    items: list[dict[str, object]] = []

    for incident in snapshot.open_incidents:
        severity = str(incident.get("severity", "MEDIUM"))
        items.append(
            {
                "kind": "INCIDENT",
                "severity": severity,
                "title": incident.get("title", "Untitled incident"),
                "detail": f"{severity} incident, status {incident.get('status', 'OPEN')}",
                "resource_type": "Incident",
                "resource_id": incident.get("incident_id", ""),
            }
        )

    for approval in snapshot.pending_approvals:
        amount = approval.get("amount_inr") or 0
        # A financial decision is escalated above a procedural one: money is the category
        # where a delayed decision has a hard external deadline.
        severity = "HIGH" if amount else "MEDIUM"
        from services.shared.validation import coerce_int, format_inr

        amount_int = coerce_int(amount)
        detail = str(approval.get("requested_action", "Approval requested"))
        if amount_int:
            detail = f"{detail} — {format_inr(amount_int)} {approval.get('currency', 'INR')}"
        items.append(
            {
                "kind": "APPROVAL",
                "severity": severity,
                "title": approval.get("title", "Approval required"),
                "detail": detail,
                "resource_type": "Approval",
                "resource_id": approval.get("approval_id", ""),
            }
        )

    overdue = snapshot.overdue_tasks
    if overdue:
        items.append(
            {
                "kind": "TASK",
                "severity": "HIGH" if len(overdue) >= 3 else "MEDIUM",
                "title": f"{len(overdue)} overdue {_plural(len(overdue), 'task')}",
                "detail": ", ".join(str(t.get("title", "")) for t in overdue[:3]),
                "resource_type": "Task",
                "resource_id": str(overdue[0].get("task_id", "")),
            }
        )

    for speaker in snapshot.silent_speakers:
        hours = snapshot.speaker_silent_hours(speaker)
        items.append(
            {
                "kind": "SPEAKER",
                "severity": "HIGH" if hours >= 96 else "MEDIUM",
                "title": f"{speaker.get('name', 'Speaker')} has not responded",
                "detail": f"No reply for {hours}h on '{speaker.get('topic', 'their session')}'",
                "resource_type": "Speaker",
                "resource_id": str(speaker.get("speaker_id", "")),
            }
        )

    blocked = snapshot.blocked_tasks
    if blocked:
        items.append(
            {
                "kind": "TASK",
                "severity": "MEDIUM",
                "title": f"{len(blocked)} blocked {_plural(len(blocked), 'task')}",
                "detail": ", ".join(str(t.get("title", "")) for t in blocked[:3]),
                "resource_type": "Task",
                "resource_id": str(blocked[0].get("task_id", "")),
            }
        )

    overloaded = [
        m for m in snapshot.member_workloads() if int(m["open_tasks"]) >= 6 and m["user_id"]
    ]
    if overloaded:
        items.append(
            {
                "kind": "WORKLOAD",
                "severity": "LOW",
                "title": f"{len(overloaded)} team {_plural(len(overloaded), 'member')} overloaded",
                "detail": ", ".join(
                    f"{m['display_name']} ({m['open_tasks']} open)" for m in overloaded[:3]
                ),
                "resource_type": "Team",
                "resource_id": str(overloaded[0].get("team_id", "")),
            }
        )

    budget = snapshot.budget
    if budget.total_budget > 0 and budget.utilization_percent >= BUDGET_WARNING_UTILIZATION:
        items.append(
            {
                "kind": "BUDGET",
                "severity": "HIGH" if budget.utilization_percent >= 90 else "MEDIUM",
                "title": f"Budget {budget.utilization_percent}% utilized",
                "detail": f"{budget.remaining} {budget.currency} remaining",
                "resource_type": "Budget",
                "resource_id": snapshot.event_id,
            }
        )

    items.sort(key=lambda i: severity_rank.get(str(i["severity"]), 9))
    return items
