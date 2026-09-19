/**
 * Infrastructure check for the component test environment.
 *
 * Proves that a test file can render through @testing-library/react into a real
 * DOM, query it, and assert with the jest-dom matchers. Component behaviour is
 * covered by the tests that live beside each component.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("component test environment", () => {
  it("renders into a DOM that can be queried", () => {
    render(<h1>CommunityOps</h1>);

    expect(screen.getByRole("heading", { name: "CommunityOps" })).toBeInTheDocument();
  });
});
