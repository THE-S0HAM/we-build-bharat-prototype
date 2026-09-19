"""Demo simulation: the operational loop, played through as real records.

Routes:
    GET  /events/{eventId}/simulation        the step list and current progress
    POST /events/{eventId}/simulation        run the next step, or reset       (leader)

Why this exists
---------------
The product's claim is a loop — observe, detect, reason, recommend, seek approval, execute,
verify, audit, re-evaluate. Reading that in a README is not the same as watching an event's
health band move because a real incident was resolved.

So the simulation is not a canned animation. Every step is a genuine mutation through the same
services a person would use: it writes the same records, moves the same money through
``budget_service``, and recomputes health through the same deterministic engine. The numbers
change because the state changed.

Stepwise rather than all at once
--------------------------------
Each call advances one step and returns the health band before and after, so a judge can see
cause and effect instead of a final state that could have been seeded. Progress is stored on the
event so the sequence survives a page reload.

Safety
------
Leader only, and confined to the demo organization's events by the same tenant boundary as
everything else. Steps are idempotent: re-running one that has already applied reports that and
changes nothing, so a double-click cannot commit the same money twice.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from services.api._common import begin_request, handle_dynamodb_errors, path_param
from services.shared import budget_service
from services.shared.aggregate import load_event_snapshot
from services.shared.api_response import error, success
from services.shared.audit import create_audit_event
from services.shared.health import compute_health
from services.shared.keys import (
    approval_gsi1sk,
    approval_sk,
    event_gsi1pk,
    event_sk,
    incident_comment_gsi1sk,
    incident_comment_sk,
    incident_gsi1sk,
    incident_sk,
    speaker_gsi1sk,
    speaker_sk,
    task_gsi1sk,
    task_gsi2sk,
    task_sk,
)
from services.shared.models.base import ErrorCategory, utc_now
from services.shared.principal import Role
from services.shared.validation import coerce_int, format_inr

logger = logging.getLogger(__name__)

# Where simulation progress lives. Stored on the event so it is visible to every caller and
# survives a reload, rather than being held client-side where a refresh would lose it.
PROGRESS_FIELD = "simulation_step"

# The incident and approval this run created. Tracked explicitly because the demo event already
# has an open HIGH incident of its own: a step that operated on "the first open high-severity
# incident" would analyse one and resolve another, leaving an incoherent narrative and a health
# score that never recovers.
SIM_INCIDENT_FIELD = "simulation_incident_id"
SIM_APPROVAL_FIELD = "simulation_approval_id"
SIM_TASK_FIELD = "simulation_task_id"


@dataclass
class StepResult:
    """What one step did, and what it changed."""

    step: int
    label: str
    narrative: str
    changed: dict[str, Any]
    audit_action: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "step": self.step,
            "label": self.label,
            "narrative": self.narrative,
            "changed": self.changed,
            "audit_action": self.audit_action,
        }


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    method = event.get("httpMethod", "GET")
    event_id = path_param(event, "eventId")

    if method == "GET":
        return get_progress(event, event_id)
    if method == "POST":
        return advance(event, event_id)
    return error(ErrorCategory.VALIDATION_ERROR, "Unsupported operation")


STEP_LABELS = [
    "Speaker responds after a follow-up",
    "A deadline passes and work becomes overdue",
    "The venue team reports an incident",
    "The agent analyses the incident and creates work",
    "Health is recalculated from the new state",
    "The agent prepares an approval for the fix",
    "The leader approves and budget is committed",
    "The fix is completed and the incident resolved",
    "Health is recalculated and improves",
]
TOTAL_STEPS = len(STEP_LABELS)


@handle_dynamodb_errors
def get_progress(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    record = ctx.repo.get_item(ctx.organization_id, event_sk(event_id))
    if not record:
        return error(ErrorCategory.NOT_FOUND, "Event not found")

    snapshot = load_event_snapshot(ctx.organization_id, event_id, table_name=ctx.repo.table_name)
    health = compute_health(snapshot)
    completed = coerce_int(record.get(PROGRESS_FIELD))

    return success(
        {
            "event_id": event_id,
            "completed_steps": completed,
            "total_steps": TOTAL_STEPS,
            "next_step": completed + 1 if completed < TOTAL_STEPS else None,
            "next_step_label": (STEP_LABELS[completed] if completed < TOTAL_STEPS else None),
            "steps": [
                {"step": i + 1, "label": label, "completed": i < completed}
                for i, label in enumerate(STEP_LABELS)
            ],
            "current_health": health.to_dict(),
            "loop": [
                "Observe",
                "Detect",
                "Reason",
                "Recommend",
                "Approval",
                "Execute",
                "Verify",
                "Audit",
                "Re-evaluate",
            ],
        }
    )


@handle_dynamodb_errors
def advance(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Run the next simulation step, or reset the sequence."""
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    record = ctx.repo.get_item(ctx.organization_id, event_sk(event_id))
    if not record:
        return error(ErrorCategory.NOT_FOUND, "Event not found")

    if str(ctx.body.get("action", "")).lower() == "reset":
        ctx.repo.update_item(
            ctx.organization_id,
            event_sk(event_id),
            {PROGRESS_FIELD: 0, "updated_at": utc_now().isoformat()},
        )
        return success(
            {
                "event_id": event_id,
                "completed_steps": 0,
                "message": (
                    "Progress counter reset. The records the previous run created are left in "
                    "place — they are real operational data, so re-seed the demo if you want a "
                    "clean slate."
                ),
            }
        )

    completed = coerce_int(record.get(PROGRESS_FIELD))
    if completed >= TOTAL_STEPS:
        return success(
            {
                "event_id": event_id,
                "completed_steps": completed,
                "total_steps": TOTAL_STEPS,
                "finished": True,
                "message": "The simulation has finished. Reset it to run through again.",
            }
        )

    step_number = completed + 1

    # Health before, so the response shows what this step actually changed rather than only
    # the state it left behind.
    before_snapshot = load_event_snapshot(
        ctx.organization_id, event_id, table_name=ctx.repo.table_name
    )
    before_health = compute_health(before_snapshot)

    runners = {
        1: _step_speaker_responds,
        2: _step_task_overdue,
        3: _step_incident_reported,
        4: _step_agent_analyses,
        5: _step_recalculate,
        6: _step_request_approval,
        7: _step_approve_and_commit,
        8: _step_resolve,
        9: _step_recalculate_final,
    }

    # Identifiers this run has created so far, so later steps act on the simulation's own thread
    # rather than on whatever the event already happened to have open.
    run_state = {
        "incident_id": str(record.get(SIM_INCIDENT_FIELD, "") or ""),
        "approval_id": str(record.get(SIM_APPROVAL_FIELD, "") or ""),
        "task_id": str(record.get(SIM_TASK_FIELD, "") or ""),
    }

    try:
        result = runners[step_number](ctx, event_id, before_snapshot, run_state)
    except _StepUnavailableError as exc:
        # The demo data this step needs is missing. Reported rather than skipped silently, so a
        # judge sees why nothing moved instead of concluding the feature is broken.
        return error(ErrorCategory.CONFLICT, str(exc))

    after_snapshot = load_event_snapshot(
        ctx.organization_id, event_id, table_name=ctx.repo.table_name
    )
    after_health = compute_health(after_snapshot)

    progress_update: dict[str, Any] = {
        PROGRESS_FIELD: step_number,
        "health_band": after_health.band.value,
        "health_score": after_health.score,
        "health_reasons": [r.detail for r in after_health.reasons],
        "health_computed_at": utc_now().isoformat(),
        "updated_at": utc_now().isoformat(),
    }
    # Carry forward whatever this step created, so the next one can follow the same thread.
    if run_state.get("incident_id"):
        progress_update[SIM_INCIDENT_FIELD] = run_state["incident_id"]
    if run_state.get("approval_id"):
        progress_update[SIM_APPROVAL_FIELD] = run_state["approval_id"]
    if run_state.get("task_id"):
        progress_update[SIM_TASK_FIELD] = run_state["task_id"]

    ctx.repo.update_item(ctx.organization_id, event_sk(event_id), progress_update)

    create_audit_event(
        organization_id=ctx.organization_id,
        action="SIMULATION_STEP",
        actor_type="system",
        actor_id=ctx.user_id,
        resource_type="Event",
        resource_id=event_id,
        event_id=event_id,
        details={
            "step": step_number,
            "label": result.label,
            "health_before": before_health.band.value,
            "health_after": after_health.band.value,
            "score_before": before_health.score,
            "score_after": after_health.score,
        },
    )

    return success(
        {
            "event_id": event_id,
            "step": step_number,
            "total_steps": TOTAL_STEPS,
            "completed_steps": step_number,
            "finished": step_number >= TOTAL_STEPS,
            "result": result.to_dict(),
            "health_before": before_health.to_dict(),
            "health_after": after_health.to_dict(),
            "score_delta": after_health.score - before_health.score,
            "next_step_label": (STEP_LABELS[step_number] if step_number < TOTAL_STEPS else None),
        }
    )


