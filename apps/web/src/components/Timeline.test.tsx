/**
 * `Timeline` behaviour: chronological order, actor attribution as text, and the
 * shared relative-time formatter with the absolute timestamp beside it.
 *
 * Audit Log behaviour (day grouping, actor filters, load more) belongs to the
 * Audit Log task; this file stays with the component's own contract.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Timeline, type TimelineEntry } from "./Timeline";

const NOW = new Date("2025-03-12T10:00:00.000Z");

/* Deliberately not in chronological order: the component owns the ordering. */
const ENTRIES: TimelineEntry[] = [
  {
    id: "AUD-2",
    timestamp: "2025-03-12T08:00:00.000Z",
    actor: { kind: "person", name: "priya@example.org" },
    action: "Middle — approval decided",
  },
  {
    id: "AUD-3",
    timestamp: "2025-03-11T10:00:00.000Z",
    actor: { kind: "system", name: "scheduler" },
    action: "Oldest — reminder scheduled",
  },
  {
    id: "AUD-1",
    timestamp: "2025-03-12T09:55:00.000Z",
    actor: { kind: "agent", name: "speaker_followup_agent" },
    action: "Newest — follow-up sent",
  },
];

/** The entry labels in rendered order. */
function renderedOrder(): (string | undefined)[] {
  return screen.getAllByRole("listitem").map((item) => {
    const text = item.textContent ?? "";

    return ["Newest", "Middle", "Oldest"].find((label) => text.includes(label));
  });
}

describe("Timeline", () => {
  it("orders entries newest first regardless of the order it is given", () => {
    render(<Timeline entries={ENTRIES} label="Activity" now={NOW} />);

    expect(screen.getByRole("list", { name: "Activity" })).toBeInTheDocument();
    expect(renderedOrder()).toEqual(["Newest", "Middle", "Oldest"]);
  });

  it("honours oldest-first when the caller asks for it", () => {
    render(<Timeline entries={ENTRIES} order="oldest-first" now={NOW} />);

    expect(renderedOrder()).toEqual(["Oldest", "Middle", "Newest"]);
  });

  it("attributes every entry in text and pairs relative time with the exact value", () => {
    render(<Timeline entries={ENTRIES} now={NOW} />);

    expect(screen.getByText("CommunityOps")).toBeInTheDocument();
    expect(screen.getByText("Person")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();

    const relative = screen.getByText("5 minutes ago");

    expect(relative).toHaveAttribute("datetime", "2025-03-12T09:55:00.000Z");
    expect(relative).toHaveAttribute("title", expect.stringContaining("2025"));
  });

  it("renders the caller's empty content when there is nothing to show", () => {
    render(<Timeline entries={[]} emptyContent="No activity recorded yet." now={NOW} />);

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByText("No activity recorded yet.")).toBeInTheDocument();
  });
});
