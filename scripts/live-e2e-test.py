#!/usr/bin/env python3
"""Live end-to-end validation against the deployed CommunityOps AWS stack.

Authenticates to Cognito (SRP), then exercises the deployed API Gateway +
Lambda + DynamoDB + S3 path. Every assertion below reflects a real HTTP call
to the deployed API. Nothing here uses mocks, local fixtures, or the frontend
mock fallback.

Usage:
    python scripts/live-e2e-test.py --api-url <url> --user-pool-id <id> \
        --client-id <id> --username <email> --password-file <path>

Exit code is 0 only if every scenario passes.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from typing import Any

import boto3

ORG_A = "ORG-wemakedev"
EVENT_A = "EVT-devcon-2026"
ORG_B = "ORG-tenant-b"
EVENT_B = "EVT-tenant-b-summit"
REG_B = "REG-2026-900001"

results: list[tuple[str, bool, str]] = []


def record(name: str, passed: bool, detail: str) -> None:
    results.append((name, passed, detail))
    status = "PASS" if passed else "FAIL"
    print(f"[{status}] {name}: {detail}")  # noqa: T201


def get_id_token(user_pool_id: str, client_id: str, username: str, password: str) -> str:
    from pycognito import Cognito

    u = Cognito(user_pool_id, client_id, username=username)
    u.authenticate(password=password)
    return u.id_token


def reset_state(table_name: str, region: str, registration_id: str) -> None:
    """Return the demo dataset to its pre-check-in state.

    This is test setup, not product behaviour: it uses the operator's own AWS
    credentials to clear the side effects a previous run left behind so the
    happy path can be exercised from a known starting point. Without it a
    second run reports the already-checked-in and already-decided states, which
    are correct responses but not what the happy-path assertions describe.
    """
    table = boto3.resource("dynamodb", region_name=region).Table(table_name)

    for sk in (
        f"EVENT#{EVENT_A}#TICKET#{registration_id}",
        f"EVENT#{EVENT_A}#CHECKIN#{registration_id}",
    ):
        table.delete_item(Key={"PK": ORG_A, "SK": sk})

    table.update_item(
        Key={"PK": ORG_A, "SK": f"EVENT#{EVENT_A}#REG#{registration_id}"},
        UpdateExpression="SET is_checked_in = :f",
        ExpressionAttributeValues={":f": False},
    )

    # Approvals are listed via GSI1 with an "APPROVAL#PENDING" sort-key prefix,
    # so the sort key has to be restored alongside the status field.
    for approval_id in ("APR-001", "APR-002"):
        key = {"PK": ORG_A, "SK": f"EVENT#{EVENT_A}#APPROVAL#{approval_id}"}
        existing = table.get_item(Key=key).get("Item", {})
        requested_at = existing.get("requested_at", "")
        table.update_item(
            Key=key,
            UpdateExpression=(
                "SET #s = :p, GSI1SK = :sk REMOVE decided_by, decided_at, decision_notes"
            ),
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":p": "PENDING",
                ":sk": f"APPROVAL#PENDING#{requested_at}",
            },
        )

    print(f"Reset demo state for {registration_id} and approvals APR-001/APR-002")  # noqa: T201


class Api:
    def __init__(self, base_url: str, token: str):
        self.base = base_url.rstrip("/")
        self.token = token

    def call(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> tuple[int, dict[str, Any]]:
        url = f"{self.base}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", self.token)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                return e.code, json.loads(raw or "{}")
            except json.JSONDecodeError:
                return e.code, {"raw": raw}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--api-url", required=True)
    p.add_argument("--user-pool-id", required=True)
    p.add_argument("--client-id", required=True)
    p.add_argument("--username", required=True)
    p.add_argument("--password-file", required=True)
    p.add_argument("--region", default="ap-south-1")
    p.add_argument("--main-table", default="CommunityOps-Main-dev")
    args = p.parse_args()

    with open(args.password_file) as f:
        password = f.read().strip()

    print("=== Resetting demo state (test setup) ===")  # noqa: T201
    reset_state(args.main_table, args.region, "REG-2026-004821")

    print("\n=== Authenticating to Cognito (SRP) ===")  # noqa: T201
    token = get_id_token(args.user_pool_id, args.client_id, args.username, password)
    record("auth.cognito_srp", bool(token), f"obtained ID token ({len(token)} chars)")
    api = Api(args.api_url, token)

    # ---- Auth enforcement: unauthenticated request must be rejected --------
    unauth = urllib.request.Request(
        f"{args.api_url.rstrip('/')}/events/{EVENT_A}/checkin/search",
        data=json.dumps({"organization_id": ORG_A, "name": "Priya"}).encode(),
        method="POST",
    )
    unauth.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(unauth, timeout=30) as r:
            record("auth.unauthenticated_rejected", False, f"expected 401, got {r.status}")
    except urllib.error.HTTPError as e:
        record("auth.unauthenticated_rejected", e.code == 401, f"HTTP {e.code} as expected")

    # ---- Scenario A: normal recovery --------------------------------------
    print("\n=== Scenario A: normal recovery ===")  # noqa: T201
    st, r = api.call(
        "POST",
        f"/events/{EVENT_A}/checkin/search",
        {"organization_id": ORG_A, "email": "priya.sharma@example.com"},
    )
    found = st == 200 and r.get("found") and r.get("count") == 1
    reg_a = r["registrations"][0]["registration_id"] if found else ""
    record("A.search", found, f"HTTP {st}, registration_id={reg_a}")

    st, r = api.call(
        "POST",
        f"/events/{EVENT_A}/checkin/verify",
        {"organization_id": ORG_A, "registration_id": reg_a},
    )
    v = r.get("verification", {})
    record(
        "A.verify_all_passed",
        st == 200 and v.get("all_passed") is True,
        f"HTTP {st}, all_passed={v.get('all_passed')}, checks={len(v.get('checks', []))}",
    )

    st, r = api.call(
        "POST",
        f"/events/{EVENT_A}/checkin/recover",
        {"organization_id": ORG_A, "registration_id": reg_a},
    )
    ticket_ok = st in (200, 201) and r.get("ticket_id") == reg_a
    record(
        "A.recover_ticket_id_equals_registration_id",
        ticket_ok,
        f"HTTP {st}, ticket_id={r.get('ticket_id')}, already_existed={r.get('already_existed')}",
    )
    record(
        "A.recover_presigned_url",
        bool(r.get("download_url", "").startswith("https://")),
        "pre-signed S3 URL returned",
    )

    st, r = api.call(
        "POST",
        f"/events/{EVENT_A}/checkin/complete",
        {"organization_id": ORG_A, "registration_id": reg_a},
    )
    record(
        "A.complete_checkin",
        st in (200, 201) and r.get("status") == "CHECKED_IN",
        f"HTTP {st}, status={r.get('status')}, was_already={r.get('was_already_checked_in')}",
    )

    # ---- Scenario G: idempotency -----------------------------------------
    print("\n=== Scenario G: idempotency (repeat recover + complete) ===")  # noqa: T201
    st, r2 = api.call(
        "POST",
        f"/events/{EVENT_A}/checkin/recover",
        {"organization_id": ORG_A, "registration_id": reg_a},
    )
    record(
        "G.recover_idempotent",
        st == 200 and r2.get("already_existed") is True,
        f"HTTP {st}, already_existed={r2.get('already_existed')} (no duplicate ticket)",
    )
    st, r3 = api.call(
        "POST",
        f"/events/{EVENT_A}/checkin/complete",
        {"organization_id": ORG_A, "registration_id": reg_a},
    )
    record(
        "G.complete_idempotent",
        st == 200 and r3.get("was_already_checked_in") is True,
        f"HTTP {st}, was_already_checked_in={r3.get('was_already_checked_in')} (no duplicate check-in)",
    )

    # ---- Scenario E: cancelled / refunded --------------------------------
    print("\n=== Scenario E: cancelled + refunded registration ===")  # noqa: T201
    st, r = api.call(
        "POST",
        f"/events/{EVENT_A}/checkin/search",
        {"organization_id": ORG_A, "email": "neha.gupta@example.com"},
    )
    reg_cancelled = r["registrations"][0]["registration_id"] if r.get("found") else ""
    st, r = api.call(
        "POST",
        f"/events/{EVENT_A}/checkin/verify",
        {"organization_id": ORG_A, "registration_id": reg_cancelled},
    )
    v = r.get("verification", {})
    failed = [c["name"] for c in v.get("checks", []) if c["status"] == "FAIL"]
    record(
        "E.cancelled_refunded_rejected",
        st == 200 and v.get("all_passed") is False and len(failed) >= 2,
        f"HTTP {st}, all_passed={v.get('all_passed')}, failed_checks={failed}",
    )

    # ---- Scenario D: ambiguous match -------------------------------------
    print("\n=== Scenario D: ambiguous match ===")  # noqa: T201
    st, r = api.call(
        "POST",
        f"/events/{EVENT_A}/checkin/search",
        {"organization_id": ORG_A, "name": "Amit Kumar"},
    )
    record(
        "D.ambiguous_requires_disambiguation",
        st == 200 and r.get("requires_disambiguation") is True and r.get("count", 0) > 1,
        f"HTTP {st}, count={r.get('count')}, requires_disambiguation={r.get('requires_disambiguation')}",
    )
    masked = all("***" in c.get("attendee_email", "") for c in r.get("registrations", []))
    record("D.candidate_emails_masked", masked, "candidate emails masked in response")

    # ---- Scenario B: payment reconciliation ------------------------------
    print("\n=== Scenario B: payment-reference reconciliation ===")  # noqa: T201
    st, r = api.call(
        "POST",
        f"/events/{EVENT_A}/checkin/reconcile",
        {"organization_id": ORG_A, "transaction_id": "TXN-KH-78902"},
    )
    record(
        "B.reconcile_success",
        st == 200 and r.get("reconciled") is True and r.get("registration_id") == "REG-2026-004822",
        f"HTTP {st}, reconciled={r.get('reconciled')}, linked={r.get('registration_id')}",
    )

    # ---- Scenario C: unresolved (no match) -------------------------------
    print("\n=== Scenario C: unresolvable -> recovery case ===")  # noqa: T201
    st, r = api.call(
        "POST",
        f"/events/{EVENT_A}/checkin/reconcile",
        {"organization_id": ORG_A, "transaction_id": "TXN-DOES-NOT-EXIST-0001"},
    )
    record(
        "C.unresolved_no_false_success",
        st == 200 and r.get("reconciled") is False and r.get("recovery_case_created") is True,
        f"HTTP {st}, reconciled={r.get('reconciled')}, recovery_case_created={r.get('recovery_case_created')}",
    )

    # ---- Scenario: refunded payment reconciliation -----------------------
    st, r = api.call(
        "POST",
        f"/events/{EVENT_A}/checkin/reconcile",
        {"organization_id": ORG_A, "transaction_id": "TXN-KH-78905"},
    )
    record(
        "C2.refunded_payment_not_reconciled",
        st == 200 and r.get("reconciled") is False,
        f"HTTP {st}, reconciled={r.get('reconciled')} (REFUNDED payment correctly refused)",
    )

    # ---- Scenario: orphan payment (no linked registration) ---------------
    st, r = api.call(
        "POST",
        f"/events/{EVENT_A}/checkin/reconcile",
        {"organization_id": ORG_A, "transaction_id": "TXN-KH-78999"},
    )
    record(
        "C3.orphan_payment_not_guessed",
        st == 200 and r.get("reconciled") is False and r.get("recovery_case_created") is True,
        f"HTTP {st}, reconciled={r.get('reconciled')} (unlinked payment not guessed)",
    )

    # ---- Not-found registration ------------------------------------------
    st, r = api.call(
        "POST",
        f"/events/{EVENT_A}/checkin/search",
        {"organization_id": ORG_A, "email": "nobody@example.com"},
    )
    record(
        "F1.not_found_is_not_error",
        st == 200 and r.get("found") is False and r.get("count") == 0,
        f"HTTP {st}, found={r.get('found')} (distinguished from service failure)",
    )

    # ---- Validation errors ------------------------------------------------
    st, r = api.call("POST", f"/events/{EVENT_A}/checkin/search", {"organization_id": ORG_A})
    record(
        "F2.missing_search_field_validation",
        st == 400 and r.get("error") == "VALIDATION_ERROR",
        f"HTTP {st}, error={r.get('error')}",
    )

    st, r = api.call(
        "POST",
        f"/events/{EVENT_A}/checkin/verify",
        {"organization_id": ORG_A, "registration_id": "REG-9999-999999"},
    )
    record(
        "F3.nonexistent_registration_404",
        st == 404 and r.get("error") == "NOT_FOUND",
        f"HTTP {st}, error={r.get('error')}",
    )

    # ---- QR verification: tampered payload must be rejected --------------
    print("\n=== QR signature verification ===")  # noqa: T201
    ddb = boto3.resource("dynamodb", region_name=args.region).Table(args.main_table)
    item = ddb.get_item(Key={"PK": ORG_A, "SK": f"EVENT#{EVENT_A}#TICKET#{reg_a}"}).get("Item", {})
    stored_payload = item.get("qr_payload")
    stored_sig = item.get("qr_signature")
    record(
        "QR.signature_persisted",
        bool(stored_sig),
        f"qr_signature stored in Ticket record ({'present' if stored_sig else 'MISSING'})",
    )

    if stored_payload:
        st, r = api.call(
            "POST",
            f"/events/{EVENT_A}/checkin/verify-qr",
            {"organization_id": ORG_A, "event_id": EVENT_A, "qr_payload": stored_payload},
        )
        record(
            "QR.valid_payload_accepted",
            st == 200 and r.get("valid") is True,
            f"HTTP {st}, valid={r.get('valid')}",
        )

        tampered = json.loads(stored_payload)
        tampered["r"] = "REG-2026-004822"
        st, r = api.call(
            "POST",
            f"/events/{EVENT_A}/checkin/verify-qr",
            {
                "organization_id": ORG_A,
                "event_id": EVENT_A,
                "qr_payload": json.dumps(tampered, separators=(",", ":"), sort_keys=True),
            },
        )
        record(
            "QR.tampered_payload_rejected",
            st in (403, 404),
            f"HTTP {st}, error={r.get('error')} (forged payload refused)",
        )
    else:
        record(
            "QR.live_end_to_end",
            False,
            "qr_payload is NOT persisted in the Ticket record, so verify-qr cannot be "
            "exercised server-side without decoding the PDF QR image",
        )

    # ---- Cross-tenant isolation ------------------------------------------
    print("\n=== Multi-tenant isolation ===")  # noqa: T201
    st, r = api.call(
        "POST",
        f"/events/{EVENT_B}/checkin/search",
        {"organization_id": ORG_B, "registration_id": REG_B},
    )
    leaked = st == 200 and r.get("found") is True
    record(
        "T1.cross_tenant_read_blocked",
        not leaked,
        f"HTTP {st}, found={r.get('found')} — Org A token requested Org B data"
        + (" (LEAK: returned Org B registration)" if leaked else " (no data returned)"),
    )

    st, r = api.call("GET", f"/command-center?organization_id={ORG_B}")
    leaked_cc = st == 200 and r.get("summary", {}).get("total_events", 0) > 0
    record(
        "T2.cross_tenant_command_center_blocked",
        not leaked_cc,
        f"HTTP {st}, total_events={r.get('summary', {}).get('total_events')} for Org B",
    )

    # ---- Audit trail ------------------------------------------------------
    print("\n=== Audit trail ===")  # noqa: T201
    st, r = api.call("GET", f"/events/{EVENT_A}/audit?organization_id={ORG_A}")
    actions = [a.get("action") for a in r.get("audit_events", [])]
    record(
        "AUD.audit_events_written",
        st == 200 and r.get("count", 0) > 0,
        f"HTTP {st}, count={r.get('count')}, actions={sorted(set(actions))[:6]}",
    )
    record(
        "AUD.checkin_and_ticket_audited",
        any(a in actions for a in ("CHECKIN_COMPLETED", "TICKET_RECOVERED", "TICKET_REGENERATED")),
        "ticket/check-in actions present in audit log",
    )

    # ---- Approvals (human-in-the-loop) -----------------------------------
    print("\n=== Approvals / human-in-the-loop ===")  # noqa: T201
    st, r = api.call("GET", f"/events/{EVENT_A}/approvals?organization_id={ORG_A}")
    approvals = r.get("approvals", [])
    record(
        "HITL.pending_approvals_listed",
        st == 200 and len(approvals) > 0,
        f"HTTP {st}, pending={len(approvals)}, risk_levels={[a.get('risk_level') for a in approvals]}",
    )

    target = next((a for a in approvals if a.get("risk_level") == "HIGH"), None)
    if target:
        aid = target["approval_id"]
        st, r = api.call(
            "PUT",
            f"/events/{EVENT_A}/approvals/{aid}",
            {"organization_id": ORG_A, "decision": "APPROVED", "notes": "live validation"},
        )
        record(
            "HITL.high_risk_approval_decided",
            st == 200,
            f"HTTP {st}, approval {aid} decided by human",
        )
        st, r = api.call(
            "PUT",
            f"/events/{EVENT_A}/approvals/{aid}",
            {"organization_id": ORG_A, "decision": "APPROVED", "notes": "replay"},
        )
        record(
            "HITL.already_decided_conflict",
            st == 409 and r.get("error") == "CONFLICT",
            f"HTTP {st}, error={r.get('error')} (cannot re-decide)",
        )

    st, r = api.call(
        "PUT",
        f"/events/{EVENT_A}/approvals/APR-DOES-NOT-EXIST",
        {"organization_id": ORG_A, "decision": "APPROVED"},
    )
    record(
        "HITL.unknown_approval_fails_closed",
        st in (404, 400),
        f"HTTP {st}, error={r.get('error')} (unknown approval refused)",
    )

    # ---- Read APIs --------------------------------------------------------
    print("\n=== Operational read APIs ===")  # noqa: T201
    for label, path, key in (
        ("speakers", f"/events/{EVENT_A}/speakers?organization_id={ORG_A}", "speakers"),
        ("incidents", f"/events/{EVENT_A}/incidents?organization_id={ORG_A}", "incidents"),
        (
            "tasks",
            f"/events/{EVENT_A}/teams/TEAM-registration/tasks?organization_id={ORG_A}",
            "tasks",
        ),
        ("command_center", f"/command-center?organization_id={ORG_A}", "events"),
    ):
        st, r = api.call("GET", path)
        n = len(r.get(key, []))
        record(f"READ.{label}", st == 200 and n > 0, f"HTTP {st}, {key}={n}")

    # ---- Summary ----------------------------------------------------------
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"\n{'=' * 64}")  # noqa: T201
    print(f"LIVE AWS RESULT: {passed}/{total} checks passed")  # noqa: T201
    print(f"{'=' * 64}")  # noqa: T201
    failures = [(n, d) for n, ok, d in results if not ok]
    if failures:
        print("\nFAILURES:")  # noqa: T201
        for n, d in failures:
            print(f"  - {n}: {d}")  # noqa: T201
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
