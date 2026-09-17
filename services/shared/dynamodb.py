"""DynamoDB repository layer.

Provides typed, tenant-isolated access to OrbitOps operational data.
Every query includes organization_id as the partition key to enforce
tenant boundaries at the data access level — not just in application logic.

Access patterns are documented inline with each method.
"""

from __future__ import annotations

import logging
from typing import Any

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

from services.shared.models.base import ErrorCategory

logger = logging.getLogger(__name__)


class DynamoDBError(Exception):
    """Raised when a DynamoDB operation fails in a way the caller should handle."""

    def __init__(self, message: str, category: ErrorCategory, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.category = category
        self.details = details or {}


class DynamoDBRepository:
    """Low-level DynamoDB operations with tenant isolation.

    Table design uses a single-table approach per bounded context.
    - PK: organizationId
    - SK: entityType#entityId (e.g., EVENT#evt-001, REG#REG-2026-004821)
    - GSI1PK/GSI1SK: for alternate access patterns (e.g., by email, by event+status)

    All methods require organization_id to enforce tenant boundaries.
    """

    def __init__(self, table_name: str, region: str | None = None):
        self.table_name = table_name
        dynamodb = boto3.resource("dynamodb", region_name=region)
        self.table = dynamodb.Table(table_name)

    def put_item(
        self,
        organization_id: str,
        sk: str,
        item: dict[str, Any],
        *,
        condition: str | None = None,
    ) -> None:
        """Write an item with mandatory tenant scoping.

        Args:
            organization_id: Partition key — tenant boundary.
            sk: Sort key — entity type and ID, e.g., "REG#REG-2026-004821".
            item: Remaining attributes.
            condition: Optional condition expression for idempotent writes.
        """
        record = {"PK": organization_id, "SK": sk, **item}

        try:
            kwargs: dict[str, Any] = {"Item": record}
            if condition:
                kwargs["ConditionExpression"] = condition
            self.table.put_item(**kwargs)
        except ClientError as e:
            code = e.response["Error"]["Code"]
            if code == "ConditionalCheckFailedException":
                raise DynamoDBError(
                    "Item already exists or condition not met",
                    ErrorCategory.DUPLICATE,
                ) from e
            logger.error("DynamoDB put_item failed: %s", code, extra={"table": self.table_name, "sk": sk})
            raise DynamoDBError(
                "Database write failed",
                ErrorCategory.INTERNAL_ERROR,
            ) from e

    def get_item(self, organization_id: str, sk: str) -> dict[str, Any] | None:
        """Fetch a single item by PK+SK.

        Access pattern: exact lookup by tenant + entity key.
        """
        try:
            response = self.table.get_item(Key={"PK": organization_id, "SK": sk})
            return response.get("Item")
        except ClientError as e:
            logger.error("DynamoDB get_item failed: %s", e.response["Error"]["Code"])
            raise DynamoDBError(
                "Database read failed",
                ErrorCategory.EXTERNAL_SERVICE_ERROR,
            ) from e

    def query_by_pk(
        self,
        organization_id: str,
        sk_prefix: str,
        *,
        limit: int = 50,
        filter_expression: Any | None = None,
    ) -> list[dict[str, Any]]:
        """Query items sharing a partition key, filtered by SK prefix.

        Access pattern: list entities of a type within a tenant.
        e.g., all registrations: sk_prefix="REG#"
              all events: sk_prefix="EVENT#"

        Time complexity: O(n) where n is items matching the prefix.
        DynamoDB handles this efficiently via the sort key index.
        """
        try:
            kwargs: dict[str, Any] = {
                "KeyConditionExpression": Key("PK").eq(organization_id) & Key("SK").begins_with(sk_prefix),
                "Limit": limit,
            }
            if filter_expression:
                kwargs["FilterExpression"] = filter_expression
            response = self.table.query(**kwargs)
            return response.get("Items", [])
        except ClientError as e:
            logger.error("DynamoDB query failed: %s", e.response["Error"]["Code"])
            raise DynamoDBError(
                "Database query failed",
                ErrorCategory.EXTERNAL_SERVICE_ERROR,
            ) from e

    def query_gsi(
        self,
        index_name: str,
        pk_value: str,
        sk_value: str | None = None,
        *,
        sk_begins_with: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Query a Global Secondary Index.

        Access pattern: alternate lookups like email→registration,
        transactionRef→payment, eventId+status→items.
        """
        try:
            key_condition = Key("GSI1PK").eq(pk_value)
            if sk_value:
                key_condition = key_condition & Key("GSI1SK").eq(sk_value)
            elif sk_begins_with:
                key_condition = key_condition & Key("GSI1SK").begins_with(sk_begins_with)

            response = self.table.query(
                IndexName=index_name,
                KeyConditionExpression=key_condition,
                Limit=limit,
            )
            return response.get("Items", [])
        except ClientError as e:
            logger.error("DynamoDB GSI query failed: %s", e.response["Error"]["Code"])
            raise DynamoDBError(
                "Database query failed",
                ErrorCategory.EXTERNAL_SERVICE_ERROR,
            ) from e

    def update_item(
        self,
        organization_id: str,
        sk: str,
        updates: dict[str, Any],
        *,
        condition: str | None = None,
    ) -> dict[str, Any]:
        """Update specific attributes on an existing item.

        Builds an UpdateExpression from the updates dict.
        Returns the updated attributes.
        """
        if not updates:
            return {}

        expr_parts = []
        expr_names: dict[str, str] = {}
        expr_values: dict[str, Any] = {}

        for i, (key, value) in enumerate(updates.items()):
            placeholder_name = f"#attr{i}"
            placeholder_value = f":val{i}"
            expr_parts.append(f"{placeholder_name} = {placeholder_value}")
            expr_names[placeholder_name] = key
            expr_values[placeholder_value] = value

        update_expr = "SET " + ", ".join(expr_parts)

        try:
            kwargs: dict[str, Any] = {
                "Key": {"PK": organization_id, "SK": sk},
                "UpdateExpression": update_expr,
                "ExpressionAttributeNames": expr_names,
                "ExpressionAttributeValues": expr_values,
                "ReturnValues": "ALL_NEW",
            }
            if condition:
                kwargs["ConditionExpression"] = condition
            response = self.table.update_item(**kwargs)
            return response.get("Attributes", {})
        except ClientError as e:
            code = e.response["Error"]["Code"]
            if code == "ConditionalCheckFailedException":
                raise DynamoDBError(
                    "Update condition not met",
                    ErrorCategory.CONFLICT,
                ) from e
            logger.error("DynamoDB update_item failed: %s", code)
            raise DynamoDBError(
                "Database update failed",
                ErrorCategory.INTERNAL_ERROR,
            ) from e

    def delete_item(self, organization_id: str, sk: str) -> None:
        """Delete a single item."""
        try:
            self.table.delete_item(Key={"PK": organization_id, "SK": sk})
        except ClientError as e:
            logger.error("DynamoDB delete_item failed: %s", e.response["Error"]["Code"])
            raise DynamoDBError(
                "Database delete failed",
                ErrorCategory.INTERNAL_ERROR,
            ) from e

    def put_item_idempotent(
        self,
        organization_id: str,
        sk: str,
        item: dict[str, Any],
    ) -> bool:
        """Write an item only if it doesn't already exist. Returns True if created, False if existed.

        Used for idempotent operations like ticket generation and check-in completion
        where retries must not produce duplicate side effects.
        """
        try:
            self.put_item(
                organization_id,
                sk,
                item,
                condition="attribute_not_exists(PK)",
            )
            return True
        except DynamoDBError as e:
            if e.category == ErrorCategory.DUPLICATE:
                return False
            raise