class _StepUnavailableError(Exception):
    """The demo data a step depends on is not present."""


def _category_remaining(summary: Any, category: str) -> int:
    """Headroom left in one budget category, or zero if it has no allocation."""
    line = next((c for c in summary.get("categories", []) if c["category"] == category), None)
    return int(line["remaining"]) if line else 0


def _run_incident(snapshot: Any, run_state: dict[str, str]) -> dict[str, Any]:
    """The incident this simulation run created.

    Looked up by the id recorded in step 3 rather than by taking the first open high-severity
    incident. The demo event already has one of its own, so "first open HIGH" could analyse one
    incident and resolve a different one, which leaves the narrative incoherent and the health
    score permanently carrying an incident nobody closed.
    """
    incident_id = run_state.get("incident_id", "")
    if not incident_id:
        raise _StepUnavailableError(
            "This run has not reported its incident yet. Run the earlier steps in order."
        )
    incident = next(
        (i for i in snapshot.incidents if str(i.get("incident_id")) == incident_id), None
    )
    if incident is None:
        raise _StepUnavailableError(
            f"Incident {incident_id} from this run no longer exists. Reset the simulation."
        )
    return incident


# ---------------------------------------------------------------------------
# The steps. Each one is a real mutation.
# ---------------------------------------------------------------------------


