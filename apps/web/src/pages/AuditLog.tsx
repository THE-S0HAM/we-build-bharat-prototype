/**
 * Audit Log — "what happened, who did it, and was it allowed?" (design.md §8.8).
 *
 * The page is a day-grouped `Timeline` over `GET /events/{eventId}/audit`. It
 * holds layout and data wiring only: `Timeline` owns order, attribution and
 * relative time, `auditView.ts` owns the sentences and the day grouping, and
 * this file decides what is on screen.
 *
 * Three things are deliberate here.
 *
 * **`details` is unreachable, not filtered.** `src/types.ts` does not declare
 * `AuditEvent.details`, `ModelledAuditEvent` narrows the record further to the
 * nine renderable fields, and `toAuditEntryViews` returns freshly composed
 * strings. The API record never reaches this component, so there is nothing to
 * spread and no attribute for an email or phone number in `details` to leak
 * through (requirement 16.6, design.md A11).
 *
 * **`outcome` is text, not a colour.** `AuditEvent.outcome` is typed `string`,
 * not a union, so `StatusBadge` has no domain for it and this page must not
 * invent one: requirement 12.5 makes `StatusBadge` the only component that maps
 * a status to a colour. The outcome renders as readable text with a visually
 * hidden label, so it is never carried by colour alone (requirement 15.10).
 *
 * **Day grouping belongs to the page.** `Timeline` leaves it to its caller by
 * design, so each day is a section with its own `<h2>` and its own `Timeline`.
 */

import { useCallback, useEffect, useState } from "react";

import { getAuditLog } from "../api";
import { ApiErrorState } from "../components/ApiErrorState";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { SkeletonList } from "../components/Skeleton";
import { Timeline, type TimelineEntry } from "../components/Timeline";
import { useApiFailure } from "../session/useApiFailure";
import {
  AUDIT_ACTOR_FACETS,
  AUDIT_FACET_LABELS,
  AUDIT_LIMIT_CAP,
  AUDIT_PAGE_SIZE,
  groupAuditEntriesByDay,
  moreMayExist,
  nextAuditLimit,
  selectAuditEntries,
  toAuditEntryViews,
  type AuditActorFacet,
  type AuditEntryView,
  type AuditEventSource,
} from "./auditView";
import "./AuditLog.css";

const PAGE_TITLE = "Audit Log";

/** Requirement 10.6, verbatim. */
const EMPTY_TITLE = "No activity recorded yet.";
const EMPTY_DESCRIPTION = "Every consequential operation CommunityOps or your team performs will appear here.";

/**
 * The filters narrowed the record to nothing. That is not the same state as an
 * event with no activity, so it does not borrow requirement 10.6's copy.
 */
const FILTERED_OUT_TITLE = "No activity from the actors you've selected.";
const SHOW_ALL_LABEL = "Show all activity";

const LOAD_MORE_LABEL = "Load more";
const LOADING_MORE_LABEL = "Loading more…";
const LOADING_LABEL = "Getting the activity record…";

/** Honest at the ceiling: the view stops, the record does not. */
const CAP_NOTE = `This view holds the ${AUDIT_LIMIT_CAP} most recent operations. Older activity stays in the record.`;

/**
 * The request the page is showing, or about to show. Held as one value so a
 * change of event and a change of page size go through the same path.
 */
interface AuditRequest {
  readonly eventId: string;
  readonly limit: number;
}

/** What the last successful response produced. */
interface AuditResult {
  readonly entries: readonly AuditEntryView[];
  /** The limit that response asked for, which is what "more may exist" reads. */
  readonly limit: number;
  readonly received: number;
}

export interface AuditLogProps {
  /** The active event, from `EventScopedView`. */
  readonly eventId: string;
  /**
   * How to fetch a page of the record. Defaults to the API client; a test
   * supplies the record it wants to assert against.
   */
  readonly loadAuditEvents?: AuditEventSource;
}

/**
 * The default source.
 *
 * NOTE: `getAuditLog` in `src/api.ts` does not yet forward a `limit` to the
 * endpoint, so the requested value is accepted here and the endpoint applies its
 * own default of 50. The paging contract — the ladder, the cap, and the refusal
 * to offer a page that would come back the same size — lives in `auditView.ts`
 * and is unaffected: a response that does not fill the limit it asked for ends
 * the record, so "Load more" stops offering rather than looping. Forwarding the
 * value is one line in the API client:
 *
 * ```ts
 * export async function getAuditLog(eventId: string, limit = 50) {
 *   return apiFetch((org) => ({
 *     path: `/events/${eventId}/audit?${orgQuery(org)}&limit=${Math.min(limit, 200)}`,
 *   }));
 * }
 * ```
 */
const loadFromApi: AuditEventSource = (eventId, limit) => getAuditLog(eventId, limit);

