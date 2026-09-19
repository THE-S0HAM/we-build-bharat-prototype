"""Event document metadata.

Bytes live in S3; this record is the metadata index. Uploads and downloads both use
pre-signed URLs so document content never passes through Lambda.

There is no retrieval-augmented search over document content. ``search_event_documents``
filters on this metadata only, and the agent is told so, because presenting metadata
filtering as semantic retrieval would misrepresent what the system can answer.
"""

from datetime import datetime
from enum import Enum

from pydantic import Field

from services.shared.models.base import DomainEntity

# Content types the upload path accepts. Anything else is rejected at the boundary
# rather than stored and discovered later.
ALLOWED_CONTENT_TYPES: dict[str, str] = {
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "text/plain": "txt",
}

MAX_DOCUMENT_BYTES = 20 * 1024 * 1024


class DocumentCategory(str, Enum):
    SPEAKER = "SPEAKER"
    VENUE = "VENUE"
    BUDGET = "BUDGET"
    VOLUNTEER = "VOLUNTEER"
    SPONSOR = "SPONSOR"
    POLICY = "POLICY"
    RECEIPT = "RECEIPT"
    OTHER = "OTHER"


class Document(DomainEntity):
    """Metadata for an operational document attached to an event."""

    event_id: str = Field(..., min_length=1)
    document_id: str = Field(..., min_length=1)
    filename: str = Field(..., min_length=1, max_length=300)
    content_type: str = Field(..., min_length=1, max_length=200)
    file_type: str = Field(default="", description="Short extension, e.g. pdf, xlsx")
    size_bytes: int = Field(default=0, ge=0)
    category: DocumentCategory = DocumentCategory.OTHER
    s3_key: str = Field(default="", description="S3 object key holding the bytes")
    description: str = ""
    uploaded_by: str = ""
    uploaded_at: datetime | None = None
