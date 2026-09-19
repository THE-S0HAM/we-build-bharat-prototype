/**
 * The one mapping from a failure to what the console says and does about it
 * (requirements 1.8, 1.9, 13.3, 13.4, 13.6, 13.7; design.md §12).
 *
 * This module is the single table, so these checks are the place the specified
 * rows are pinned down: the copy for each category, which categories may be
 * retried, and which carry a behaviour a presentational component cannot perform.
 * `ErrorState`, `ApiErrorState` and `useApiFailure` all read this table, so a row
 * verified here is verified for every surface at once.
 *
 * The last block is the leak guarantee stated over the whole table rather than
 * over one rendering: no sentence the console can show may look like machine
 * output, and no caller-supplied string that does may survive the gate.
 */

import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import {
  CATEGORY_POLICY,
  approvedMessage,
  failurePolicy,
  logConfigurationDetail,
  resolveCategory,
  toApprovedCopy,
  type ErrorCategory,
} from "./errorCategory";
import { unionValues } from "../test/unionValues";

/**
 * Every category, as a table the compiler checks: a category added to the
 * product is a compile error here until it is listed, which is what stops this
 * suite silently falling behind the contract.
 */
const ALL_CATEGORIES = unionValues<ErrorCategory>({
  VALIDATION_ERROR: true,
  NOT_FOUND: true,
  AMBIGUOUS_MATCH: true,
  CONFLICT: true,
  DUPLICATE: true,
  UNAUTHORIZED: true,
  FORBIDDEN: true,
  POLICY_REQUIRES_APPROVAL: true,
  EXTERNAL_SERVICE_ERROR: true,
  TIMEOUT: true,
  INTERNAL_ERROR: true,
  CONFIGURATION_ERROR: true,
});

describe("resolveCategory", () => {
  it("reads the category the backend sent", () => {
    expect(resolveCategory(new ApiError("denied", 403, "FORBIDDEN"))).toBe("FORBIDDEN");
  });

  it("falls back to the status when no category came with the failure", () => {
    // A raw `fetch` rejection or a response with no `error` field.
    expect(resolveCategory({ status: 401 })).toBe("UNAUTHORIZED");
    expect(resolveCategory({ status: 404 })).toBe("NOT_FOUND");
    expect(resolveCategory({ status: 202 })).toBe("POLICY_REQUIRES_APPROVAL");
    expect(resolveCategory({ status: 504 })).toBe("TIMEOUT");
  });

  it("prefers the category over the status when they disagree", () => {
    // The category is the backend's own classification; the status map exists
    // only for failures that arrive without one.
    expect(resolveCategory(new ApiError("x", 500, "CONFIGURATION_ERROR"))).toBe(
      "CONFIGURATION_ERROR",
    );
  });

  it("lands every unrecognised value on the safe default", () => {
    for (const value of [undefined, null, "", "not-a-category", 42, new Error("boom"), {}]) {
      expect(resolveCategory(value)).toBe("INTERNAL_ERROR");
    }
  });
});

describe("the specified rows of design.md §12", () => {
  it("ends the session on a 401 and offers no retry (requirement 1.8)", () => {
    const policy = failurePolicy(new ApiError("expired", 401, "UNAUTHORIZED"));

    expect(policy.endsSession).toBe(true);
    expect(policy.retryable).toBe(false);
  });

  it("states the forbidden copy with no retry (requirement 1.9)", () => {
    const policy = failurePolicy(new ApiError("denied", 403, "FORBIDDEN"));

    expect(approvedMessage(policy, "view")).toBe(
      "You don't have access to this organization's data.",
    );
    expect(policy.retryable).toBe(false);
    expect(policy.endsSession).toBe(false);
  });

  it("refreshes the affected list on a missing record (requirement 13.4)", () => {
    const policy = failurePolicy(new ApiError("gone", 404, "NOT_FOUND"));

    expect(approvedMessage(policy, "view")).toBe(
      "We couldn't find that record. It may have been removed.",
    );
    expect(policy.refreshesList).toBe(true);
    expect(policy.retryable).toBe(false);
  });

  it("links to Approvals when the work is waiting on a decision (requirement 13.6)", () => {
    const policy = failurePolicy(new ApiError("held", 202, "POLICY_REQUIRES_APPROVAL"));

    expect(approvedMessage(policy, "view")).toBe(
      "CommunityOps needs your approval before this can proceed.",
    );
    expect(policy.linksToApprovals).toBe(true);
  });

  it("keeps configuration detail to the browser console (requirement 13.7)", () => {
    const policy = failurePolicy(new ApiError("no API URL", 0, "CONFIGURATION_ERROR"));

    expect(approvedMessage(policy, "view")).toBe("This console isn't configured yet.");
    expect(policy.logsDetail).toBe(true);
    expect(policy.retryable).toBe(false);
  });

  it("offers a retry for the transient failures and only for those (requirement 13.3)", () => {
    const retryable = ALL_CATEGORIES.filter((category) => CATEGORY_POLICY[category].retryable);

    expect(retryable).toEqual(["EXTERNAL_SERVICE_ERROR", "TIMEOUT", "INTERNAL_ERROR"]);
  });

  it("writes the failure itself to the console and returns nothing renderable", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new ApiError("arn:aws:lambda:ap-south-1:123456789012:function:Api", 0);

    // The failure is handed to `console.error` rather than returned, so the
    // detail never becomes a value a caller could hold and render.
    expect(logConfigurationDetail(failure)).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toBe(failure);

    error.mockRestore();
  });
});

describe("no user-facing sentence looks like machine output", () => {
  /** The enumerated leaks of design.md §12.1 and requirement 16.7. */
  const MACHINE_SHAPES: readonly RegExp[] = [
    /arn:/i,
    /\b\d{12}\b/,
    /(?:exception|traceback)\b/i,
    /\bat\s+\S+\s*\(/,
    /\.(?:js|ts|tsx|py)\b/i,
    /\b(?:aws|lambda|dynamodb|cognito|apigateway)\b/i,
    /https?:\/\//i,
    /request[\s_-]?id/i,
    /[{}]/,
  ];

  it("holds for every sentence in the table", () => {
    for (const category of ALL_CATEGORIES) {
      const policy = CATEGORY_POLICY[category];

      for (const sentence of [policy.message, policy.actionMessage ?? policy.message]) {
        expect(sentence).not.toBe("");

        for (const shape of MACHINE_SHAPES) {
          expect(sentence, `${category}: ${sentence}`).not.toMatch(shape);
        }
      }
    }
  });

  it("refuses a caller string of any of those shapes and keeps the reviewed one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const approved = "CommunityOps couldn't load this view.";

    const refused = [
      "DynamoDBException: item not found",
      "arn:aws:dynamodb:ap-south-1:123456789012:table/CommunityOpsEvents",
      "at Object.handler (/var/task/index.js:42)",
      "request_id=9f1c0b4e-7a2d-4c3b-8e15-0b6d5a4f3c2e",
      "GET /events/EVT-1/speakers failed",
      "Request failed (HTTP 500)",
      '{"error":"INTERNAL_ERROR"}',
      "https://api.example.com/events",
    ];

    for (const candidate of refused) {
      expect(toApprovedCopy(candidate, approved)).toBe(approved);
    }

    // Product copy passes through, and so does the fallback for an absent or
    // blank candidate.
    expect(toApprovedCopy("Demo access is temporarily unavailable.", approved)).toBe(
      "Demo access is temporarily unavailable.",
    );
    expect(toApprovedCopy(undefined, approved)).toBe(approved);
    expect(toApprovedCopy("   ", approved)).toBe(approved);

    warn.mockRestore();
  });
});
