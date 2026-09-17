"""DynamoDB implementations of connector interfaces.

These are the "internal" connectors used when OrbitOps is both the
registration system and the operational layer. For organizations using
an external registration platform (KonfHub, Eventbrite, etc.), a
different connector implementation would be swapped in.
"""

from __future__ import annotations

import logging
import os

from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError

from services.shared.connectors import LookupResult, PaymentConnector, RegistrationConnector
from services.shared.dynamodb import DynamoDBRepository

logger = logging.getLogger(__name__)

MAIN_TABLE = os.environ.get("MAIN_TABLE", "OrbitOps-Main-dev")


class DynamoDBRegistrationConnector(RegistrationConnector):
    """Registration lookups against OrbitOps DynamoDB table.

    Access patterns:
    - By registration ID: PK=orgId, SK=EVENT#{eventId}#REG#{regId}
    - By email: GSI1PK=orgId#eventId, GSI1SK=EMAIL#{email}
    - By phone: scan with filter (infrequent, fallback path)
    - By name: scan with filter (fuzzy, returns candidates)
    """

    def __init__(self, table_name: str | None = None):
        self.repo = DynamoDBRepository(table_name or MAIN_TABLE)

    def lookup_by_id(self, org_id: str, event_id: str, registration_id: str) -> LookupResult:
        """Exact lookup — O(1) via PK+SK."""
        try:
            item = self.repo.get_item(org_id, f"EVENT#{event_id}#REG#{registration_id}")
            if item:
                return LookupResult(success=True, data=[item])
            return LookupResult(success=True, data=[])
        except Exception as e:
            logger.error("Registration lookup by ID failed: %s", str(e))
            return LookupResult(
                success=False,
                data=[],
                error_category="EXTERNAL_SERVICE_ERROR",
                error_message="Registration system is currently unavailable. Booking could not be verified.",
            )

    def lookup_by_email(self, org_id: str, event_id: str, email: str) -> LookupResult:
        """Lookup via GSI — email is indexed for fast retrieval."""
        try:
            items = self.repo.query_gsi(
                index_name="GSI1",
                pk_value=f"{org_id}#{event_id}",
                sk_value=f"EMAIL#{email.lower().strip()}",
            )
            return LookupResult(success=True, data=items)
        except Exception as e:
            logger.error("Registration lookup by email failed: %s", str(e))
            return LookupResult(
                success=False,
                data=[],
                error_category="EXTERNAL_SERVICE_ERROR",
                error_message="Registration system is currently unavailable.",
            )

    def lookup_by_phone(self, org_id: str, event_id: str, phone: str) -> LookupResult:
        """Phone lookup — queries by event prefix then filters.

        Less efficient than email/ID lookup, but phone search is a
        fallback path used infrequently at check-in.
        """
        try:
            items = self.repo.query_by_pk(
                org_id,
                f"EVENT#{event_id}#REG#",
                filter_expression=Attr("attendee_phone").eq(phone.strip()),
                limit=10,
            )
            return LookupResult(success=True, data=items)
        except Exception as e:
            logger.error("Registration lookup by phone failed: %s", str(e))
            return LookupResult(
                success=False,
                data=[],
                error_category="EXTERNAL_SERVICE_ERROR",
                error_message="Registration system is currently unavailable.",
            )

    def lookup_by_name(self, org_id: str, event_id: str, name: str) -> LookupResult:
        """Name-based fuzzy search — queries event registrations, filters by name substring.

        Returns multiple candidates intentionally. The system must
        never auto-select when multiple names match — the volunteer
        provides additional identifying information.

        Implementation uses case-insensitive contains matching.
        For a large event (10k+ attendees), consider a search index.
        """
        try:
            normalized = name.strip().lower()
            items = self.repo.query_by_pk(
                org_id,
                f"EVENT#{event_id}#REG#",
                filter_expression=Attr("attendee_name_lower").contains(normalized),
                limit=20,
            )
            return LookupResult(success=True, data=items)
        except Exception as e:
            logger.error("Registration lookup by name failed: %s", str(e))
            return LookupResult(
                success=False,
                data=[],
                error_category="EXTERNAL_SERVICE_ERROR",
                error_message="Registration system is currently unavailable.",
            )


class DynamoDBPaymentConnector(PaymentConnector):
    """Payment reference lookups against OrbitOps DynamoDB table.

    Access patterns:
    - By transaction ID: GSI1PK=orgId#eventId, GSI1SK=TXN#{transactionId}
    - By payer email: GSI1PK=orgId#eventId, GSI1SK=PAYER#{email}
    """

    def __init__(self, table_name: str | None = None):
        self.repo = DynamoDBRepository(table_name or MAIN_TABLE)

    def lookup_by_transaction_id(self, org_id: str, event_id: str, transaction_id: str) -> LookupResult:
        """Exact transaction lookup via GSI — O(1)."""
        try:
            items = self.repo.query_gsi(
                index_name="GSI1",
                pk_value=f"{org_id}#{event_id}",
                sk_value=f"TXN#{transaction_id.strip()}",
            )
            return LookupResult(success=True, data=items)
        except Exception as e:
            logger.error("Payment lookup by transaction ID failed: %s", str(e))
            return LookupResult(
                success=False,
                data=[],
                error_category="EXTERNAL_SERVICE_ERROR",
                error_message="Payment system is currently unavailable. Transaction could not be verified.",
            )

    def lookup_by_payer_email(self, org_id: str, event_id: str, email: str) -> LookupResult:
        """Lookup payments by payer email via GSI."""
        try:
            items = self.repo.query_gsi(
                index_name="GSI1",
                pk_value=f"{org_id}#{event_id}",
                sk_begins_with=f"PAYER#{email.lower().strip()}",
            )
            return LookupResult(success=True, data=items)
        except Exception as e:
            logger.error("Payment lookup by email failed: %s", str(e))
            return LookupResult(
                success=False,
                data=[],
                error_category="EXTERNAL_SERVICE_ERROR",
                error_message="Payment system is currently unavailable.",
            )
