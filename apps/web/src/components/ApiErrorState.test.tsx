/**
 * ApiErrorState — the rendering half of the console's response to a failed API
 * request (requirements 1.8, 1.9, 13.4, 13.6).
 *
 * Two things it adds to `ErrorState`, and both are structural rather than
 * cosmetic:
 *
 *   - a 401 renders **nothing**, so a page that stores the failure and renders it
 *     anyway still shows no notification on the way back to sign-in;
 *   - `POLICY_REQUIRES_APPROVAL` carries the link to Approvals, because the
 *     sentence names a place.
 *
 * Everything else is `ErrorState`'s and is covered by its own suite; what is
 * checked here is that adopting this component changes none of it.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { ApiError } from "../api";
import { APPROVALS_PATH } from "../navConfig";
import { ApiErrorState } from "./ApiErrorState";
import type { ApiErrorStateProps } from "./ApiErrorState";

function renderState(props: ApiErrorStateProps) {
  return render(
    <MemoryRouter>
      <ApiErrorState {...props} />
    </MemoryRouter>,
  );
}

describe("ApiErrorState", () => {
  it("renders nothing for an expired session (requirement 1.8)", () => {
    const { container } = renderState({
      error: new ApiError("expired", 401, "UNAUTHORIZED"),
      onRetry: vi.fn(),
    });

    // No alert, no copy, no retry: the route guard is already returning the
    // visitor to sign-in, and a notification would blame them for a token clock.
    expect(container).toBeEmptyDOMElement();
  });

  it("states the forbidden copy and offers no retry (requirement 1.9)", () => {
    renderState({ error: new ApiError("denied", 403, "FORBIDDEN"), onRetry: vi.fn() });

    expect(
      screen.getByText("You don't have access to this organization's data."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("states the missing-record copy (requirement 13.4)", () => {
    renderState({ error: new ApiError("gone", 404, "NOT_FOUND"), onRetry: vi.fn() });

    expect(
      screen.getByText("We couldn't find that record. It may have been removed."),
    ).toBeInTheDocument();
    // Refreshing the surrounding list is `useApiFailure`'s half of the response;
    // re-running the failed request would be a retry loop.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("hands the user the way to Approvals (requirement 13.6)", () => {
    renderState({ error: new ApiError("held", 202, "POLICY_REQUIRES_APPROVAL") });

    expect(
      screen.getByText("CommunityOps needs your approval before this can proceed."),
    ).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "Go to Approvals" });
    expect(link).toHaveAttribute("href", APPROVALS_PATH);
  });

  it("keeps the caller's own safe content alongside that link", () => {
    renderState({
      error: new ApiError("held", 202, "POLICY_REQUIRES_APPROVAL"),
      children: <p>Two registrations match this name.</p>,
    });

    expect(screen.getByText("Two registrations match this name.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Approvals" })).toBeInTheDocument();
  });

  it("adds no link to a failure that is not waiting on a decision", () => {
    renderState({ error: new ApiError("boom", 500, "INTERNAL_ERROR"), onRetry: vi.fn() });

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("retries only the failed request, exactly as ErrorState does", async () => {
    const retry = vi.fn();
    renderState({ error: new ApiError("boom", 500, "INTERNAL_ERROR"), onRetry: retry });

    expect(screen.getByText("CommunityOps couldn't load this view.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("renders no part of the failure the backend reported", () => {
    const { container } = renderState({
      error: new ApiError(
        "DynamoDBException at Object.handler (/var/task/index.js:42) " +
          "arn:aws:dynamodb:ap-south-1:123456789012:table/CommunityOpsEvents",
        500,
        "INTERNAL_ERROR",
      ),
      onRetry: vi.fn(),
    });

    for (const fragment of ["arn:aws", "123456789012", "DynamoDB", "index.js", "/var/task"]) {
      expect(container.innerHTML).not.toContain(fragment);
    }
  });
});
