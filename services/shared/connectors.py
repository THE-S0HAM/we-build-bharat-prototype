"""Connector abstractions for external system integration.

The platform must integrate with existing registration, payment,
and communication systems without redesigning the core application.
These abstract base classes define the interface; concrete implementations
can target DynamoDB (internal), REST APIs, PostgreSQL, or any external system.

For MVP, DynamoDB implementations serve as the "internal" connectors.
External system connectors can be swapped in via configuration.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


@dataclass
class LookupResult:
    """Standard result for connector lookups.

    success=False with error_category set means the lookup itself failed
    (e.g., external service timeout), not that the entity wasn't found.
    An empty data list with success=True means "looked up successfully, nothing found."
    """

    success: bool
    data: list[dict[str, Any]]
    error_category: str | None = None
    error_message: str | None = None


class RegistrationConnector(ABC):
    """Interface for registration data lookups.

    Implementations might target:
    - DynamoDB (OrbitOps internal)
    - PostgreSQL (external event platform)
    - REST API (third-party registration SaaS)
    - CSV import (offline data)
    """

    @abstractmethod
    def lookup_by_id(self, org_id: str, event_id: str, registration_id: str) -> LookupResult:
        """Exact lookup by registration ID. Should return 0 or 1 result."""
        ...

    @abstractmethod
    def lookup_by_email(self, org_id: str, event_id: str, email: str) -> LookupResult:
        """Lookup by attendee email. May return multiple results."""
        ...

    @abstractmethod
    def lookup_by_phone(self, org_id: str, event_id: str, phone: str) -> LookupResult:
        """Lookup by attendee phone. May return multiple results."""
        ...

    @abstractmethod
    def lookup_by_name(self, org_id: str, event_id: str, name: str) -> LookupResult:
        """Fuzzy lookup by name. May return multiple candidates.

        Implementation should use case-insensitive partial matching.
        Multiple results require volunteer to provide additional identifiers.
        """
        ...


class PaymentConnector(ABC):
    """Interface for payment/transaction lookups.

    Only collects transaction/reference IDs — never card numbers,
    CVVs, PINs, or banking credentials.
    """

    @abstractmethod
    def lookup_by_transaction_id(self, org_id: str, event_id: str, transaction_id: str) -> LookupResult:
        """Lookup payment by transaction reference."""
        ...

    @abstractmethod
    def lookup_by_payer_email(self, org_id: str, event_id: str, email: str) -> LookupResult:
        """Lookup payments by payer email. May return multiple."""
        ...


class CommunicationConnector(ABC):
    """Interface for sending communications (email, SMS, etc.)."""

    @abstractmethod
    def send_email(
        self,
        to_email: str,
        subject: str,
        body_text: str,
        body_html: str | None = None,
        *,
        from_email: str | None = None,
    ) -> bool:
        """Send a single email. Returns True if accepted for delivery."""
        ...


class CalendarConnector(ABC):
    """Interface for calendar/scheduling operations."""

    @abstractmethod
    def check_availability(self, event_id: str, speaker_id: str, proposed_time: str) -> LookupResult:
        """Check if a time slot is available for a speaker."""
        ...

    @abstractmethod
    def create_session(self, event_id: str, session_data: dict[str, Any]) -> LookupResult:
        """Create a session/time slot in the event calendar."""
        ...
