import { useId } from "react";

import { ApiErrorState } from "../components/ApiErrorState";
import { EmptyState } from "../components/EmptyState";
import { SkeletonList } from "../components/Skeleton";
import { Timeline, type TimelineEntry } from "../components/Timeline";
import { parseTimestamp } from "../lib/formatTime";
import {
  toAuditEntryViews,
  type AuditActorFacet,
  type ModelledAuditEvent,
} from "../pages/auditView";

import "./AgentStatus.css";

/**
 * `AgentStatus` — the compact "CommunityOps is handling…" strip (design.md §7,
 * requirements 4.6, 4.7).
 *
 * It is one component with two jobs on the Command Center, because the only
 * difference between them is which actors and which scope, and saying that in
 * props rather than in a second component is what keeps the two strips looking
 * like one idea:
 *
 *   - the **handled strip**, from `GET /events/{eventId}/audit` for the active
 *     event, filtered to agent actors (requirement 4.6);
 *   - the **organization-wide feed**, from `recent_actions`, which is org-wide by
 *     construction and is therefore labelled as such by its caller
 *     (requirement 4.7, A12).
 *
 * ## What it refuses to render
 *
 * Entries are composed by `toAuditEntryViews`, so only the nine modelled audit
 * fields reach the DOM. `AuditEvent.details` is not in `src/types.ts` at all and
 * this component never sees a raw record — it holds composed strings
 * (requirement 16.6). `outcome` is rendered as text and never mapped to a
 * colour: it is not a union, so there is no table to map it with.
 *
 * ## A failure here stays here
 *
 * The strip owns its own loading, empty and failure states, so a failed audit
 * call scopes the error to this region and leaves the rest of the page usable
 * (requirement 13.8). "Try again" re-runs only the strip's request.
 */

/** Entries the strip shows. Compact by design; the Audit Log is the full record. */
export const AGENT_STATUS_LIMIT = 5;

/** Filtered to CommunityOps itself unless the caller widens it. */
const AGENT_ONLY: readonly AuditActorFacet[] = ["agent"];

export interface AgentStatusProps {
  /** The strip's heading, rendered as its `<h2>` and its accessible name. */
  readonly heading: string;

  /** One line naming the scope, so "this event" and "org-wide" never blur. */
  readonly description: string;

  readonly events: readonly ModelledAuditEvent[];

  /** Which actors belong in this strip. Defaults to agent actors only (4.6). */
  readonly facets?: readonly AuditActorFacet[];

  /** Newest entries kept. Defaults to `AGENT_STATUS_LIMIT`. */
  readonly limit?: number;

  readonly loading?: boolean;

  /** A failure from this strip's own request. Rendered inside the strip (13.8). */
  readonly failure?: unknown;

  /** Re-runs only the strip's request (requirement 13.3). */
  readonly onRetry?: () => void;

  /** Copy for a strip whose request resolved with nothing to show. */
  readonly emptyMessage: string;

  /** Reference point for relative time; pass it to keep rendering deterministic. */
  readonly now?: Date;
}

export function AgentStatus({
  heading,
  description,
  events,
  facets = AGENT_ONLY,
  limit = AGENT_STATUS_LIMIT,
  loading = false,
  failure = null,
  onRetry,
  emptyMessage,
  now,
}: AgentStatusProps) {
  const headingId = useId();
  const wanted = new Set(facets);

  const entries: TimelineEntry[] = toAuditEntryViews(events)
    .filter((entry) => wanted.has(entry.facet))
    // Sorted before the cap, so "the newest five" is true whatever order the
    // response arrived in. `Timeline` sorts again for display.
    .slice()
    .sort((a, b) => {
      const left = parseTimestamp(a.timestamp)?.getTime();
      const right = parseTimestamp(b.timestamp)?.getTime();

      if (left === undefined || right === undefined) {
        return left === right ? 0 : left === undefined ? 1 : -1;
      }

      return right - left;
    })
    .slice(0, Math.max(0, limit))
    .map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp,
      actor: { kind: entry.facet, name: entry.actorName },
      action: entry.action,
      detail: entry.detail ?? undefined,
      status: <span className="agent-status__outcome">{entry.outcome}</span>,
    }));

  return (
    <section className="agent-status" aria-labelledby={headingId}>
      <div className="agent-status__head">
        <h2 className="agent-status__heading" id={headingId}>
          {heading}
        </h2>
        <p className="agent-status__description">{description}</p>
      </div>

      {loading ? (
        <SkeletonList items={3} leading="dot" label={`Loading ${heading.toLowerCase()}…`} />
      ) : failure !== null && failure !== undefined ? (
        /* Scoped to this strip: the page around it keeps working (13.8). */
        <ApiErrorState error={failure} onRetry={onRetry} />
      ) : entries.length === 0 ? (
        <EmptyState title={emptyMessage} />
      ) : (
        <Timeline entries={entries} label={heading} now={now} />
      )}
    </section>
  );
}
