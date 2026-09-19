"""DynamoDB repository layer.

Provides typed, tenant-isolated access to CommunityOps operational data.
Every query includes organization_id as the partition key to enforce
tenant boundaries at the data access level — not just in application logic.

Access patterns are documented inline with each method.
"""

from __future__ import annotations

import logging
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from services.shared.models.base import ErrorCategory

logger = logging.getLogger(__name__)


class DynamoDBError(Exception):
    """Raised when a DynamoDB operation fails in a way the caller should handle."""

    def __init__(
        self, message: str, category: ErrorCategory, details: dict[str, Any] | None = None
    ):
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
            logger.error(
                "DynamoDB put_item failed: %s", code, extra={"table": self.table_name, "sk": sk}
            )
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
                "KeyConditionExpression": Key("PK").eq(organization_id)
                & Key("SK").begins_with(sk_prefix),
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

    def atomic_update(
        self,
        organization_id: str,
        sk: str,
        *,
        adds: dict[str, int] | None = None,
        sets: dict[str, Any] | None = None,
        condition: str | None = None,
        condition_values: dict[str, Any] | None = None,
        condition_names: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Increment counters and set attributes in one conditional write.

        ``update_item`` can only emit ``SET``, which makes it read-modify-write for
        anything cumulative: two concurrent callers each read 100, each write 110, and
        one increment vanishes. Money cannot be maintained that way, so this method
        emits DynamoDB's ``ADD`` action, which the storage layer applies atomically.

        ``condition`` guards the invariant. Budget allocation passes
        ``allocated + :amt <= total_budget`` so DynamoDB itself refuses an
        over-allocation; nothing in application code has to win a race to enforce it.
        A failed condition raises ``DynamoDBError`` with ``CONFLICT`` and writes nothing,
        so there is no partial state to unwind.

        Args:
            adds: attribute -> signed delta. Negative values subtract.
            sets: attribute -> new value, applied in the same write.
            condition: raw condition expression. Reference values by the placeholder
                names used as keys in ``condition_values``, and attribute names either
                literally or via ``condition_names`` aliases where a name is a DynamoDB
                reserved word.
            condition_values: placeholder name -> value, e.g. ``{":amt": 5000}``.
                Placeholders are passed through verbatim so the expression stays
                readable at the call site instead of relying on positional indexes.
            condition_names: placeholder name -> attribute name, e.g. ``{"#st": "status"}``.

        Returns:
            All attributes of the item after the update.
        """
        if not adds and not sets:
            return {}

        expr_names: dict[str, str] = dict(condition_names or {})
        expr_values: dict[str, Any] = dict(condition_values or {})
        clauses: list[str] = []

        if sets:
            set_parts = []
            for i, (key, value) in enumerate(sets.items()):
                name_ph = f"#s{i}"
                value_ph = f":s{i}"
                set_parts.append(f"{name_ph} = {value_ph}")
                expr_names[name_ph] = key
                expr_values[value_ph] = value
            clauses.append("SET " + ", ".join(set_parts))

        if adds:
            add_parts = []
            for i, (key, delta) in enumerate(adds.items()):
                name_ph = f"#a{i}"
                value_ph = f":a{i}"
                add_parts.append(f"{name_ph} {value_ph}")
                expr_names[name_ph] = key
                expr_values[value_ph] = delta
            clauses.append("ADD " + ", ".join(add_parts))

        try:
            kwargs: dict[str, Any] = {
                "Key": {"PK": organization_id, "SK": sk},
                "UpdateExpression": " ".join(clauses),
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
                    "The update was refused because it would break a required invariant.",
                    ErrorCategory.CONFLICT,
                    details={"sk": sk},
                ) from e
            logger.error("DynamoDB atomic_update failed: %s", code)
            raise DynamoDBError(
                "Database update failed",
                ErrorCategory.INTERNAL_ERROR,
            ) from e

    def query_page(
        self,
        organization_id: str,
        sk_prefix: str,
        *,
        limit: int = 50,
        cursor: dict[str, Any] | None = None,
        filter_expression: Any | None = None,
    ) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
        """Query one page and return the continuation cursor.

        ``query_by_pk`` takes a ``Limit`` and discards ``LastEvaluatedKey``, so a caller
        that asks for 50 of 300 items gets 50 and no indication the other 250 exist.
        This returns the cursor so callers can either paginate honestly or loop to
        completion with :meth:`query_all`.

        Returns:
            ``(items, cursor)`` where ``cursor`` is ``None`` on the last page.
        """
        try:
            kwargs: dict[str, Any] = {
                "KeyConditionExpression": Key("PK").eq(organization_id)
                & Key("SK").begins_with(sk_prefix),
                "Limit": limit,
            }
            if filter_expression:
                kwargs["FilterExpression"] = filter_expression
            if cursor:
                kwargs["ExclusiveStartKey"] = cursor
            response = self.table.query(**kwargs)
            return response.get("Items", []), response.get("LastEvaluatedKey")
        except ClientError as e:
            logger.error("DynamoDB paged query failed: %s", e.response["Error"]["Code"])
            raise DynamoDBError(
                "Database query failed",
                ErrorCategory.EXTERNAL_SERVICE_ERROR,
            ) from e

    def query_all(
        self,
        organization_id: str,
        sk_prefix: str,
        *,
        filter_expression: Any | None = None,
        max_items: int = 2000,
        page_size: int = 200,
    ) -> list[dict[str, Any]]:
        """Follow the cursor until the prefix is exhausted or ``max_items`` is reached.

        Used by aggregation, where a partial count is worse than a slower one: an event
        health score computed from the first 50 of 300 tasks would be confidently wrong.

        ``max_items`` is a guard, not a target. Hitting it is logged because a silently
        truncated aggregate is exactly the failure this method exists to prevent.
        """
        items: list[dict[str, Any]] = []
        cursor: dict[str, Any] | None = None
        while True:
            page, cursor = self.query_page(
                organization_id,
                sk_prefix,
                limit=page_size,
                cursor=cursor,
                filter_expression=filter_expression,
            )
            items.extend(page)
            if not cursor:
                return items
            if len(items) >= max_items:
                logger.warning(
                    "query_all hit the item ceiling and stopped early",
                    extra={"sk_prefix": sk_prefix, "returned": len(items), "ceiling": max_items},
                )
                return items[:max_items]

    def query_gsi_all(
        self,
        index_name: str,
        pk_value: str,
        *,
        sk_begins_with: str | None = None,
        filter_expression: Any | None = None,
        max_items: int = 2000,
        page_size: int = 200,
    ) -> list[dict[str, Any]]:
        """Exhaustive GSI query, for the same reason as :meth:`query_all`."""
        items: list[dict[str, Any]] = []
        cursor: dict[str, Any] | None = None
        while True:
            try:
                key_condition = Key("GSI1PK" if index_name == "GSI1" else "GSI2PK").eq(pk_value)
                if sk_begins_with:
                    sk_attr = "GSI1SK" if index_name == "GSI1" else "GSI2SK"
                    key_condition = key_condition & Key(sk_attr).begins_with(sk_begins_with)

                kwargs: dict[str, Any] = {
                    "IndexName": index_name,
                    "KeyConditionExpression": key_condition,
                    "Limit": page_size,
                }
                if filter_expression:
                    kwargs["FilterExpression"] = filter_expression
                if cursor:
                    kwargs["ExclusiveStartKey"] = cursor
                response = self.table.query(**kwargs)
            except ClientError as e:
                logger.error("DynamoDB GSI paged query failed: %s", e.response["Error"]["Code"])
                raise DynamoDBError(
                    "Database query failed",
                    ErrorCategory.EXTERNAL_SERVICE_ERROR,
                ) from e

            items.extend(response.get("Items", []))
            cursor = response.get("LastEvaluatedKey")
            if not cursor:
                return items
            if len(items) >= max_items:
                logger.warning(
                    "query_gsi_all hit the item ceiling and stopped early",
                    extra={"index": index_name, "returned": len(items), "ceiling": max_items},
                )
                return items[:max_items]

    def batch_put(self, organization_id: str, items: list[tuple[str, dict[str, Any]]]) -> int:
        """Write many items in batches, returning the number written.

        Seeding and plan generation create dozens of records at once; issuing them one
        request at a time is both slow and needlessly expensive. ``batch_writer``
        handles the 25-item batching and retries unprocessed items for us.

        This is not transactional. A failure part-way leaves earlier items written,
        which is acceptable for seed and plan data because both are idempotent by key.
        Use :meth:`transact_write` where partial application would be incorrect.
        """
        if not items:
            return 0
        try:
            with self.table.batch_writer() as batch:
                for sk, attributes in items:
                    batch.put_item(Item={"PK": organization_id, "SK": sk, **attributes})
            return len(items)
        except ClientError as e:
            logger.error("DynamoDB batch_put failed: %s", e.response["Error"]["Code"])
            raise DynamoDBError(
                "Database batch write failed",
                ErrorCategory.INTERNAL_ERROR,
            ) from e

    def transact_write(self, transact_items: list[dict[str, Any]]) -> None:
        """Apply up to 100 writes atomically, or none of them.

        Used where two records must move together — committing an approval amount onto
        both the event budget and its category allocation, for instance, since a budget
        whose categories do not sum correctly is worse than a rejected write.

        Callers build raw ``TransactWriteItems`` entries because the shapes differ per
        operation; this method exists for the client handling and error mapping.
        """
        if not transact_items:
            return
        try:
            self.table.meta.client.transact_write_items(TransactItems=transact_items)
        except ClientError as e:
            code = e.response["Error"]["Code"]
            if code in ("TransactionCanceledException", "ConditionalCheckFailedException"):
                reasons = e.response.get("CancellationReasons") or []
                failed = [r.get("Code") for r in reasons if r.get("Code") != "None"]
                logger.warning("Transaction cancelled: %s", failed)
                raise DynamoDBError(
                    "The change was refused because it would break a required invariant.",
                    ErrorCategory.CONFLICT,
                    details={"reasons": failed},
                ) from e
            logger.error("DynamoDB transact_write failed: %s", code)
            raise DynamoDBError(
                "Database transaction failed",
                ErrorCategory.INTERNAL_ERROR,
            ) from e
