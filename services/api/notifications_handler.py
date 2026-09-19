"""Notifications for the signed-in user.

Routes:
    GET  /notifications                             the caller's notifications
    PUT  /notifications/{notificationId}/read       mark one read
    PUT  /notifications/read-all                    mark everything read

There is no route for reading somebody else's inbox, and no way to construct one: notification
sort keys are built from the caller's own user id, so the isolation is structural rather than a
filter that could be forgotten.
"""

from __future__ import annotations

import logging
from typing import Any

from services.api._common import begin_request, handle_dynamodb_errors, path_param, query_param
from services.shared.api_response import error, success
from services.shared.models.base import ErrorCategory
from services.shared.notify import list_notifications, mark_all_read, mark_read
from services.shared.validation import validate_notification_id

logger = logging.getLogger(__name__)


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    method = event.get("httpMethod", "GET")
    path = str(event.get("resource") or event.get("path") or "")

    if method == "GET":
        return list_for_caller(event)
    if method == "PUT" and path.endswith("/read-all"):
        return mark_everything_read(event)
    if method == "PUT":
        return mark_one_read(event, path_param(event, "notificationId"))

    return error(ErrorCategory.VALIDATION_ERROR, "Unsupported operation")


@handle_dynamodb_errors
def list_for_caller(event: dict[str, Any]) -> dict[str, Any]:
    ctx, denied = begin_request(event, load_scope=False)
    if denied:
        return denied
    assert ctx is not None

    unread_only = query_param(event, "unread_only").lower() in ("true", "1", "yes")
    items = list_notifications(
        ctx.organization_id,
        ctx.user_id,
        unread_only=unread_only,
        table_name=ctx.repo.table_name,
    )
    return success(
        {
            "notifications": items,
            "count": len(items),
            "unread_count": sum(1 for n in items if not n.get("is_read")),
        }
    )


@handle_dynamodb_errors
def mark_one_read(event: dict[str, Any], notification_id: str) -> dict[str, Any]:
    ctx, denied = begin_request(event, load_scope=False)
    if denied:
        return denied
    assert ctx is not None

    if not validate_notification_id(notification_id):
        return error(ErrorCategory.VALIDATION_ERROR, "Invalid notification id")

    if not mark_read(
        ctx.organization_id, ctx.user_id, notification_id, table_name=ctx.repo.table_name
    ):
        # Either it does not exist or it belongs to somebody else. The same answer for both,
        # so this route cannot be used to discover that another user has a given notification.
        return error(ErrorCategory.NOT_FOUND, "Notification not found")

    return success({"notification_id": notification_id, "is_read": True})


@handle_dynamodb_errors
def mark_everything_read(event: dict[str, Any]) -> dict[str, Any]:
    ctx, denied = begin_request(event, load_scope=False)
    if denied:
        return denied
    assert ctx is not None

    count = mark_all_read(ctx.organization_id, ctx.user_id, table_name=ctx.repo.table_name)
    return success({"marked_read": count})
