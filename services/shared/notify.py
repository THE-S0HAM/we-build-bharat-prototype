"""Notification creation.

Notifications are the mechanism by which operational state reaches a person who is not
currently looking at the console. They are deliberately kept useful rather than
decorative: each one is addressed to a specific user, carries the identifiers needed to
navigate straight to the thing it describes, and is only created where somebody has to act
or would otherwise be surprised.

Failure is non-fatal, for the same reason audit writes are: a notification that could not
be stored must not roll back the task assignment or approval decision that prompted it.
The operation succeeded; the person just has to find out by looking. An exception here
would turn a cosmetic problem into a lost mutation.
"""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any

from services.shared.dynamodb import DynamoDBError, DynamoDBRepository
from services.shared.keys import notification_prefix, notification_sk, user_gsi2pk
from services.shared.models.base import utc_now
from services.shared.models.notification import NotificationSeverity, NotificationType

logger = logging.getLogger(__name__)

MAIN_TABLE = os.environ.get("MAIN_TABLE", "CommunityOps-Main-dev")

# Default severity per notification type, so callers do not each decide how alarming an
# overdue task is and end up disagreeing.
DEFAULT_SEVERITY: dict[NotificationType, NotificationSeverity] = {
    NotificationType.APPROVAL_REQUESTED: NotificationSeverity.ATTENTION,
    NotificationType.APPROVAL_DECIDED: NotificationSeverity.INFO,
    NotificationType.TASK_ASSIGNED: NotificationSeverity.INFO,
    NotificationType.TASK_OVERDUE: NotificationSeverity.WARNING,
    NotificationType.INCIDENT_REPORTED: NotificationSeverity.WARNING,
    NotificationType.INCIDENT_UPDATED: NotificationSeverity.INFO,
    NotificationType.AGENT_RECOMMENDATION: NotificationSeverity.ATTENTION,
    NotificationType.SPEAKER_RESPONSE: NotificationSeverity.INFO,
    NotificationType.BUDGET_WARNING: NotificationSeverity.WARNING,
}


def notify(
    organization_id: str,
    user_id: str,
    notification_type: NotificationType,
    title: str,
    *,
    body: str = "",
    event_id: str = "",
    resource_type: str = "",
    resource_id: str = "",
    severity: NotificationSeverity | None = None,
    actor_id: str = "system",
    table_name: str | None = None,
) -> str | None:
    """Create one notification. Returns its id, or ``None`` if it could not be stored.

    A missing ``user_id`` is skipped silently rather than raising: unassigned work has
    nobody to notify, and that is a normal state, not an error the caller should handle.
    """
    if not user_id or not organization_id:
        return None

    notification_id = f"NTF-{uuid.uuid4().hex[:8]}"
    now = utc_now().isoformat()
    resolved_severity = severity or DEFAULT_SEVERITY.get(
        notification_type, NotificationSeverity.INFO
    )

    try:
        repo = DynamoDBRepository(table_name or MAIN_TABLE)
        repo.put_item(
            organization_id,
            notification_sk(user_id, notification_id),
            {
                "entity_type": "NOTIFICATION",
                "notification_id": notification_id,
                "user_id": user_id,
                "event_id": event_id,
                "type": notification_type.value,
                "severity": resolved_severity.value,
                "title": title[:300],
                "body": body[:2000],
                "resource_type": resource_type,
                "resource_id": resource_id,
                "is_read": False,
                "created_at": now,
                "updated_at": now,
                "created_by": actor_id,
                "updated_by": actor_id,
                # Indexed per user rather than per event: an inbox is read by its owner,
                # across every event they are involved in.
                "GSI2PK": user_gsi2pk(organization_id, user_id),
                "GSI2SK": f"NOTIF#{now}",
            },
        )
        return notification_id
    except DynamoDBError:
        logger.warning(
            "Could not store notification; the originating operation still succeeded",
            extra={"organization_id": organization_id, "type": notification_type.value},
            exc_info=True,
        )
        return None


def notify_many(
    organization_id: str,
    user_ids: list[str],
    notification_type: NotificationType,
    title: str,
    **kwargs: Any,
) -> list[str]:
    """Notify several users, skipping duplicates.

    De-duplicated because a leader who is also the team lead on the affected team would
    otherwise receive the same notification twice for one event.
    """
    created: list[str] = []
    for user_id in dict.fromkeys(uid for uid in user_ids if uid):
        notification_id = notify(organization_id, user_id, notification_type, title, **kwargs)
        if notification_id:
            created.append(notification_id)
    return created


def list_notifications(
    organization_id: str,
    user_id: str,
    *,
    unread_only: bool = False,
    limit: int = 50,
    table_name: str | None = None,
) -> list[dict[str, Any]]:
    """Read a user's notifications, newest first."""
    repo = DynamoDBRepository(table_name or MAIN_TABLE)
    items = repo.query_all(
        organization_id, notification_prefix(user_id), max_items=max(limit * 4, 200)
    )
    if unread_only:
        items = [n for n in items if not n.get("is_read")]
    items.sort(key=lambda n: str(n.get("created_at", "")), reverse=True)
    return items[:limit]


def mark_read(
    organization_id: str,
    user_id: str,
    notification_id: str,
    *,
    table_name: str | None = None,
) -> bool:
    """Mark one notification read. Returns False when it does not exist.

    The sort key is derived from ``user_id``, so a caller can only ever mark their own
    notifications read — there is no key that would reach somebody else's inbox.
    """
    repo = DynamoDBRepository(table_name or MAIN_TABLE)
    sk = notification_sk(user_id, notification_id)
    if repo.get_item(organization_id, sk) is None:
        return False
    now = utc_now().isoformat()
    repo.update_item(organization_id, sk, {"is_read": True, "read_at": now, "updated_at": now})
    return True


def mark_all_read(organization_id: str, user_id: str, *, table_name: str | None = None) -> int:
    """Mark every unread notification read. Returns how many changed."""
    repo = DynamoDBRepository(table_name or MAIN_TABLE)
    unread = [
        n
        for n in repo.query_all(organization_id, notification_prefix(user_id), max_items=500)
        if not n.get("is_read")
    ]
    now = utc_now().isoformat()
    for notification in unread:
        repo.update_item(
            organization_id,
            notification_sk(user_id, str(notification.get("notification_id", ""))),
            {"is_read": True, "read_at": now, "updated_at": now},
        )
    return len(unread)