def _step_speaker_responds(
    ctx: Any, event_id: str, snapshot: Any, run_state: dict[str, str]
) -> StepResult:
    """A silent speaker replies, clearing the follow-up signal."""
    candidates = snapshot.silent_speakers or snapshot.unsettled_speakers
    if not candidates:
        raise _StepUnavailableError(
            "No speaker is awaiting a response, so there is nothing to receive. Re-seed the "
            "demo data to restore the scenario."
        )

    speaker = candidates[0]
    speaker_id = str(speaker.get("speaker_id"))
    now = utc_now().isoformat()

    ctx.repo.update_item(
        ctx.organization_id,
        speaker_sk(event_id, speaker_id),
        {
            "status": "CONFIRMED",
            "response_received_at": now,
            "availability_confirmed": True,
            "updated_at": now,
            "updated_by": "simulation",
            "GSI1SK": speaker_gsi1sk("CONFIRMED", str(speaker.get("created_at", now))),
        },
    )
    return StepResult(
        step=1,
        label=STEP_LABELS[0],
        narrative=(
            f"{speaker.get('name')} replied and confirmed availability after "
            f"{snapshot.speaker_silent_hours(speaker)}h of silence. The unresponsive-speaker "
            "signal clears, so the health score drops."
        ),
        changed={"speaker_id": speaker_id, "new_status": "CONFIRMED"},
        audit_action="SPEAKER_RESPONDED",
    )


