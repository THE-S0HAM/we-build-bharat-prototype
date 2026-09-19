/**
 * Structural sanity checks for the page title zone: the single `<h1>`
 * (requirement 15.1), the single primary action slot (requirement 12.11) and
 * the product name in the document title (requirement 3.1).
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
  it("renders the title as the only level-one heading", () => {
    render(<PageHeader title="Approvals" context="Faisla aapka." />);

    const headings = screen.getAllByRole("heading", { level: 1 });

    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("Approvals");
    expect(screen.getByText("Faisla aapka.")).toBeInTheDocument();
  });

  it("writes the page title and the product name into the document title", () => {
    render(<PageHeader title="Audit Log" />);

    expect(document.title).toBe("Audit Log · CommunityOps");
  });

  it("omits the context line and the action when they are not supplied", () => {
    render(<PageHeader title="Check-In" />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Check-In");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders the one primary action it is given", () => {
    render(<PageHeader title="Speakers" action={<button type="button">Add speaker</button>} />);

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add speaker" })).toBeInTheDocument();
  });
});
