"""Speakers and their outreach lifecycle.

Routes:
    GET  /events/{eventId}/speakers                              list with derived risk
    POST /events/{eventId}/speakers                               add a speaker       (leader)
    PUT  /events/{eventId}/speakers/{speakerId}                    update              (leader)
    POST /events/{eventId}/speakers/{speakerId}/followup           draft a follow-up   (leader)

Confirming a speaker and committing to their accommodation are both approval-gated and go
through the approvals route, not here. What this handler owns is the tracking: who was asked,
who replied, who has gone quiet, and what their travel would cost.

The 72-hour silence rule is computed rather than stored. A stored "at risk" flag would be wrong
the moment the clock passed it and nobody ran a job, so the list derives it from the last
contact time on every read.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from services.api._common import (
    begin_request,
    handle_dynamodb_errors,
    path_param,
    pick,
    query_param,
    require_fields,
)
from services.shared.api_response import error, success
from services.shared.audit import create_audit_event
from services.shared.keys import event_gsi1pk, speaker_gsi1sk, speaker_sk
from services.shared.models.base import ErrorCategory, utc_now
from services.shared.models.speaker import SpeakerStatus
from services.shared.principal import Role, authorize_scope
from services.shared.validation import (
    coerce_int,
    sanitize_name,
    sanitize_text,
    validate_amount_inr,
    validate_email,
)

logger = logging.getLogger(__name__)

SPEAKER_UPDATE_FIELDS = [
    "name",
    "email",
    "phone",
    "status",
    "topic",
    "bio",
    "session_type",
    "session_duration_minutes",
    "session_time",
    "travel_required",
    "travel_origin",
    "travel_details",
    "accommodation_required",
    "accommodation_nights",
    "accommodation_details",
    "estimated_travel_cost",
    "estimated_accommodation_cost",
    "special_requirements",
    "availability_notes",
    "availability_confirmed",
    "slides_submitted",
    "av_requirements",
    "is_backup",
    "backup_for_speaker_id",
]

VALID_STATUSES = {s.value for s in SpeakerStatus}

# Statuses a leader may not set here, because reaching them is an approval-gated decision
# rather than a data edit. Allowing it would let the approval be bypassed by editing a field.
APPROVAL_GATED_STATUSES = frozenset({SpeakerStatus.CONFIRMED.value})


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    method = event.get("httpMethod", "GET")
    event_id = path_param(event, "eventId")
    speaker_id = path_param(event, "speakerId")
    path = str(event.get("resource") or event.get("path") or "")

    if path.endswith("/followup") and method == "POST":
        return draft_followup(event, event_id, speaker_id)
    if method == "GET":
        return list_speakers(event, event_id)
    if method == "POST":
        return create_speaker(event, event_id)
    if method == "PUT" and speaker_id:
        return update_speaker(event, event_id, speaker_id)

    return error(ErrorCategory.VALIDATION_ERROR, "Unsupported operation")


@handle_dynamodb_errors
def list_speakers(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Speakers with derived silence and cost roll-ups."""
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    if not event_id:
        return error(ErrorCategory.VALIDATION_ERROR, "eventId is required")

    scope_denied = authorize_scope(ctx.principal, event_id=event_id)
    if scope_denied:
        return scope_denied

    from services.shared.aggregate import load_event_snapshot

    snapshot = load_event_snapshot(
        ctx.organization_id, event_id, table_name=ctx.repo.table_name, include_attendees=False
    )

    silent_ids = {str(s.get("speaker_id")) for s in snapshot.silent_speakers}
    speakers = []
    for speaker in snapshot.speakers:
        speaker_id = str(speaker.get("speaker_id"))
        speakers.append(
            {
                **speaker,
                "silent_hours": snapshot.speaker_silent_hours(speaker),
                "needs_followup": speaker_id in silent_ids,
                # Contact details are in the record and a leader may legitimately see them, so
                # they are returned here. The agent's tool omits them; this is a human reading
                # their own speaker list.
            }
        )

    if status := query_param(event, "status").upper():
        if status == "UNRESPONSIVE":
            speakers = [s for s in speakers if s["needs_followup"]]
        else:
            speakers = [s for s in speakers if str(s.get("status")) == status]

    speakers.sort(key=lambda s: (-int(s["silent_hours"]), str(s.get("name", ""))))

    return success(
        {
            "speakers": speakers,
            "count": len(speakers),
            "confirmed": len(snapshot.confirmed_speakers),
            "pending": len(snapshot.unsettled_speakers),
            "unresponsive_over_72h": len(snapshot.silent_speakers),
            "needing_accommodation": len(snapshot.speakers_needing_accommodation),
            "estimated_travel_cost_inr": sum(
                coerce_int(s.get("estimated_travel_cost"))
                for s in snapshot.speakers
                if s.get("travel_required")
            ),
            "estimated_accommodation_cost_inr": sum(
                coerce_int(s.get("estimated_accommodation_cost"))
                for s in snapshot.speakers
                if s.get("accommodation_required")
            ),
        }
    )