def _step_task_overdue(
    ctx: Any, event_id: str, snapshot: Any, run_state: dict[str, str]
) -> StepResult:
    """A deadline passes.

    The task's due date is moved into the past rather than its status being set to OVERDUE,
    because overdue-ness is derived. Setting the status would demonstrate the wrong thing — that
    a field can be written — instead of the real behaviour, which is that the engine notices a
    deadline has gone by.
    """
    open_tasks = [
        t
        for t in snapshot.open_tasks
        if not snapshot.is_task_overdue(t) and str(t.get("status")) != "BLOCKED"
    ]
    if not open_tasks:
        raise _StepUnavailableError("Every open task is already overdue or blocked.")

    task = min(open_tasks, key=lambda t: str(t.get("due_date") or "~"))
    team_id = str(task.get("team_id"))
    task_id = str(task.get("task_id"))
    past = (utc_now() - timedelta(hours=5)).isoformat()

    ctx.repo.update_item(
        ctx.organization_id,
        task_sk(event_id, team_id, task_id),
        {
            "due_date": past,
            "updated_at": utc_now().isoformat(),
            "updated_by": "simulation",
            "GSI2SK": task_gsi2sk(str(task.get("status")), past, task_id),
        },
    )
    return StepResult(
        step=2,
        label=STEP_LABELS[1],
        narrative=(
            f"'{task.get('title')}' ({team_id}) passed its deadline five hours ago. Nothing set "
            "it to overdue — the health engine derives lateness from the deadline, so the task "
            "is now counted as late automatically."
        ),
        changed={"task_id": task_id, "team_id": team_id, "due_date": past},
        audit_action="TASK_BECAME_OVERDUE",
    )


def _step_incident_reported(
    ctx: Any, event_id: str, snapshot: Any, run_state: dict[str, str]
) -> StepResult:
    """A team member reports a venue incident."""
    incident_id = f"INC-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()
    team = snapshot.team("TEAM-venue") or (snapshot.teams[0] if snapshot.teams else None)
    team_id = team.team_id if team else ""

    ctx.repo.put_item(
        ctx.organization_id,
        incident_sk(event_id, incident_id),
        {
            "entity_type": "INCIDENT",
            "event_id": event_id,
            "incident_id": incident_id,
            "title": "Main hall projector failed during setup testing",
            "description": (
                "The primary projector stopped displaying during AV testing. The backup unit is "
                "in storage but has not been tested with the current laptop setup."
            ),
            "severity": "HIGH",
            "status": "REPORTED",
            "category": "TECHNICAL",
            "team_id": team_id,
            "affected_resource_type": "Venue",
            "affected_resource_id": "main-hall",
            "detected_at": now,
            "detected_by": "user",
            "reported_by": "demo-volunteer",
            "reported_by_name": "Rahul Patil",
            "reported_by_role": "TEAM_MEMBER",
            "dependencies": [],
            "backup_options": [],
            "actions_taken": [],
            "comment_count": 1,
            "reopened_count": 0,
            "created_at": now,
            "updated_at": now,
            "created_by": "simulation",
            "updated_by": "simulation",
            "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
            "GSI1SK": incident_gsi1sk("REPORTED", now),
        },
    )

    comment_id = f"CMT-{uuid.uuid4().hex[:8]}"
    ctx.repo.put_item(
        ctx.organization_id,
        incident_comment_sk(event_id, incident_id, comment_id),
        {
            "entity_type": "INCIDENT_COMMENT",
            "event_id": event_id,
            "incident_id": incident_id,
            "comment_id": comment_id,
            "body": (
                "Projector stopped working about ten minutes into testing. No image at all, "
                "tried two cables."
            ),
            "author_id": "demo-volunteer",
            "author_name": "Rahul Patil",
            "author_type": "user",
            "author_role": "TEAM_MEMBER",
            "team_id": team_id,
            "parent_comment_id": None,
            "attachment_document_id": None,
            "created_task_id": None,
            "created_approval_id": None,
            "created_at": now,
            "updated_at": now,
            "created_by": "simulation",
            "updated_by": "simulation",
            "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
            "GSI1SK": incident_comment_gsi1sk(incident_id, now),
        },
    )

    # Recorded so the analysis and resolution steps act on this incident rather than on the one
    # the demo event already had open.
    run_state["incident_id"] = incident_id

    return StepResult(
        step=3,
        label=STEP_LABELS[2],
        narrative=(
            "Rahul Patil reported a HIGH incident: the main hall projector failed during setup. "
            "A HIGH incident carries 18 penalty points on its own, so the health band moves."
        ),
        changed={"incident_id": incident_id, "severity": "HIGH", "comment_id": comment_id},
        audit_action="INCIDENT_REPORTED",
    )


