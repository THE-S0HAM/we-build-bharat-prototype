/**
 * ErrorState — the two guarantees that matter (requirement 13.3, correctness
 * property 7). The full behaviour matrix for the shared components lands with
 * the later test tasks; these cover retry scoping and leak safety, using the
 * real `ApiError` the API client throws.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import { ErrorState } from "./ErrorState";

/** Every enumerated leak of design.md §12.1 in one backend message. */
const LEAKY_MESSAGE =
  "DynamoDBException: arn:aws:dynamodb:ap-south-1:123456789012:table/CommunityOpsEvents " +
  "at Object.handler (/var/task/index.js:42) request_id=9f1c0b4e-7a2d-4c3b-8e15-0b6d5a4f3c2e";

const LEAK_FRAGMENTS = [
  "arn:aws",
  "123456789012",
  "DynamoDB",
  "Exception",
  "CommunityOpsEvents",
  "index.js",
  "/var/task",
  "9f1c0b4e",
  "request_id",
];

describe("ErrorState", () => {
  it("renders the approved copy and retries only the failed request", async () => {
    const retry = vi.fn();
    render(
      <ErrorState error={new ApiError("boom", 500, "INTERNAL_ERROR")} onRetry={retry} />,
    );

    expect(screen.getByText("CommunityOps couldn't load this view.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("renders no part of the failure the backend reported", () => {
    const { container } = render(
      <ErrorState
        error={new ApiError(LEAKY_MESSAGE, 500, "INTERNAL_ERROR")}
        onRetry={vi.fn()}
      />,
    );

    // innerHTML, not textContent: an attribute is as visible as a text node to
    // anything reading the DOM.
    for (const fragment of LEAK_FRAGMENTS) {
      expect(container.innerHTML).not.toContain(fragment);
    }
  });

  it("refuses caller copy that carries internal detail", () => {
    // The rejected string goes to the browser console for the developer and
    // nowhere else, so the spy is what keeps it out of the suite output too.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(<ErrorState message={LEAKY_MESSAGE} error={new ApiError("boom", 500)} />);

    expect(screen.getByText("CommunityOps couldn't load this view.")).toBeInTheDocument();
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });

  it("words a failed attempt differently from a view that did not load", () => {
    const upstream = new ApiError("bad gateway", 502, "EXTERNAL_SERVICE_ERROR");
    const { rerender } = render(<ErrorState error={upstream} />);

    expect(screen.getByText("CommunityOps couldn't load this view.")).toBeInTheDocument();

    rerender(<ErrorState error={upstream} context="action" />);

    expect(screen.getByText("CommunityOps couldn't complete that just now.")).toBeInTheDocument();
  });

  it("withholds Try again when re-running the request cannot help", () => {
    render(
      <ErrorState error={new ApiError("denied", 403, "FORBIDDEN")} onRetry={vi.fn()} />,
    );

    expect(screen.getByText("You don't have access to this organization's data.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
