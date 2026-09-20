/**
 * Skeleton — the one loading pattern in the product (design.md §7).
 *
 * A skeleton is shape-preserving: it renders in the shape of the content that
 * is coming, so nothing jumps when the data lands and the user can already read
 * the structure of the view (requirement 13.1). There are no spinners here by
 * design — design.md §12.2 rules out a bare spinner on a full page.
 *
 * Composition model
 * -----------------
 *   `Skeleton`        one placeholder shape; decorative, hidden from assistive
 *                     technology, never announced on its own
 *   `SkeletonRegion`  the announced wrapper: `role="status"` + `aria-busy`, with
 *                     one visually hidden sentence naming what is loading
 *   `SkeletonText`    a paragraph
 *   `SkeletonCard`    a card
 *   `SkeletonList`    a list, or a timeline with `leading="dot"`
 *   `SkeletonTable`   a table, with any number of rows and columns
 *
 * The four shape presets are complete regions: they already announce, so they
 * are used directly and are not nested inside one another or inside another
 * `SkeletonRegion`. To build a shape that is not covered here, wrap `Skeleton`
 * primitives in a single `SkeletonRegion` so the loading area still announces
 * exactly once.
 */

import type { ReactNode } from "react";

import "./Skeleton.css";

/**
 * The sentence a loading region announces when the caller does not supply a
 * more specific one (design.md §12.2).
 */
export const SKELETON_LABEL = "Getting the latest operation state…";

/** Placeholder shapes. Each one mirrors a real piece of content. */
export type SkeletonShape = "line" | "heading" | "block" | "pill" | "circle";

/**
 * Placeholder widths are proportions of the container, not fixed sizes, so a
 * skeleton keeps the shape of its content at every breakpoint.
 */
export type SkeletonWidth = "full" | "wide" | "half" | "narrow" | "tiny";

/** How a list or timeline entry leads: nothing, a timeline marker, an avatar. */
export type SkeletonLeading = "none" | "dot" | "avatar";

/**
 * Counts come from callers that are often deriving them from data, so they are
 * clamped to something that still reads as a shape.
 */
function rowKeys(count: number): readonly number[] {
  const safe = Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : 1;
  return Array.from({ length: safe }, (_, index) => index);
}

export interface SkeletonProps {
  shape?: SkeletonShape;
  width?: SkeletonWidth;
}

/**
 * One placeholder shape. Decorative: it carries no information, so it is hidden
 * from assistive technology and the surrounding `SkeletonRegion` does the
 * announcing.
 */
export function Skeleton({ shape = "line", width = "full" }: SkeletonProps) {
  return (
    <span
      className={`skeleton skeleton--${shape} skeleton--w-${width}`}
      aria-hidden="true"
    />
  );
}

export interface SkeletonRegionProps {
  /** What is loading, as one sentence. Announced, never shown. */
  label?: string;
  children: ReactNode;
}

/**
 * The announced loading area. `role="status"` reports it politely when it
 * appears, `aria-busy` marks the region as pending, and the only text in it is
 * the visually hidden label.
 */
export function SkeletonRegion({ label = SKELETON_LABEL, children }: SkeletonRegionProps) {
  return (
    <div className="skeleton-region" role="status" aria-busy="true">
      <span className="skeleton-region__label">{label}</span>
      {children}
    </div>
  );
}

/**
 * Stacked lines. Internal, and deliberately not a region: the presets below
 * compose it, and a loading area must announce exactly once.
 */
function Lines({ lines }: { lines: number }) {
  return (
    <span className="skeleton-lines">
      {rowKeys(lines).map((key) => (
        <Skeleton key={key} shape="line" />
      ))}
    </span>
  );
}

export interface SkeletonTextProps {
  /** Number of lines the real copy will occupy. */
  lines?: number;
  label?: string;
}

/** A paragraph of copy. */
export function SkeletonText({ lines = 3, label }: SkeletonTextProps) {
  return (
    <SkeletonRegion label={label}>
      <Lines lines={lines} />
    </SkeletonRegion>
  );
}

export interface SkeletonCardProps {
  /** Lines of body copy inside the card. */
  lines?: number;
  /** Whether the real card ends in an action row. */
  actions?: boolean;
  label?: string;
}

/** A card: title, body copy, optionally the action row (mirrors `.card`). */
export function SkeletonCard({ lines = 3, actions = false, label }: SkeletonCardProps) {
  return (
    <SkeletonRegion label={label}>
      <div className="skeleton-card">
        <Skeleton shape="heading" width="half" />
        <Lines lines={lines} />
        {actions ? (
          <div className="skeleton-card__actions">
            <Skeleton shape="pill" width="tiny" />
            <Skeleton shape="pill" width="tiny" />
          </div>
        ) : null}
      </div>
    </SkeletonRegion>
  );
}

export interface SkeletonListProps {
  /** How many entries the real list will show. */
  items?: number;
  /** `dot` gives the timeline shape, `avatar` the attendee/speaker shape. */
  leading?: SkeletonLeading;
  label?: string;
}

/** A list of entries, or a timeline when `leading="dot"`. */
export function SkeletonList({ items = 4, leading = "none", label }: SkeletonListProps) {
  return (
    <SkeletonRegion label={label}>
      <div className={`skeleton-list skeleton-list--${leading}`}>
        {rowKeys(items).map((key) => (
          <div className="skeleton-list__item" key={key}>
            {leading === "none" ? null : <Skeleton shape="circle" />}
            <div className="skeleton-list__body">
              <Skeleton shape="line" width="wide" />
              <Skeleton shape="line" width="narrow" />
            </div>
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

export interface SkeletonTableProps {
  /** Rows of data the real table will show. */
  rows?: number;
  /** Columns the real table has. */
  columns?: number;
  /** Whether to place a header rule above the rows. */
  header?: boolean;
  label?: string;
}

/**
 * A table shape. The real table is `<table>` markup with `<th scope>`
 * (requirement 15.2); this placeholder holds no data, is hidden from assistive
 * technology, and exists only to hold the row and column rhythm while the data
 * loads.
 */
export function SkeletonTable({ rows = 5, columns = 4, header = true, label }: SkeletonTableProps) {
  const columnKeys = rowKeys(columns);

  return (
    <SkeletonRegion label={label}>
      <div className="skeleton-table">
        {header ? (
          <div className="skeleton-table__row skeleton-table__row--header">
            {columnKeys.map((key) => (
              <Skeleton key={key} shape="line" width="half" />
            ))}
          </div>
        ) : null}
        {rowKeys(rows).map((rowKey) => (
          <div className="skeleton-table__row" key={rowKey}>
            {columnKeys.map((columnKey) => (
              <Skeleton key={columnKey} shape="line" width="wide" />
            ))}
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}