def _step_agent_analyses(
    ctx: Any, event_id: str, snapshot: Any, run_state: dict[str, str]
) -> StepResult:
    """The agent analyses the incident, posts its reasoning, and creates the work.

    Both actions are LOW risk — a comment and an internal task — which is exactly why the agent
    does them without asking. The expenditure two steps later is not, and it will stop for a
    human.
    """
    incident = _run_incident(snapshot, run_state)
    incident_id = str(incident.get("incident_id"))
    now = utc_now().isoformat()
    tech_team = snapshot.team("TEAM-tech") or (snapshot.teams[0] if snapshot.teams else None)
    if tech_team is None:
        raise _StepUnavailableError("The event has no teams, so no work can be created.")

    task_id = f"TSK-{uuid.uuid4().hex[:8]}"
    due = (utc_now() + timedelta(hours=4)).isoformat()
    ctx.repo.put_item(
        ctx.organization_id,
        task_sk(event_id, tech_team.team_id, task_id),
        {
            "entity_type": "TASK",
            "event_id": event_id,
            "team_id": tech_team.team_id,
            "task_id": task_id,
            "title": "Test the backup projector with the presentation laptop",
            "description": (
                "Confirm the backup unit displays correctly before the first session. Raised "
                "from incident analysis."
            ),
            "status": "ASSIGNED",
            "priority": "CRITICAL",
            "risk": "HIGH",
            "assigned_to": "",
            "assigned_to_name": "",
            "due_date": due,
            "depends_on": [],
            "blocks": [],
            "escalation_level": 1,
            "estimated_effort_hours": 1,
            "blocked_reason": "",
            "notes": "Created by the CommunityOps agent from incident analysis.",
            "source_incident_id": incident_id,
            "created_at": now,
            "updated_at": now,
            "created_by": "CommunityOps",
            "updated_by": "CommunityOps",
            "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
            "GSI1SK": task_gsi1sk("ASSIGNED", now),
            "GSI2PK": f"{ctx.organization_id}#{event_id}#TASK",
            "GSI2SK": task_gsi2sk("ASSIGNED", due, task_id),
        },
    )

    comment_id = f"CMT-{uuid.uuid4().hex[:8]}"
    ctx.repo.put_item(
        ctx.organization_id,
        incident_comment_sk(event_id, incident_id, comment_id),
        {
            "entity_type": "INCIDENT_COMMENT",
            "event_id": event_id,
            "incident_id": incident_id,
            "comment_id": comment_id,
            "body": (
                "Impact: HIGH — the main hall is the only room with a projector, so every "
                "session depends on it.\n\n"
                "Dependencies: the session schedule, the speaker slide handover, and the "
                "volunteer briefing all assume main-hall projection.\n\n"
                "Recommended actions:\n"
                "1. Test the backup projector against the presentation laptop before the first "
                "session. I have created this as a CRITICAL task for the Technical team.\n"
                "2. If the backup also fails, hiring a replacement unit is roughly 7,000 — that "
                "is a financial commitment, so it needs your approval.\n"
                "3. Keep the schedule unchanged until the backup test result is known.\n\n"
                "Action 2 requires leader approval. Actions 1 and 3 I can handle."
            ),
            "author_id": "CommunityOps",
            "author_name": "CommunityOps Agent",
            "author_type": "agent",
            "author_role": "LEADER",
            "team_id": tech_team.team_id,
            "parent_comment_id": None,
            "attachment_document_id": None,
            "created_task_id": task_id,
            "created_approval_id": None,
            "created_at": now,
            "updated_at": now,
            "created_by": "CommunityOps",
            "updated_by": "CommunityOps",
            "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
            "GSI1SK": incident_comment_gsi1sk(incident_id, now),
        },
    )

    ctx.repo.update_item(
        ctx.organization_id,
        incident_sk(event_id, incident_id),
        {
            "status": "RECOMMENDATION_READY",
            "impact_analysis": "Main hall is the only projection-capable room; all sessions depend on it.",
            "dependencies": ["Session schedule", "Speaker slide handover", "Volunteer briefing"],
            "backup_options": ["Untested backup projector in storage", "Hire a replacement unit"],
            "recommendation": (
                "Test the backup projector before the first session. If it fails, hire a "
                "replacement — that needs approval."
            ),
            "comment_count": coerce_int(incident.get("comment_count")) + 1,
            "updated_at": now,
            "updated_by": "CommunityOps",
            "GSI1SK": incident_gsi1sk(
                "RECOMMENDATION_READY", str(incident.get("detected_at", now))
            ),
        },
    )

    # The resolution step completes this specific task, so the incident closes backed by finished
    # work rather than by a status change alone.
    run_state["task_id"] = task_id

    return StepResult(
        step=4,
        label=STEP_LABELS[3],
        narrative=(
            "The agent read the incident and its discussion, posted an impact analysis naming "
            "the three dependencies, and created a CRITICAL task for the Technical team. Both "
            "are low-risk internal actions, so it did them without asking. The replacement hire "
            "it suggests is financial, so that will stop for approval."
        ),
        changed={
            "incident_id": incident_id,
            "task_created": task_id,
            "comment_id": comment_id,
            "incident_status": "RECOMMENDATION_READY",
        },
        audit_action="AGENT_INCIDENT_ANALYSED",
    )


