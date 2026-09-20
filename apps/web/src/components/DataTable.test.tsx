/**
 * `DataTable` behaviour: table semantics (requirement 15.2), the loading and
 * empty rows, and the keyboard-operable row trigger.
 *
 * Page-level table behaviour is covered by the page tasks; this file stays with
 * the component's own contract.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn } from "./DataTable";

interface SpeakerRow {
  id: string;
  name: string;
  followups: number;
}

const ROWS: SpeakerRow[] = [
  { id: "SPK-1", name: "Priya Nair", followups: 2 },
  { id: "SPK-2", name: "Arjun Rao", followups: 0 },
];

const COLUMNS: DataTableColumn<SpeakerRow>[] = [
  { key: "name", header: "Speaker", cell: (row) => row.name, rowHeader: true },
  { key: "followups", header: "Follow-ups", cell: (row) => row.followups, align: "end" },
];

describe("DataTable", () => {
  it("renders scoped column headers and a row header per record", () => {
    render(<DataTable label="Speakers" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);

    expect(screen.getByRole("table", { name: "Speakers" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Speaker" })).toHaveAttribute("scope", "col");
    expect(screen.getByRole("rowheader", { name: "Priya Nair" })).toHaveAttribute("scope", "row");
    // Header and body cells of one column always carry the same alignment.
    expect(screen.getByRole("columnheader", { name: "Follow-ups" })).toHaveAttribute(
      "data-align",
      "end",
    );
    expect(screen.getByRole("cell", { name: "2" })).toHaveAttribute("data-align", "end");
  });

  it("renders the caller's loading row instead of records, and the empty row when there are none", () => {
    const { rerender } = render(
      <DataTable
        label="Speakers"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.id}
        loading
        loadingContent="Getting the latest operation state…"
      />,
    );

    expect(screen.getByRole("table", { name: "Speakers" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Getting the latest operation state…")).toBeInTheDocument();
    expect(screen.queryByRole("rowheader", { name: "Priya Nair" })).not.toBeInTheDocument();

    rerender(
      <DataTable
        label="Speakers"
        columns={COLUMNS}
        rows={[]}
        rowKey={(row) => row.id}
        emptyContent="No speakers yet for this event."
      />,
    );

    expect(screen.getByRole("table", { name: "Speakers" })).not.toHaveAttribute("aria-busy");
    expect(screen.getByText("No speakers yet for this event.")).toBeInTheDocument();
  });

  it("exposes the row trigger as a button that reports its row from the keyboard", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn<(row: SpeakerRow) => void>();

    render(
      <DataTable
        label="Speakers"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.id}
        rowAction={{
          label: "View details",
          accessibleLabel: (row) => `View details for ${row.name}`,
          onSelect,
        }}
      />,
    );

    const trigger = screen.getByRole("button", { name: "View details for Arjun Rao" });

    trigger.focus();
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(ROWS[1]);
  });
});