export function AuditLog({ eventId, loadAuditEvents = loadFromApi }: AuditLogProps) {
  const report = useApiFailure();

  const [request, setRequest] = useState<AuditRequest>({ eventId, limit: AUDIT_PAGE_SIZE });
  const [result, setResult] = useState<AuditResult | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [facets, setFacets] = useState<ReadonlySet<AuditActorFacet>>(
    () => new Set(AUDIT_ACTOR_FACETS),
  );

  /* The active event changed under the page. Start its record from the first
     page rather than carrying the previous event's paging state across. */
  if (request.eventId !== eventId) {
    setRequest({ eventId, limit: AUDIT_PAGE_SIZE });
    setResult(null);
    setFailure(null);
  }

  useEffect(() => {
    /* The event or the limit can change while a request is in flight. Ignoring a
       superseded response keeps the list matching the request the user made. */
    let active = true;

    setFailure(null);

    loadAuditEvents(request.eventId, request.limit).then(
      (page) => {
        if (!active) return;

        setResult({
          entries: toAuditEntryViews(page.audit_events),
          limit: request.limit,
          received: page.audit_events.length,
        });
      },
      (error: unknown) => {
        if (!active) return;

        /* No `refresh`: the request that failed *is* this list, and re-running
           it unprompted would be a retry loop rather than a refresh. The user
           retries through `ApiErrorState` (see `useApiFailure`). */
        setFailure(report(error));
      },
    );

    return () => {
      active = false;
    };
  }, [attempt, loadAuditEvents, report, request]);

  /** Re-run only the request that failed (requirement 13.3). */
  const reload = useCallback(() => {
    setAttempt((previous) => previous + 1);
  }, []);

  /* A larger page has been asked for and has not arrived. A failed attempt ends
     the wait: the button goes back to offering, and the error explains itself
     below the list. */
  const loadingMore = result !== null && result.limit !== request.limit && failure === null;

  const loadMore = useCallback(() => {
    if (result === null || loadingMore) return;

    setRequest({ eventId, limit: nextAuditLimit(result.limit) });
  }, [eventId, loadingMore, result]);

  const toggleFacet = useCallback((facet: AuditActorFacet) => {
    setFacets((previous) => {
      const next = new Set(previous);

      if (next.has(facet)) {
        next.delete(facet);
      } else {
        next.add(facet);
      }

      return next;
    });
  }, []);

  const showAllFacets = useCallback(() => {
    setFacets(new Set(AUDIT_ACTOR_FACETS));
  }, []);

  // The first load of this event: nothing to show yet but the frame.
  if (result === null) {
    return (
      <div className="page audit-log">
        <PageHeader title={PAGE_TITLE} />
        {failure === null ? (
          <SkeletonList items={6} leading="dot" label={LOADING_LABEL} />
        ) : (
          <ApiErrorState error={failure} onRetry={reload} />
        )}
      </div>
    );
  }

  const visible = selectAuditEntries(result.entries, facets);
  const days = groupAuditEntriesByDay(visible);
  const canLoadMore = moreMayExist(result.received, result.limit);
  const atCap = result.limit >= AUDIT_LIMIT_CAP && result.received >= AUDIT_LIMIT_CAP;

  return (
    <div className="page audit-log">
      <PageHeader
        title={PAGE_TITLE}
        context={describeRecord(visible.length, result.entries.length, canLoadMore)}
      />

      <fieldset className="audit-log__filters">
        <legend className="audit-log__filters-legend">Show activity from</legend>

        {AUDIT_ACTOR_FACETS.map((facet) => (
          <label className="form-check audit-log__facet" key={facet}>
            <input
              type="checkbox"
              className="audit-log__facet-input"
              checked={facets.has(facet)}
              onChange={() => {
                toggleFacet(facet);
              }}
            />
            {AUDIT_FACET_LABELS[facet]}
          </label>
        ))}
      </fieldset>

      {days.length === 0 ? (
        emptyRecord(result.entries.length, showAllFacets)
      ) : (
        <>
          {days.map((day) => (
            <section className="audit-log__day" key={day.key} aria-labelledby={dayHeadingId(day.key)}>
              <h2 className="audit-log__day-heading" id={dayHeadingId(day.key)}>
                {day.heading}
              </h2>

              <Timeline entries={day.entries.map(toTimelineEntry)} label={`Activity on ${day.heading}`} />
            </section>
          ))}

          {atCap ? <p className="audit-log__note">{CAP_NOTE}</p> : null}

          {canLoadMore ? (
            <button type="button" className="btn audit-log__more" onClick={loadMore}>
              {loadingMore ? LOADING_MORE_LABEL : LOAD_MORE_LABEL}
            </button>
          ) : null}
        </>
      )}

      {failure === null ? null : <ApiErrorState error={failure} onRetry={reload} />}
    </div>
  );
}

/**
 * One `TimelineEntry` per audit entry. Every value is a string this page's view
 * model composed: `Timeline` receives no API record.
 */
function toTimelineEntry(entry: AuditEntryView): TimelineEntry {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    actor: { kind: entry.facet, name: entry.actorName },
    action: entry.action,
    detail: entry.detail ?? undefined,
    status: (
      <span className="audit-log__outcome">
        {/* Read out as "Outcome: Success"; on screen the column position says it. */}
        <span className="audit-log__outcome-label">Outcome: </span>
        {entry.outcome}
      </span>
    ),
  };
}

/**
 * The context line under the title.
 *
 * `count` from the endpoint is the size of the response, not of the record
 * (`audit_handler.py` returns `len(items)`), so the page never states a total it
 * does not have.
 */
function describeRecord(visible: number, loaded: number, more: boolean): string {
  if (visible !== loaded) {
    return `Showing ${visible} of ${pluralise(loaded, "recorded operation")}.`;
  }

  return more
    ? `The ${loaded} most recent operations. Older activity is still recorded.`
    : `${pluralise(loaded, "operation")} recorded for this event.`;
}

function pluralise(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Zero entries has two causes, and they are not the same message: an event with
 * no activity (requirement 10.6) and filters that exclude everything loaded.
 */
function emptyRecord(loaded: number, showAll: () => void) {
  if (loaded === 0) {
    return <EmptyState title={EMPTY_TITLE} description={EMPTY_DESCRIPTION} />;
  }

  return <EmptyState title={FILTERED_OUT_TITLE} action={{ label: SHOW_ALL_LABEL, onClick: showAll }} />;
}

/** The day heading each section is labelled by. */
function dayHeadingId(key: string): string {
  return `audit-day-${key.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;
}