def _step_recalculate(
    ctx: Any, event_id: str, snapshot: Any, run_state: dict[str, str]
) -> StepResult:
    """Health is recalculated. No mutation beyond the cached band.

    A step that changes nothing is worth having: it shows the score is computed from state
    rather than adjusted by whoever last wrote to the event.
    """
    health = compute_health(snapshot)
    return StepResult(
        step=5,
        label=STEP_LABELS[4],
        narrative=(
            f"Health recalculated from current state: {health.band.value} at {health.score}/100. "
            + "; ".join(f"{r.detail} ({r.points} pts)" for r in health.reasons[:4])
            + ". Nothing was written except the cached band — the score is arithmetic over the "
            "records, not a value anybody set."
        ),
        changed={"health_band": health.band.value, "health_score": health.score},
        audit_action="EVENT_HEALTH_RECALCULATED",
    )


def _step_request_approval(
    ctx: Any, event_id: str, snapshot: Any, run_state: dict[str, str]
) -> StepResult:
    """The agent raises the approval for the equipment hire, with the budget impact computed."""
    summary = budget_service.get_budget(
        ctx.organization_id, event_id, table_name=ctx.repo.table_name
    )
    if not summary["exists"]:
        raise _StepUnavailableError(
            "This event has no budget, so no financial approval can be raised."
        )

    amount = 7000

    # The projector hire naturally belongs to EQUIPMENT, but EQUIPMENT may not have the headroom
    # — in the seeded dataset it has 2,000 left against a 7,000 hire. Rather than raising an
    # approval that the budget would refuse two steps later, the category is chosen by asking the
    # projection which one can actually absorb it. Falling back to EMERGENCY is exactly what an
    # emergency allocation is for, and the narrative says which was used and why.
    preferred = "EQUIPMENT"
    projection = budget_service.project_commitment(summary, preferred, amount)
    category = preferred
    fallback_note = ""

    if not projection["affordable"]:
        alternative = budget_service.project_commitment(summary, "EMERGENCY", amount)
        if alternative["affordable"]:
            category = "EMERGENCY"
            projection = alternative
            fallback_note = (
                f" EQUIPMENT has only "
                f"{format_inr(_category_remaining(summary, preferred))} left, so this is drawn "
                "against EMERGENCY instead."
            )
        else:
            raise _StepUnavailableError(
                f"Neither EQUIPMENT nor EMERGENCY can absorb {format_inr(amount)}. "
                "Re-seed the demo data to restore the budget."
            )

    approval_id = f"APR-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()

    ctx.repo.put_item(
        ctx.organization_id,
        approval_sk(event_id, approval_id),
        {
            "entity_type": "APPROVAL",
            "event_id": event_id,
            "approval_id": approval_id,
            "title": "Hire a replacement projector for the main hall",
            "description": (
                "The main hall projector failed and the backup is untested. Hiring a replacement "
                "unit removes the risk of losing main-hall projection entirely."
            ),
            "status": "PENDING",
            "risk_level": "HIGH",
            "requested_action": "FinancialCommitment",
            "reason": "Equipment hire is a financial commitment and cannot be undone once booked.",
            "evidence": {
                "incident_severity": "HIGH",
                "backup_tested": False,
                "affordable": projection["affordable"],
                "remaining_before_inr": projection["current_remaining"],
                "remaining_after_inr": projection["projected_remaining"],
                "category_chosen": category,
                "equipment_headroom_inr": _category_remaining(summary, "EQUIPMENT"),
            },
            "affected_resource_type": "Budget",
            "affected_resource_id": event_id,
            "amount_inr": amount,
            "currency": "INR",
            "budget_category": category,
            "budget_impact": projection["impact_summary"],
            "requested_by": "CommunityOps",
            "requested_by_name": "CommunityOps Agent",
            "requested_by_role": "LEADER",
            "agent_name": "CommunityOps",
            "agent_recommendation": (
                f"Affordable: {format_inr(projection['current_remaining'])} uncommitted now, "
                f"{format_inr(projection['projected_remaining'])} after.{fallback_note} "
                "I recommend approving before the backup test, so the hire can be arranged "
                "immediately if the test fails."
            ),
            "tool_name": "record_expense",
            "requested_at": now,
            "created_at": now,
            "updated_at": now,
            "created_by": "CommunityOps",
            "updated_by": "CommunityOps",
            "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
            "GSI1SK": approval_gsi1sk("PENDING", now),
        },
    )

    # The approval step decides this request, not whichever pending financial approval the demo
    # event already happened to carry.
    run_state["approval_id"] = approval_id

    return StepResult(
        step=6,
        label=STEP_LABELS[5],
        narrative=(
            f"The agent prepared approval {approval_id} for {format_inr(amount)} of equipment "
            f"hire against {category}.{fallback_note} It did not spend anything: "
            f"{projection['impact_summary']} is what would happen if the leader approves. The "
            "arithmetic came from the budget service, not from the model — and the category was "
            "chosen by checking which one could actually absorb the amount."
        ),
        changed={
            "approval_id": approval_id,
            "amount_inr": amount,
            "budget_category": category,
            "budget_impact": projection["impact_summary"],
        },
        audit_action="APPROVAL_REQUESTED",
    )


