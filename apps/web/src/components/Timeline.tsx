/**
 * `Timeline` — the product's only chronological event list.
 *
 * design.md §7 scopes it to "chronological event list with actor attribution and
 * relative time", reused by the Audit Log (its primary consumer, §8.8), incident
 * history and approval context.
 *
 * What this component guarantees, so no page has to:
 *   - chronological order by timestamp, newest first by default, independent of
 *     the order the caller happens to hold the records in
 *   - actor attribution that is always readable as text: CommunityOps (agent),
 *     a person, or the system. The tint is supplementary, never the signal
 *     (requirement 15.10)
 *   - one relative time, from the single shared formatter in `src/lib/formatTime`
 *     (design.md §7.1, §15.3 check 12), inside a real `<time>` element with the
 *     absolute timestamp on `title`
 *   - one section rhythm and one grid column, shared with every other surface
 *     (requirement 12.4)
 *
 * Entry content is composed by the caller, so the page's typed model stays the
 * allowlist: the Audit Log builds its action sentence from the modelled fields
 * only and `AuditEvent.details` never reaches this component (requirement 16.6).
 *
 * Day grouping stays with the caller too (§8.8 groups audit entries by day):
 * render one `Timeline` per day inside a section with its own heading, passing
 * `label` so each list is named.
 */

import { useMemo, type ReactNode } from "react";
import {
  formatAbsoluteTime,
  formatRelativeTime,
  parseTimestamp,
  toMachineTime,
} from "../lib/formatTime";
import "./Timeline.css";

/**
 * Who acted. `agent` is CommunityOps itself — the product speaks in its own
 * name and never as "the AI" or "the agent" (design.md §15.2).
 */
export type TimelineActorKind = "agent" | "person" | "system";

export interface TimelineActor {
  kind: TimelineActorKind;
  /**
   * The actor as the caller wants it read: an agent name, a person's
   * identifier, or a system component. Shown after the attribution label.
   */
  name: string;
}

export interface TimelineEntry {
  /** Stable identity, from the record's own identifier. */
  id: string;
  /** ISO-8601 timestamp. Drives both the order and the rendered time. */
  timestamp: string;
  actor: TimelineActor;
  /** What happened, as a readable sentence composed by the caller. */
  action: ReactNode;
  /** Optional supporting line: the resource acted on, the tool, the policy. */
  detail?: ReactNode;
  /** Optional trailing slot for the outcome, for example a `StatusBadge`. */
  status?: ReactNode;
}

export type TimelineOrder = "newest-first" | "oldest-first";

export interface TimelineProps {
  entries: readonly TimelineEntry[];
  /** Accessible name for the list, for example "Activity on 12 March 2025". */
  label?: string;
  /** Defaults to `newest-first`, the order every consuming page specifies. */
  order?: TimelineOrder;
  /** Reference point for relative time; pass it to keep rendering deterministic. */
  now?: Date;
  /** Rendered in place of the list when there are no entries. */
  emptyContent?: ReactNode;
}

/**
 * Attribution labels. Text first: the kind is legible with colour unavailable,
 * and these are attribution, not status — `StatusBadge` remains the only
 * component that maps a *status* to a colour (requirement 12.5).
 */
const ACTOR_LABELS: Record<TimelineActorKind, string> = {
  agent: "CommunityOps",
  person: "Person",
  system: "System",
};

export function Timeline({
  entries,
  label,
  order = "newest-first",
  now,
  emptyContent,
}: TimelineProps) {
  const ordered = useMemo(() => {
    const positioned = entries.map((entry, index) => {
      const parsed = parseTimestamp(entry.timestamp);

      return {
        entry,
        index,
        /* null for an unusable timestamp: it cannot be placed in time, so it
           sinks to the end rather than distorting the order. */
        time: parsed === null ? null : parsed.getTime(),
      };
    });

    positioned.sort((a, b) => {
      if (a.time === null || b.time === null) {
        if (a.time === b.time) return a.index - b.index;

        return a.time === null ? 1 : -1;
      }

      if (a.time === b.time) return a.index - b.index;

      return order === "newest-first" ? b.time - a.time : a.time - b.time;
    });

    return positioned.map((positionedEntry) => positionedEntry.entry);
  }, [entries, order]);

  if (ordered.length === 0) {
    return emptyContent === undefined ? null : <div className="timeline-empty">{emptyContent}</div>;
  }

  const reference = now ?? new Date();

  return (
    <ol className="timeline" aria-label={label}>
      {ordered.map((entry) => {
        const machineTime = toMachineTime(entry.timestamp);

        return (
          <li key={entry.id} className="timeline__entry">
            {/* Relative time carries the absolute timestamp on `title`, so the
                precise value is available without adding a second time column
                (design.md §7.1). */}
            <time
              className="timeline__time"
              dateTime={machineTime ?? undefined}
              title={formatAbsoluteTime(entry.timestamp)}
            >
              {formatRelativeTime(entry.timestamp, reference)}
            </time>

            <div className="timeline__body">
              <p className="timeline__action">{entry.action}</p>

              <p className="timeline__attribution">
                <span className="timeline__actor-kind" data-kind={entry.actor.kind}>
                  {ACTOR_LABELS[entry.actor.kind]}
                </span>
                <span className="timeline__actor-name">{entry.actor.name}</span>
              </p>

              {entry.detail === undefined ? null : (
                <p className="timeline__detail">{entry.detail}</p>
              )}
            </div>

            {entry.status === undefined ? null : (
              <div className="timeline__status">{entry.status}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
