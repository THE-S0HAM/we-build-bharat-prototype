"""Consistent API response helpers for Lambda handlers.

Every API response follows the same shape so the frontend
can rely on a predictable contract.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from services.shared.models.base import ErrorCategory, ErrorResponse

logger = logging.getLogger(__name__)

# Standard CORS headers for API Gateway responses
CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
}


def success(body: dict[str, Any] | list[Any], status_code: int = 200) -> dict[str, Any]:
    """Return a successful API response."""
    return {
        "statusCode": status_code,
        "headers": CORS_HEADERS,
        "body": json.dumps(body, default=str),
    }


def error(
    category: ErrorCategory,
    message: str,
    status_code: int | None = None,
    request_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return a structured error response.

    Maps ErrorCategory to HTTP status codes. User-facing message
    must be safe — no internal details, stack traces, or secrets.
    """
    code = status_code or _category_to_status(category)
    response = ErrorResponse(
        error=category,
        message=message,
        request_id=request_id,
        details=details,
    )
    return {
        "statusCode": code,
        "headers": CORS_HEADERS,
        "body": response.model_dump_json(),
    }


def _category_to_status(category: ErrorCategory) -> int:
    """Map error categories to appropriate HTTP status codes."""
    mapping = {
        ErrorCategory.VALIDATION_ERROR: 400,
        ErrorCategory.NOT_FOUND: 404,
        ErrorCategory.AMBIGUOUS_MATCH: 409,
        ErrorCategory.UNAUTHORIZED: 401,
        ErrorCategory.FORBIDDEN: 403,
        ErrorCategory.EXTERNAL_SERVICE_ERROR: 502,
        ErrorCategory.TIMEOUT: 504,
        ErrorCategory.CONFLICT: 409,
        ErrorCategory.DUPLICATE: 409,
        ErrorCategory.POLICY_REQUIRES_APPROVAL: 202,
        ErrorCategory.INTERNAL_ERROR: 500,
    }
    return mapping.get(category, 500)