def _step_approve_and_commit(
    ctx: Any, event_id: str, snapshot: Any, run_state: dict[str, str]
) -> StepResult:
    """The leader approves, and the money moves deterministically."""
    approval_id = run_state.get("approval_id", "")
    if not approval_id:
        raise _StepUnavailableError(
            "This run has not prepared its approval yet. Run the earlier steps in order."
        )
    approval = next(
        (a for a in snapshot.approvals if str(a.get("approval_id")) == approval_id), None
    )
    if approval is None:
        raise _StepUnavailableError(f"Approval {approval_id} from this run no longer exists.")
    if str(approval.get("status")) != "PENDING":
        raise _StepUnavailableError("This run's approval has already been decided.")
    amount = coerce_int(approval.get("amount_inr"))
    category = str(approval.get("budget_category"))

    before = budget_service.get_budget(
        ctx.organization_id, event_id, table_name=ctx.repo.table_name
    )
    try:
        after = budget_service.commit(
            ctx.organization_id,
            event_id,
            category,
            amount,
            actor_id=ctx.user_id,
            table_name=ctx.repo.table_name,
        )
    except budget_service.BudgetError as exc:
        raise _StepUnavailableError(f"The budget refused the commitment: {exc.message}") from exc

    now = utc_now().isoformat()
    ctx.repo.update_item(
        ctx.organization_id,
        approval_sk(event_id, approval_id),
        {
            "status": "APPROVED",
            "decided_by": ctx.user_id,
            "decided_at": now,
            "decision_notes": "Approved during the operations simulation.",
            "budget_impact": (
                f"Committed {format_inr(amount)}; {format_inr(after.remaining)} remaining"
            ),
            "updated_at": now,
            "updated_by": ctx.user_id,
            "GSI1SK": approval_gsi1sk("APPROVED", str(approval.get("requested_at", now))),
        },
    )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="BUDGET_COMMITTED",
        actor_type="user",
        actor_id=ctx.user_id,
        resource_type="Budget",
        resource_id=event_id,
        event_id=event_id,
        details={
            "category": category,
            "amount_inr": amount,
            "remaining_before": before.remaining,
            "remaining_after": after.remaining,
        },
        approval_id=approval_id,
    )

    return StepResult(
        step=7,
        label=STEP_LABELS[6],
        narrative=(
            f"The leader approved {approval_id}. The backend committed {format_inr(amount)} to "
            f"{category}: remaining went from {format_inr(before.remaining)} to "
            f"{format_inr(after.remaining)}, utilization is now "
            f"{after['utilization_percent']}%. The index sort key was rewritten too, so the "
            "approval leaves the pending queue."
        ),
        changed={
            "approval_id": approval_id,
            "committed_inr": amount,
            "remaining_before_inr": before.remaining,
            "remaining_after_inr": after.remaining,
            "utilization_percent": after["utilization_percent"],
        },
        audit_action="APPROVAL_APPROVED",
    )


