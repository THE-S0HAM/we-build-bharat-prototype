/**
 * `DataTable` — the product's only tabular surface.
 *
 * design.md §7 gives it one responsibility: "semantic table with consistent
 * alignment, empty and loading rows, and a row-level drawer trigger", reused by
 * SpeakerOps, TeamOps, Audit Log and the Check-In candidate list.
 *
 * What this component guarantees, so no page has to:
 *   - real `<table>` markup with `<th scope="col">` headers, and an optional
 *     `<th scope="row">` identity column — never a div grid (requirement 15.2)
 *   - one alignment per column, written to the header cell and every body cell
 *     from the same value, so a column cannot drift out of alignment
 *   - a loading row and an empty row in the table's own shape, with the copy
 *     supplied by the caller (`EmptyState` / `Skeleton` compose into them)
 *   - a row-level trigger rendered as a real `<button>` inside its own cell:
 *     keyboard operable, focusable, and never an interactive element nested
 *     inside another interactive element
 *   - one section rhythm and one grid column, shared with every other surface
 *     (requirement 12.4)
 *
 * What it deliberately does not do: own a drawer. Progressive disclosure runs
 * through the single shared `Drawer` (requirement 12.6), so the table exposes
 * the row action and the page decides what opens.
 *
 * Cells render through `column.cell`, so the caller's typed row model stays the
 * allowlist — the table never reads a field it was not handed (requirement 16.5).
 */

import type { ReactNode } from "react";
import "./DataTable.css";

/**
 * Column alignment. `end` also applies tabular figures, because a right-aligned
 * column is a numeric column in this product.
 */
export type DataTableAlign = "start" | "center" | "end";

/**
 * Column importance. `secondary` columns are hidden below `--bp-md`, where
 * design.md §Responsive Behaviour moves the non-primary columns into the drawer.
 */
export type DataTableColumnPriority = "primary" | "secondary";

export interface DataTableColumn<Row> {
  /** Stable identity for the column. Also the React key for its cells. */
  key: string;
  /** Header content. A short noun phrase; the header styling is shared. */
  header: ReactNode;
  /** Renders one cell from the row model. */
  cell: (row: Row) => ReactNode;
  /** Defaults to `start`. */
  align?: DataTableAlign;
  /** Defaults to `primary`. */
  priority?: DataTableColumnPriority;
  /**
   * Marks the column that identifies the row, rendered as `<th scope="row">` so
   * screen readers announce it with every cell. Only the first column flagged
   * is honoured: a row has one identity.
   */
  rowHeader?: boolean;
}

/**
 * The row-level trigger. Use the glossary term for `label` — "View details" for
 * a record's full data, "View activity" for its audit trail (design.md §15.2).
 */
export interface DataTableRowAction<Row> {
  /** Visible button label, identical on every row. */
  label: string;
  /** Invoked on activation. The page opens the shared `Drawer` from here. */
  onSelect: (row: Row) => void;
  /**
   * Per-row accessible name, for example
   * `(speaker) => \`View details for ${speaker.name}\``. Without it every row's
   * button announces the same label, which is ambiguous out of context.
   */
  accessibleLabel?: (row: Row) => string;
  /** Header for the action column. Defaults to "Details". */
  header?: ReactNode;
}

export interface DataTableProps<Row> {
  /**
   * Accessible name for the table, for example "Speakers". Required: a table
   * without a name is unnavigable by screen reader.
   */
  label: string;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  /** Stable key per row, taken from the record's own identifier. */
  rowKey: (row: Row) => string;
  /** While true the table renders `loadingContent` instead of rows. */
  loading?: boolean;
  /** Loading row content — the caller's `Skeleton` shapes. */
  loadingContent?: ReactNode;
  /** Empty row content — the caller's `EmptyState` and its specified copy. */
  emptyContent?: ReactNode;
  /** Omit for a read-only table. */
  rowAction?: DataTableRowAction<Row>;
}

const DEFAULT_ACTION_HEADER = "Details";

/**
 * Single full-width row used for the loading and empty states, so both stay
 * inside the table's own shape instead of replacing it with another surface.
 */
function DataTableMessageRow({
  columnCount,
  children,
}: {
  columnCount: number;
  children: ReactNode;
}) {
  return (
    <tr className="data-table__message-row">
      <td className="data-table__message-cell" colSpan={columnCount}>
        {children}
      </td>
    </tr>
  );
}

export function DataTable<Row>({
  label,
  columns,
  rows,
  rowKey,
  loading = false,
  loadingContent,
  emptyContent,
  rowAction,
}: DataTableProps<Row>) {
  /* One identity column per row: the first flagged column wins. */
  const rowHeaderKey = columns.find((column) => column.rowHeader)?.key;
  const columnCount = columns.length + (rowAction ? 1 : 0);

  const showLoadingRow = loading && loadingContent !== undefined;
  const showEmptyRow = !loading && rows.length === 0 && emptyContent !== undefined;

  return (
    <div className="data-table-scroll">
      <table className="data-table" aria-label={label} aria-busy={loading || undefined}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                data-align={column.align ?? "start"}
                data-priority={column.priority ?? "primary"}
              >
                {column.header}
              </th>
            ))}
            {rowAction ? (
              <th scope="col" data-align="end" data-priority="primary">
                {rowAction.header ?? DEFAULT_ACTION_HEADER}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {showLoadingRow ? (
            <DataTableMessageRow columnCount={columnCount}>{loadingContent}</DataTableMessageRow>
          ) : null}

          {showEmptyRow ? (
            <DataTableMessageRow columnCount={columnCount}>{emptyContent}</DataTableMessageRow>
          ) : null}

          {loading
            ? null
            : rows.map((row) => (
                <tr key={rowKey(row)}>
                  {columns.map((column) => {
                    /* Header and body cells read the same two values, which is
                       what keeps a column's alignment and visibility
                       consistent by construction. */
                    const align = column.align ?? "start";
                    const priority = column.priority ?? "primary";
                    const content = column.cell(row);

                    return column.key === rowHeaderKey ? (
                      <th
                        key={column.key}
                        scope="row"
                        className="data-table__row-header"
                        data-align={align}
                        data-priority={priority}
                      >
                        {content}
                      </th>
                    ) : (
                      <td key={column.key} data-align={align} data-priority={priority}>
                        {content}
                      </td>
                    );
                  })}

                  {rowAction ? (
                    <td className="data-table__action-cell" data-align="end">
                      {/* A real button in its own cell: the row stays
                          non-interactive, so nothing interactive is nested
                          inside anything else, and Enter, Space and the tab
                          order all work without a keydown handler
                          (requirement 15.3). Focus returns here when the
                          drawer it opens closes (requirement 15.5). */}
                      <button
                        type="button"
                        className="btn btn-sm data-table__action"
                        onClick={() => rowAction.onSelect(row)}
                        aria-label={rowAction.accessibleLabel?.(row)}
                      >
                        {rowAction.label}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}
