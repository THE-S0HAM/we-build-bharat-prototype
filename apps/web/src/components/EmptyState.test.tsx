/**
 * EmptyState carries the copy the calling view specifies (requirement 13.2).
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders the caller's copy and its single action", async () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="Abhi koi drama nahi."
        description="CommunityOps is keeping things moving."
        action={{ label: "Review speakers", onClick }}
      />,
    );

    expect(screen.getByText("Abhi koi drama nahi.")).toBeInTheDocument();
    expect(screen.getByText("CommunityOps is keeping things moving.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Review speakers" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders no action when the view has none", () => {
    render(<EmptyState title="No incidents yet." />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
