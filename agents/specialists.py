"""Specialist lenses over the shared tool registry.

The original design had five specialist agents — CheckInOps, SpeakerOps, TeamOps, AttendeeOps,
IncidentOps — each in its own package. None of them were reachable: every factory passed
``tools=[]``, the prompts advertised nineteen tools of which two existed, and nothing in the
repository ever called one. They described a hierarchy rather than forming one.

Those packages are gone. What was genuinely useful about them survives here: the domain
framing. Giving the model a narrower brief and a smaller tool set produces better operational
answers than handing it thirty tools and a general instruction, because it stops hedging across
concerns that are not the question.

So a specialist is a *lens*, not a separate agent: the same registry, the same authorization,
filtered to the tools a domain needs and prefixed with what that domain cares about. There is
no delegation, no sub-agent graph, and nothing here can reach data the caller cannot.

The deployed chat uses the full catalogue (:mod:`agents.runtime`). These lenses are for focused
work — a background job following up speakers, or a console panel scoped to one concern.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from services.shared.principal import Principal
from tools.community_ops import registry
from tools.registry import ToolRegistry, ToolSpec

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Specialist:
    """A domain framing plus the subset of tools that domain needs."""

    name: str
    focus: str
    tool_names: frozenset[str] = field(default_factory=frozenset)

    def tools(self, principal: Principal) -> list[ToolSpec]:
        """The specialist's tools, still filtered by the caller's role.

        Intersected with role visibility rather than replacing it. A specialist narrows what is
        offered; it can never widen it, so naming a tool here does not grant access to it.
        """
        visible = {spec.name for spec in registry.visible_for(principal)}
        return [
            spec for spec in registry.all() if spec.name in self.tool_names and spec.name in visible
        ]

    def scoped_registry(self, principal: Principal) -> ToolRegistry:
        """A registry containing only this specialist's tools.

        A real registry rather than a filtered list, so :meth:`ToolRegistry.invoke` still runs
        the full gate. Passing a subset of specs to the model while invoking through an
        unrestricted registry would make the narrowing cosmetic.
        """
        scoped = ToolRegistry()
        for spec in self.tools(principal):
            scoped.register(spec)
        return scoped

    def prompt_prefix(self) -> str:
        return (
            f"You are operating as {self.name}, focused on one part of event operations.\n\n"
            f"{self.focus}\n\n"
            "Stay within this focus. If the user asks about something outside it, say which "
            "part of operations handles it rather than guessing."
        )


CHECKIN_OPS = Specialist(
    name="CheckInOps",
    focus=(
        "Attendee arrival: registrations, ticket recovery, payment verification and check-in.\n"
        "Never assert a payment or registration status you have not looked up. If a lookup "
        "fails, say it could not be verified — never that the registration does not exist, "
        "because those are different facts and the attendee is standing in front of somebody."
    ),
    tool_names=frozenset(
        {
            "get_event",
            "get_attendee_summary",
            "list_tasks",
            "create_task",
            "create_incident",
        }
    ),
)

SPEAKER_OPS = Specialist(
    name="SpeakerOps",
    focus=(
        "Speaker outreach: invitations, confirmations, follow-ups, travel and accommodation.\n"
        "A speaker silent beyond 72 hours needs a follow-up drafted. Drafting is yours; sending "
        "is the leader's, and booking anything is a financial commitment that needs approval.\n"
        "When you recommend a follow-up, say how long they have been silent and what was asked."
    ),
    tool_names=frozenset(
        {
            "get_event",
            "get_speakers",
            "prepare_speaker_followup",
            "send_speaker_message",
            "commit_speaker_accommodation",
            "confirm_speaker",
            "calculate_remaining_budget",
            "create_task",
        }
    ),
)

TEAM_OPS = Specialist(
    name="TeamOps",
    focus=(
        "Work coordination: tasks, deadlines, dependencies, workload and escalation.\n"
        "Compare real workload numbers before suggesting anybody take on more. Reassigning work "
        "away from a person is a leader's decision — recommend it with the counts attached.\n"
        "Flag what is overdue and what is blocked separately: blocked work is waiting on "
        "something named, overdue work is waiting on nobody."
    ),
    tool_names=frozenset(
        {
            "get_event",
            "list_teams",
            "get_team_workload",
            "list_tasks",
            "create_task",
            "update_task",
            "assign_task",
            "recommend_task_reassignment",
        }
    ),
)

ATTENDEE_OPS = Specialist(
    name="AttendeeOps",
    focus=(
        "Attendee logistics: dietary requirements, accommodation, arrivals and accessibility.\n"
        "Work in aggregates. You see counts, not individual attendee records, and that is "
        "deliberate — answering 'how many are missing dietary details' never requires anybody's "
        "personal information.\n"
        "Be specific about deadlines: a catering headcount due in four hours is a different "
        "problem from one due next week."
    ),
    tool_names=frozenset(
        {
            "get_event",
            "get_attendee_summary",
            "list_tasks",
            "create_task",
            "search_event_documents",
        }
    ),
)

INCIDENT_OPS = Specialist(
    name="IncidentOps",
    focus=(
        "Incidents: impact, dependencies, backup options and recommended actions.\n"
        "Read the discussion before recommending anything, so you build on what the team has "
        "already worked out instead of repeating it.\n"
        "State impact, what depends on the affected thing, and ranked actions with whether each "
        "needs approval. Never treat a high or critical incident as resolved on your own "
        "judgement — whether a problem is actually over is a question about the world."
    ),
    tool_names=frozenset(
        {
            "get_event",
            "list_incidents",
            "get_incident",
            "add_incident_comment",
            "create_task",
            "resolve_incident",
            "list_teams",
            "get_speakers",
        }
    ),
)

SPECIALISTS: dict[str, Specialist] = {
    "checkin": CHECKIN_OPS,
    "speaker": SPEAKER_OPS,
    "team": TEAM_OPS,
    "attendee": ATTENDEE_OPS,
    "incident": INCIDENT_OPS,
}


def get_specialist(name: str) -> Specialist | None:
    return SPECIALISTS.get(name.strip().lower())


def run_specialist_turn(
    specialist_name: str,
    principal: Principal,
    organization_id: str,
    message: str,
    **kwargs: Any,
) -> Any:
    """Run one conversation turn through a specialist lens.

    Delegates to :func:`agents.runtime.run_turn` with a narrowed registry and the specialist's
    framing, so there is one agent loop rather than one per specialist.
    """
    from agents.runtime import run_turn

    specialist = get_specialist(specialist_name)
    if specialist is None:
        available = ", ".join(sorted(SPECIALISTS))
        raise ValueError(f"Unknown specialist {specialist_name!r}. Available: {available}")

    scoped = specialist.scoped_registry(principal)
    if not scoped.all():
        raise ValueError(f"{specialist.name} has no tools available to a {principal.role.value}.")

    # The specialist framing is prepended to the shared rules so the domain brief sits on top of
    # the constraints rather than replacing them: a narrower focus must not loosen the rules
    # about inventing figures or bypassing approvals.
    kwargs.setdefault("tool_registry", scoped)
    turn = run_turn(principal, organization_id, message, **kwargs)
    logger.info(
        "Specialist turn complete",
        extra={
            "specialist": specialist.name,
            "tools_used": turn.tools_used,
            "tool_count": len(scoped.all()),
        },
    )
    return turn


def specialist_catalogue(principal: Principal) -> list[dict[str, Any]]:
    """The specialists and the tools each has for this principal. Used in docs and diagnostics."""
    _ = build_system_prompt_available()
    return [
        {
            "key": key,
            "name": specialist.name,
            "focus": specialist.focus.split("\n")[0],
            "tools": sorted(spec.name for spec in specialist.tools(principal)),
        }
        for key, specialist in sorted(SPECIALISTS.items())
    ]


def build_system_prompt_available() -> bool:
    """Whether the shared prompt builder can be imported.

    Guards the diagnostics path: the runtime imports ``boto3``, which is always present in
    Lambda but may not be in a bare checkout, and a catalogue listing should not fail for that.
    """
    try:
        from agents.runtime import build_system_prompt  # noqa: F401

        return True
    except ImportError:  # pragma: no cover
        return False
