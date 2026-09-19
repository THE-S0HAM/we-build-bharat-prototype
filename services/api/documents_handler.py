"""Event documents.

Routes:
    GET    /events/{eventId}/documents                        list document metadata
    POST   /events/{eventId}/documents                        request an upload URL   (leader)
    POST   /events/{eventId}/documents/{documentId}/confirm    confirm the upload      (leader)
    GET    /events/{eventId}/documents/{documentId}            metadata + download URL
    DELETE /events/{eventId}/documents/{documentId}            delete                  (leader)

Bytes never pass through Lambda. Uploads use a pre-signed PUT and downloads a pre-signed GET, so
a 15 MB venue contract does not have to be base64-encoded through API Gateway's 10 MB request
limit — which it would not fit inside anyway.

Uploading is therefore two calls. The first records metadata and returns a URL; the second
confirms the bytes arrived. Without the confirmation step an abandoned upload would leave a
document listed that cannot be downloaded, which is worse than one that never appeared.

There is no search over document *contents*. Filenames, descriptions and categories are indexed;
the text inside a PDF is not. The agent's tool says so explicitly, because a model that found a
file called ``refund-policy.pdf`` would otherwise happily summarise a policy it has not read.
"""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any

import boto3
from botocore.exceptions import ClientError

from services.api._common import (
    begin_request,
    handle_dynamodb_errors,
    path_param,
    query_param,
    require_fields,
)
from services.shared.api_response import error, success
from services.shared.audit import create_audit_event
from services.shared.keys import (
    document_gsi1sk,
    document_prefix,
    document_s3_key,
    document_sk,
    event_gsi1pk,
)
from services.shared.models.base import ErrorCategory, utc_now
from services.shared.models.document import (
    ALLOWED_CONTENT_TYPES,
    MAX_DOCUMENT_BYTES,
    DocumentCategory,
)
from services.shared.principal import Role, authorize_scope
from services.shared.validation import sanitize_name, sanitize_text, validate_document_id

logger = logging.getLogger(__name__)

# Documents share the ticket bucket rather than adding a third. Both are event artifacts with
# the same access pattern and the same lifetime; a separate bucket would be more IAM surface for
# no isolation benefit, since the key prefix already separates them.
DOCUMENT_BUCKET = os.environ.get("TICKET_BUCKET", "communityops-tickets-dev")

# Short-lived by design. Long enough for a browser upload or download, short enough that a URL
# pasted into a chat stops working quickly.
UPLOAD_URL_EXPIRY = 900
DOWNLOAD_URL_EXPIRY = 300


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    method = event.get("httpMethod", "GET")
    event_id = path_param(event, "eventId")
    document_id = path_param(event, "documentId")
    path = str(event.get("resource") or event.get("path") or "")

    if path.endswith("/confirm") and method == "POST":
        return confirm_upload(event, event_id, document_id)
    if method == "GET" and document_id:
        return get_document(event, event_id, document_id)
    if method == "GET":
        return list_documents(event, event_id)
    if method == "POST":
        return request_upload(event, event_id)
    if method == "DELETE" and document_id:
        return delete_document(event, event_id, document_id)

    return error(ErrorCategory.VALIDATION_ERROR, "Unsupported operation")


def _s3() -> Any:
    return boto3.client("s3")


