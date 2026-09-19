/**
 * A loading area announces once and holds the shape of its content
 * (requirement 13.1). The placeholder shapes themselves carry no information,
 * so they stay out of the accessibility tree.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SkeletonTable } from "./Skeleton";

describe("Skeleton", () => {
  it("announces the loading region and hides the placeholder shapes", () => {
    const { container } = render(
      <SkeletonTable rows={3} columns={4} label="Getting the latest speakers…" />,
    );

    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region).toHaveTextContent("Getting the latest speakers…");

    const shapes = container.querySelectorAll(".skeleton");
    // Header row plus three data rows, four columns each.
    expect(shapes).toHaveLength(16);
    for (const shape of shapes) {
      expect(shape).toHaveAttribute("aria-hidden", "true");
    }
  });
});