def _step_resolve(ctx: Any, event_id: str, snapshot: Any, run_state: dict[str, str]) -> StepResult:
    """The work is completed and the incident resolved."""
    incident = _run_incident(snapshot, run_state)
    incident_id = str(incident.get("incident_id"))
    if str(incident.get("status")) in ("RESOLVED", "CLOSED"):
        raise _StepUnavailableError("This run's incident is already resolved.")
    now = utc_now().isoformat()

    # Close the task the analysis raised, so the resolution is backed by finished work rather
    # than only a status change on the incident.
    completed_task = None
    run_task_id = run_state.get("task_id", "")
    for task in snapshot.open_tasks:
        if str(task.get("task_id")) == run_task_id or (
            not run_task_id and str(task.get("source_incident_id")) == incident_id
        ):
            completed_task = task
            ctx.repo.update_item(
                ctx.organization_id,
                task_sk(event_id, str(task.get("team_id")), str(task.get("task_id"))),
                {
                    "status": "COMPLETED",
                    "completed_at": now,
                    "updated_at": now,
                    "updated_by": ctx.user_id,
                    "GSI1SK": task_gsi1sk("COMPLETED", str(task.get("created_at", now))),
                    "GSI2SK": task_gsi2sk(
                        "COMPLETED", str(task.get("due_date", "")), str(task.get("task_id"))
                    ),
                },
            )
            break

    ctx.repo.update_item(
        ctx.organization_id,
        incident_sk(event_id, incident_id),
        {
            "status": "RESOLVED",
            "resolution_summary": (
                "Backup projector tested successfully against the presentation laptop. Main hall "
                "projection is covered; the approved hire was held as contingency and not used."
            ),
            "root_cause": "Primary projector lamp failure, no pre-event check on the backup unit.",
            "actions_taken": [
                "Tested the backup projector with the presentation laptop",
                "Approved a replacement hire as contingency",
                "Added a pre-event backup-equipment check to the technical checklist",
            ],
            "resolved_at": now,
            "resolved_by": ctx.user_id,
            "updated_at": now,
            "updated_by": ctx.user_id,
            "GSI1SK": incident_gsi1sk("RESOLVED", str(incident.get("detected_at", now))),
        },
    )

    return StepResult(
        step=8,
        label=STEP_LABELS[7],
        narrative=(
            "The backup projector tested fine. The task the agent created is complete and the "
            "incident is resolved with a root cause and the actions taken recorded. The 18-point "
            "incident signal and the task both clear."
        ),
        changed={
            "incident_id": incident_id,
            "task_completed": (str(completed_task.get("task_id")) if completed_task else None),
        },
        audit_action="INCIDENT_RESOLVED",
    )


def _step_recalculate_final(
    ctx: Any, event_id: str, snapshot: Any, run_state: dict[str, str]
) -> StepResult:
    """Health is recalculated, and it has improved."""
    health = compute_health(snapshot)
    return StepResult(
        step=9,
        label=STEP_LABELS[8],
        narrative=(
            f"Health recomputed: {health.band.value} at {health.score}/100. "
            + (
                "Remaining signals: "
                + "; ".join(f"{r.detail} ({r.points} pts)" for r in health.reasons[:3])
                if health.reasons
                else "No operational risks remain."
            )
            + ". The loop closed: the problem was observed, analysed, worked, approved where "
            "money was involved, verified, audited, and the score moved because the state did."
        ),
        changed={"health_band": health.band.value, "health_score": health.score},
        audit_action="EVENT_HEALTH_RECALCULATED",
    )
