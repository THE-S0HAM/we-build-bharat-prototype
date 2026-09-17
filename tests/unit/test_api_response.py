"""Tests for API response helpers."""

import json

from services.shared.api_response import error, success, _category_to_status
from services.shared.models.base import ErrorCategory


class TestSuccess:
    def test_success_returns_200(self) -> None:
        resp = success({"data": "value"})
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        assert body["data"] == "value"

    def test_success_custom_status(self) -> None:
        resp = success({"id": "123"}, status_code=201)
        assert resp["statusCode"] == 201

    def test_success_has_cors_headers(self) -> None:
        resp = success({})
        assert "Access-Control-Allow-Origin" in resp["headers"]


class TestError:
    def test_not_found_returns_404(self) -> None:
        resp = error(ErrorCategory.NOT_FOUND, "Not found")
        assert resp["statusCode"] == 404
        body = json.loads(resp["body"])
        assert body["error"] == "NOT_FOUND"
        assert body["message"] == "Not found"

    def test_validation_error_returns_400(self) -> None:
        resp = error(ErrorCategory.VALIDATION_ERROR, "Invalid input")
        assert resp["statusCode"] == 400

    def test_policy_requires_approval_returns_202(self) -> None:
        resp = error(ErrorCategory.POLICY_REQUIRES_APPROVAL, "Needs approval")
        assert resp["statusCode"] == 202

    def test_external_service_error_returns_502(self) -> None:
        resp = error(ErrorCategory.EXTERNAL_SERVICE_ERROR, "Service unavailable")
        assert resp["statusCode"] == 502

    def test_error_with_details(self) -> None:
        resp = error(
            ErrorCategory.AMBIGUOUS_MATCH,
            "Multiple matches",
            details={"candidates": ["REG-001", "REG-002"]},
        )
        body = json.loads(resp["body"])
        assert body["details"]["candidates"] == ["REG-001", "REG-002"]