@handle_dynamodb_errors
def create_speaker(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    missing = require_fields(ctx.body, "name")
    if missing:
        return missing

    email = str(ctx.body.get("email", "")).strip()
    if email and not validate_email(email):
        return error(ErrorCategory.VALIDATION_ERROR, "That email address is not valid")

    for field in ("estimated_travel_cost", "estimated_accommodation_cost"):
        if ctx.body.get(field) not in (None, "", 0, "0") and (
            validate_amount_inr(ctx.body[field]) is None
        ):
            return error(
                ErrorCategory.VALIDATION_ERROR,
                f"{field} must be a whole number of rupees.",
            )

    speaker_id = f"SPK-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()
    status = SpeakerStatus.IDENTIFIED.value

    ctx.repo.put_item(
        ctx.organization_id,
        speaker_sk(event_id, speaker_id),
        {
            "entity_type": "SPEAKER",
            "event_id": event_id,
            "speaker_id": speaker_id,
            "name": sanitize_name(str(ctx.body["name"])),
            "email": email.lower(),
            "phone": str(ctx.body.get("phone", "")).strip(),
            "status": status,
            "topic": sanitize_name(str(ctx.body.get("topic", ""))),
            "bio": sanitize_text(str(ctx.body.get("bio", ""))),
            "session_type": str(ctx.body.get("session_type", "TALK")).upper(),
            "session_duration_minutes": coerce_int(ctx.body.get("session_duration_minutes"), 30),
            "session_time": str(ctx.body.get("session_time", "")),
            "followup_count": 0,
            "max_followups": 3,
            "travel_required": bool(ctx.body.get("travel_required", False)),
            "travel_origin": sanitize_name(str(ctx.body.get("travel_origin", ""))),
            "accommodation_required": bool(ctx.body.get("accommodation_required", False)),
            "accommodation_nights": coerce_int(ctx.body.get("accommodation_nights")),
            "estimated_travel_cost": coerce_int(ctx.body.get("estimated_travel_cost")),
            "estimated_accommodation_cost": coerce_int(
                ctx.body.get("estimated_accommodation_cost")
            ),
            "travel_details": sanitize_text(str(ctx.body.get("travel_details", "")), 1000),
            "accommodation_details": sanitize_text(
                str(ctx.body.get("accommodation_details", "")), 1000
            ),
            "special_requirements": sanitize_text(
                str(ctx.body.get("special_requirements", "")), 1000
            ),
            "availability_notes": "",
            "availability_confirmed": False,
            "slides_submitted": False,
            "av_requirements": "",
            "is_backup": bool(ctx.body.get("is_backup", False)),
            "backup_for_speaker_id": str(ctx.body.get("backup_for_speaker_id", "")) or None,
            "created_at": now,
            "updated_at": now,
            "created_by": ctx.user_id,
            "updated_by": ctx.user_id,
            "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
            "GSI1SK": speaker_gsi1sk(status, now),
        },
    )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="SPEAKER_CREATED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Speaker",
        resource_id=speaker_id,
        event_id=event_id,
        details={"name": str(ctx.body["name"]), "topic": str(ctx.body.get("topic", ""))},
    )
    return success(
        {"speaker_id": speaker_id, "status": status, "message": "Speaker added"},
        status_code=201,
    )