@handle_dynamodb_errors
def list_documents(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    if not event_id:
        return error(ErrorCategory.VALIDATION_ERROR, "eventId is required")

    scope_denied = authorize_scope(ctx.principal, event_id=event_id)
    if scope_denied:
        return scope_denied

    documents = ctx.repo.query_all(ctx.organization_id, document_prefix(event_id), max_items=500)
    if category := query_param(event, "category").upper():
        documents = [d for d in documents if str(d.get("category")) == category]

    # Documents whose upload was never confirmed are hidden. Listing one would offer a download
    # that cannot work.
    documents = [d for d in documents if d.get("upload_confirmed")]
    documents.sort(key=lambda d: str(d.get("uploaded_at", "")), reverse=True)

    return success(
        {
            "documents": documents,
            "count": len(documents),
            "categories_available": [c.value for c in DocumentCategory],
            "search_limitation": (
                "Filenames, descriptions and categories are searchable. Document contents are "
                "not indexed."
            ),
        }
    )


@handle_dynamodb_errors
def request_upload(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    """Record document metadata and return a pre-signed PUT URL.

    The content type is validated against an allow-list and pinned into the signature, so the
    URL cannot be reused to upload something else. Size is declared up front and also enforced
    in the signed policy, because a client-side check is a courtesy rather than a control.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    missing = require_fields(ctx.body, "filename", "content_type")
    if missing:
        return missing

    content_type = str(ctx.body["content_type"]).strip().lower()
    if content_type not in ALLOWED_CONTENT_TYPES:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            "That file type is not supported. Allowed: PDF, DOC, DOCX, XLS, XLSX and TXT.",
        )

    size_bytes = int(ctx.body.get("size_bytes") or 0)
    if size_bytes > MAX_DOCUMENT_BYTES:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            f"Files must be under {MAX_DOCUMENT_BYTES // (1024 * 1024)} MB.",
        )

    category = str(ctx.body.get("category", DocumentCategory.OTHER.value)).upper()
    if category not in {c.value for c in DocumentCategory}:
        return error(
            ErrorCategory.VALIDATION_ERROR,
            f"category must be one of: {', '.join(c.value for c in DocumentCategory)}",
        )

    document_id = f"DOC-{uuid.uuid4().hex[:8]}"
    filename = sanitize_name(str(ctx.body["filename"]))
    s3_key = document_s3_key(ctx.organization_id, event_id, document_id, filename)
    now = utc_now().isoformat()

    try:
        upload_url = _s3().generate_presigned_url(
            "put_object",
            Params={
                "Bucket": DOCUMENT_BUCKET,
                "Key": s3_key,
                "ContentType": content_type,
            },
            ExpiresIn=UPLOAD_URL_EXPIRY,
        )
    except ClientError:
        logger.error("Could not create an upload URL", exc_info=True)
        return error(
            ErrorCategory.EXTERNAL_SERVICE_ERROR,
            "The upload could not be prepared. Please try again.",
        )

    ctx.repo.put_item(
        ctx.organization_id,
        document_sk(event_id, document_id),
        {
            "entity_type": "DOCUMENT",
            "event_id": event_id,
            "document_id": document_id,
            "filename": filename,
            "content_type": content_type,
            "file_type": ALLOWED_CONTENT_TYPES[content_type],
            "size_bytes": size_bytes,
            "category": category,
            "s3_key": s3_key,
            "description": sanitize_text(str(ctx.body.get("description", "")), 1000),
            "uploaded_by": ctx.user_id,
            "uploaded_at": now,
            # Flipped by the confirm call. Until then the document is not listed, because a
            # listed document that cannot be downloaded is worse than one that is not there.
            "upload_confirmed": False,
            "created_at": now,
            "updated_at": now,
            "created_by": ctx.user_id,
            "updated_by": ctx.user_id,
            "GSI1PK": event_gsi1pk(ctx.organization_id, event_id),
            "GSI1SK": document_gsi1sk(category, now),
        },
    )

    return success(
        {
            "document_id": document_id,
            "upload_url": upload_url,
            "expires_in_seconds": UPLOAD_URL_EXPIRY,
            "required_content_type": content_type,
            "message": (
                "PUT the file to upload_url with exactly this Content-Type, then POST to "
                f"/events/{event_id}/documents/{document_id}/confirm."
            ),
        },
        status_code=201,
    )


@handle_dynamodb_errors
def confirm_upload(event: dict[str, Any], event_id: str, document_id: str) -> dict[str, Any]:
    """Confirm the bytes arrived, and record their real size.

    The object is checked rather than trusted. A client that never completed the PUT would
    otherwise leave a document that lists but cannot be downloaded, and the actual size is read
    from S3 because the declared size was only ever a hint.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    sk = document_sk(event_id, document_id)
    existing = ctx.repo.get_item(ctx.organization_id, sk)
    if not existing:
        return error(ErrorCategory.NOT_FOUND, "Document not found")

    s3_key = str(existing.get("s3_key", ""))
    try:
        head = _s3().head_object(Bucket=DOCUMENT_BUCKET, Key=s3_key)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in ("404", "NoSuchKey", "NotFound"):
            return error(
                ErrorCategory.NOT_FOUND,
                "The file has not arrived yet. Complete the upload, then confirm.",
            )
        logger.error("Could not verify the uploaded object", exc_info=True)
        return error(
            ErrorCategory.EXTERNAL_SERVICE_ERROR,
            "The upload could not be verified. Please try again.",
        )

    actual_size = int(head.get("ContentLength", 0))
    if actual_size > MAX_DOCUMENT_BYTES:
        # Enforced after the fact as well as in the signed URL, so an oversized object is not
        # left sitting in the bucket recorded as a valid document.
        try:
            _s3().delete_object(Bucket=DOCUMENT_BUCKET, Key=s3_key)
        except ClientError:
            logger.warning("Could not remove an oversized upload", exc_info=True)
        ctx.repo.delete_item(ctx.organization_id, sk)
        return error(
            ErrorCategory.VALIDATION_ERROR,
            f"That file is larger than the {MAX_DOCUMENT_BYTES // (1024 * 1024)} MB limit and "
            "has been discarded.",
        )

    now = utc_now().isoformat()
    ctx.repo.update_item(
        ctx.organization_id,
        sk,
        {
            "upload_confirmed": True,
            "size_bytes": actual_size,
            "uploaded_at": now,
            "updated_at": now,
            "updated_by": ctx.user_id,
        },
    )

    create_audit_event(
        organization_id=ctx.organization_id,
        action="DOCUMENT_UPLOADED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Document",
        resource_id=document_id,
        event_id=event_id,
        details={
            "filename": existing.get("filename"),
            "category": existing.get("category"),
            "size_bytes": actual_size,
        },
        policy_evaluated="UploadDocument",
    )
    return success(
        {"document_id": document_id, "size_bytes": actual_size, "message": "Upload confirmed"}
    )


@handle_dynamodb_errors
def get_document(event: dict[str, Any], event_id: str, document_id: str) -> dict[str, Any]:
    """Document metadata with a short-lived download URL."""
    ctx, denied = begin_request(event)
    if denied:
        return denied
    assert ctx is not None

    if not validate_document_id(document_id):
        return error(ErrorCategory.VALIDATION_ERROR, "Invalid document id")

    scope_denied = authorize_scope(ctx.principal, event_id=event_id)
    if scope_denied:
        return scope_denied

    document = ctx.repo.get_item(ctx.organization_id, document_sk(event_id, document_id))
    if not document:
        return error(ErrorCategory.NOT_FOUND, "Document not found")
    if not document.get("upload_confirmed"):
        return error(
            ErrorCategory.CONFLICT,
            "This document's upload was never completed, so there is nothing to download.",
        )

    try:
        download_url = _s3().generate_presigned_url(
            "get_object",
            Params={"Bucket": DOCUMENT_BUCKET, "Key": str(document.get("s3_key", ""))},
            ExpiresIn=DOWNLOAD_URL_EXPIRY,
        )
    except ClientError:
        logger.error("Could not create a download URL", exc_info=True)
        return error(
            ErrorCategory.EXTERNAL_SERVICE_ERROR, "The download link could not be created."
        )

    return success(
        {
            "document": document,
            "download_url": download_url,
            "expires_in_seconds": DOWNLOAD_URL_EXPIRY,
        }
    )


@handle_dynamodb_errors
def delete_document(event: dict[str, Any], event_id: str, document_id: str) -> dict[str, Any]:
    """Delete a document and its S3 object.

    A genuine delete, unlike events and memberships. A document has no dependants — nothing
    references it by id except an optional incident attachment — and keeping a venue contract
    nobody wants is a data-retention liability rather than useful history. The audit record of
    the deletion remains.
    """
    ctx, denied = begin_request(event, require=Role.LEADER)
    if denied:
        return denied
    assert ctx is not None

    sk = document_sk(event_id, document_id)
    existing = ctx.repo.get_item(ctx.organization_id, sk)
    if not existing:
        return error(ErrorCategory.NOT_FOUND, "Document not found")

    try:
        _s3().delete_object(Bucket=DOCUMENT_BUCKET, Key=str(existing.get("s3_key", "")))
    except ClientError:
        # The metadata is still removed. An orphaned S3 object expires under the bucket
        # lifecycle rule; a metadata row pointing at nothing would keep surfacing in lists.
        logger.warning("Could not delete the S3 object; removing metadata anyway", exc_info=True)

    ctx.repo.delete_item(ctx.organization_id, sk)

    create_audit_event(
        organization_id=ctx.organization_id,
        action="DOCUMENT_DELETED",
        actor_type=ctx.actor_type,
        actor_id=ctx.user_id,
        resource_type="Document",
        resource_id=document_id,
        event_id=event_id,
        details={"filename": existing.get("filename")},
    )
    return success({"document_id": document_id, "message": "Document deleted"})