@handle_dynamodb_errors
def update_speaker(event: dict[str, Any], event_id: str, speaker_id: str) -> dict[str, Any]:
    """Update a speaker.

    Setting the status to CONFIRMED is refused. Confirmation is a public commitment and is
    approval-gated, so allowing it as a field edit would be a way around the approval — the
    control has to live on every path that reaches the same state, not just the obvious one.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    sk = speaker_sk(event_id, speaker_id)
    existing = ctx.repo.get_item(ctx.organization_id, sk)
    if not existing:
        return error(ErrorCategory.NOT_FOUND, "Speaker not found")

    updates = pick(ctx.body, SPEAKER_UPDATE_FIELDS)
    if not updates:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            f"Provide at least one field to update: {', '.join(SPEAKER_UPDATE_FIELDS)}",
        )

    if "status" in updates:
        status = str(updates["status"]).upper()
        if status not in VALID_STATUSES:
            return error(
                ErrorCategory.VALIDATION_ERROR,
                f"status must be one of: {', '.join(sorted(VALID_STATUSES))}",
            )
        if status in APPROVAL_GATED_STATUSES and str(existing.get("status")) != status:
            return error(
                ErrorCategory.POLICY_REQUIRES_APPROVAL,
                "Confirming a speaker is a public commitment and needs an approval. Raise one "
                "with requested_action=ConfirmSpeaker, or ask the agent to prepare it.",
            )
        updates["status"] = status
        # The status is in the index sort key, so a transition rewrites it.
        updates["GSI1SK"] = speaker_gsi1sk(
            status, str(existing.get("created_at", utc_now().isoformat()))
        )

    if "email" in updates:
        cleaned = validate_email(str(updates["email"]))
        if updates["email"] and not cleaned:
            return error(ErrorCategory.VALIDATION_ERROR, "That email address is not valid")
        updates["email"] = cleaned or ""

    for field in ("estimated_travel_cost", "estimated_accommodation_cost"):
        if field in updates:
            amount = validate_amount_inr(updates[field])
            if amount is None:
                return error(
                    ErrorCategory.VALIDATION_ERROR,
                    f"{field} must be a whole number of rupees.",
                )
            updates[field] = amount

    # A recorded response clears the silence clock, which is what the follow-up rule reads.
    if updates.get("availability_confirmed") and not existing.get("response_received_at"):
        updates["response_received_at"] = utc_now().isoformat()

    updates["updated_at"] = utc_now().isoformat()
    updates["updated_by"] = ctx.user_id

    ctx.repo.update_item(ctx.organization_id, sk, updates)
    create_audit_event(
        organization_id=ctx.organization_id,
        action="SPEAKER_UPDATED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Speaker",
        resource_id=speaker_id,
        event_id=event_id,
        details={"updated_fields": sorted(k for k in updates if not k.startswith("GSI"))},
        policy_evaluated="UpdateSpeaker",
    )
    return success({"speaker_id": speaker_id, "message": "Speaker updated"})


@handle_dynamodb_errors
def draft_followup(event: dict[str, Any], event_id: str, speaker_id: str) -> dict[str, Any]:
    """Draft and store a follow-up. Sends nothing.

    Drafting is separated from sending deliberately: the draft is LOW risk and immediately
    useful, while sending leaves the organization and needs approval. The leader gets something
    to review rather than a suggestion that they should write one.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    from tools.community_ops import registry
    from tools.registry import ToolContext

    tool_ctx = ToolContext(
        principal=ctx.principal,
        organization_id=ctx.organization_id,
        table_name=ctx.repo.table_name,
        default_event_id=event_id,
    )
    result = registry.invoke(
        "prepare_speaker_followup",
        {"event_id": event_id, "speaker_id": speaker_id},
        tool_ctx,
    )
    if result.get("error"):
        return error(
            ErrorCategory(result["error"])
            if result["error"] in ErrorCategory.__members__
            else ErrorCategory.VALIDATION_ERROR,
            str(result.get("message", "The follow-up could not be drafted.")),
        )

    return success(result)
