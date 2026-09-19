/**
 * `AuditView` — the Audit Log's view model (design.md §9.1, §8.8).
 *
 * The page answers one question: "what happened, who did it, and was it
 * allowed?". This module turns `AuditEvent` records into the readable sentences
 * that answer it, and it is where requirement 16.6 is enforced *structurally*
 * rather than by a runtime check.
 *
 * ## `details` cannot be rendered, by construction
 *
 * `checkin/handlers.py::_create_recovery_case` writes `search_criteria` — which
 * may hold an email address or a phone number — into an audit record's
 * `details` (design.md A11). Nothing in the console filters that out at render
 * time. Instead:
 *
 *   1. `src/types.ts` does not declare `AuditEvent.details`, so no typed code
 *      can read it (requirement 16.6).
 *   2. `ModelledAuditEvent` below narrows even that type to the nine fields
 *      design.md §8.8 lists as renderable. A future `details` field on
 *      `AuditEvent` would still be unreachable from this module.
 *   3. `toAuditEntryView` returns a *new* object of composed strings. The API
 *      record itself never reaches the page, so there is no object to spread
 *      into the DOM and no attribute for an unmodelled value to leak through.
 *
 * ## Why the action vocabulary is humanised rather than translated
 *
 * `incidents_handler.py` composes its action as `f"INCIDENT_{status}"`, so the
 * set of action values is open — it grows whenever the backend gains a status.
 * A lookup table of hand-written sentences would silently fall through to a raw
 * token the day that happens. The rule here works on values that do not exist
 * yet: split the identifier into words, lower-case it, restore the compounds
 * English hyphenates, and sentence-case the result. `SPEAKER_FOLLOWUP_SENT`
 * reads as "Speaker follow-up sent" and a value coined next month still reads
 * as a sentence.
 *
 * Day grouping lives here too: `Timeline` deliberately leaves it to its caller
 * (see `src/components/Timeline.tsx`), because the Audit Log is the only surface
 * that groups by day.
 */

import { parseTimestamp, UNKNOWN_TIME_LABEL } from "../lib/formatTime";
import { readTableEntry } from "../lib/unknownValue";
import type { AuditEvent } from "../types";

/**
 * The fields the Audit Log may read: `timestamp`, `action`, `actor_type`,
 * `actor_id`, `resource_type`, `resource_id`, `outcome`, and `tool_used` /
 * `policy_evaluated` when present, plus the record's own identifier for React
 * keys (design.md §8.8, requirement 10.2).
 *
 * Declared as a `Pick` rather than restated, so it tracks `src/types.ts` and
 * cannot drift into a second, wider definition of an audit record.
 */
export type ModelledAuditEvent = Pick<
  AuditEvent,
  | "audit_id"
  | "timestamp"
  | "action"
  | "actor_type"
  | "actor_id"
  | "resource_type"
  | "resource_id"
  | "outcome"
  | "tool_used"
  | "policy_evaluated"
>;

/** The audit endpoint's response, narrowed to the fields this page reads. */
export interface AuditEventPage {
  readonly audit_events: readonly ModelledAuditEvent[];
  /**
   * The number of records **in this response**, not the size of the record.
   * `audit_handler.py` returns `len(items)`, so nothing here may present it as
   * a total.
   */
  readonly count: number;
}

/**
 * How the page fetches a page of the record.
 *
 * Expressed as a function type so the limit is part of the contract, and so a
 * test can supply the record it wants to assert against instead of a network.
 */
export type AuditEventSource = (eventId: string, limit: number) => Promise<AuditEventPage>;

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/**
 * The three facets requirement 10.5 asks for: CommunityOps agents, people, and
 * the system itself. They are also `TimelineActor["kind"]`, so an entry's facet
 * is the same value that drives its attribution label.
 */
export type AuditActorFacet = "agent" | "person" | "system";

/** Filter order, and the order the facets are offered in. */
export const AUDIT_ACTOR_FACETS = ["agent", "person", "system"] as const satisfies readonly AuditActorFacet[];

/**
 * Filter copy. "CommunityOps" is the product speaking in its own name — never
 * "the AI" or "the agent" (design.md §15.2).
 */
export const AUDIT_FACET_LABELS: Record<AuditActorFacet, string> = {
  agent: "CommunityOps",
  person: "People",
  system: "System",
};

/**
 * `actor_type` as the backend writes it (`services/shared/models/base.py`:
 * "user, agent, system").
 */
const ACTOR_TYPE_FACETS: Record<string, AuditActorFacet> = {
  agent: "agent",
  user: "person",
  system: "system",
};

/**
 * Which facet an `actor_type` belongs to.
 *
 * `actor_type` is typed `string`, not a union, so an unrecognised value is
 * reachable. It resolves to `system`: the record was produced by the platform,
 * and neither claiming CommunityOps did it nor attributing it to a person would
 * be true.
 */
export function auditActorFacet(actorType: string): AuditActorFacet {
  const normalised = typeof actorType === "string" ? actorType.trim().toLowerCase() : "";

  return readTableEntry(ACTOR_TYPE_FACETS, normalised) ?? "system";
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/** The endpoint's own default (`audit_handler.py`). */
export const AUDIT_PAGE_SIZE = 50;

/**
 * The endpoint's ceiling: `limit = min(int(params.get("limit", "50")), 200)`.
 * The client respects it rather than discovering it, so "Load more" stops
 * offering a page the backend would silently shrink (requirement 10.4).
 */
export const AUDIT_LIMIT_CAP = 200;

/** The limit the next "Load more" asks for, never above the documented cap. */
export function nextAuditLimit(limit: number): number {
  const current = Number.isFinite(limit)
    ? Math.max(AUDIT_PAGE_SIZE, Math.trunc(limit))
    : AUDIT_PAGE_SIZE;

  return Math.min(current + AUDIT_PAGE_SIZE, AUDIT_LIMIT_CAP);
}

/**
 * Whether there is any point offering "Load more".
 *
 * Two conditions, and both are statements about what the response proved:
 *
 *   - a response that filled the limit it asked for may have been truncated, so
 *     more may exist. A short response is the end of the record.
 *   - at the cap, a larger request returns the same 200 records, so the offer
 *     would be an empty promise.
 */
export function moreMayExist(received: number, requestedLimit: number): boolean {
  return requestedLimit < AUDIT_LIMIT_CAP && received >= requestedLimit;
}

// ---------------------------------------------------------------------------
// Readable text
// ---------------------------------------------------------------------------

/**
 * Compounds that English hyphenates, restored after the identifier has been
 * split into words. Written to match both spellings the backend uses —
 * `CHECKIN` and `CheckIn` both arrive as "check in" by this point.
 */
const COMPOUND_TERMS: readonly (readonly [RegExp, string])[] = [
  [/\bcheck ?in\b/g, "check-in"],
  [/\bfollow ?up\b/g, "follow-up"],
];

/** Copy for an action that carries no readable content at all. */
export const UNKNOWN_ACTION_LABEL = "Operation recorded";

/** Copy for an outcome the record left blank. */
export const UNKNOWN_OUTCOME_LABEL = "Outcome not recorded";

/** Copy for an actor the record left blank. */
export const UNKNOWN_ACTOR_LABEL = "Not recorded";

/**
 * Turn a backend identifier into a sentence: `SPEAKER_FOLLOWUP_SENT` into
 * "Speaker follow-up sent", `PaymentReference` into "Payment reference".
 *
 * `humaniseUnknownValue` in `src/lib/unknownValue.ts` does the generic half of
 * this for status labels, but it replaces `-` with a space, so it cannot produce
 * the hyphenated compounds an audit sentence needs. It stays the helper for
 * badge labels; this is the page's sentence builder.
 *
 * @returns the sentence, or `null` when the value holds no readable content and
 * the caller should fall back to its own copy.
 */
function readableSentence(value: string): string | null {
  // Typed as `string`, but `apiFetch` asserts response shapes rather than
  // validating them, so a JSON number or null reaches this function.
  if (typeof value !== "string") {
    return null;
  }

  const words = value
    // `PaymentReference` → `Payment Reference`, before case is flattened.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

  if (words === "") {
    return null;
  }

  const phrase = COMPOUND_TERMS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    words,
  );

  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
}

/** An identifier, or the fallback copy when the record left it blank. */
function identifierOrNull(value: string): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === "" ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/**
 * One rendered audit entry: composed strings only.
 *
 * This is the whole of what reaches the DOM. Every field is text this module
 * built from the nine modelled fields, which is why no unmodelled value — and
 * in particular no `details` — has a path to the screen.
 */
export interface AuditEntryView {
  /** `audit_id`, used as the React key and nowhere else. */
  readonly id: string;
  readonly timestamp: string;
  readonly facet: AuditActorFacet;
  /** `actor_id`: an agent name, a user identifier, or a system component. */
  readonly actorName: string;
  /** The action as a sentence. */
  readonly action: string;
  /** The resource acted on, plus the tool and policy when the record has them. */
  readonly detail: string | null;
  /** `outcome` as readable text. Never mapped to a colour: it is not a union. */
  readonly outcome: string;
}

/**
 * The supporting line: what was acted on, and what CommunityOps used to do it.
 *
 * `tool_used` and `policy_evaluated` are rendered verbatim and labelled. They
 * are the agent's own tool and policy names — the evidence that an operation was
 * allowed — so shortening or prettifying them would cost the page its point.
 */
function composeDetail(event: ModelledAuditEvent): string | null {
  const parts: string[] = [];

  const resourceType = readableSentence(event.resource_type);
  const resourceId = identifierOrNull(event.resource_id);

  if (resourceType !== null && resourceId !== null) {
    parts.push(`${resourceType} ${resourceId}`);
  } else if (resourceType !== null) {
    parts.push(resourceType);
  } else if (resourceId !== null) {
    parts.push(resourceId);
  }

  const tool = event.tool_used === undefined ? null : identifierOrNull(event.tool_used);

  if (tool !== null) {
    parts.push(`Tool: ${tool}`);
  }

  const policy =
    event.policy_evaluated === undefined ? null : identifierOrNull(event.policy_evaluated);

  if (policy !== null) {
    parts.push(`Policy: ${policy}`);
  }

  return parts.length === 0 ? null : parts.join(" · ");
}

/** Compose one entry from the modelled fields. */
export function toAuditEntryView(event: ModelledAuditEvent): AuditEntryView {
  return {
    id: event.audit_id,
    timestamp: event.timestamp,
    facet: auditActorFacet(event.actor_type),
    actorName: identifierOrNull(event.actor_id) ?? UNKNOWN_ACTOR_LABEL,
    action: readableSentence(event.action) ?? UNKNOWN_ACTION_LABEL,
    detail: composeDetail(event),
    outcome: readableSentence(event.outcome) ?? UNKNOWN_OUTCOME_LABEL,
  };
}

/** Compose a whole response. The API records are not retained. */
export function toAuditEntryViews(
  events: readonly ModelledAuditEvent[],
): readonly AuditEntryView[] {
  return events.map(toAuditEntryView);
}

/** Narrow the record to the actor types the user has left selected. */
export function selectAuditEntries(
  entries: readonly AuditEntryView[],
  facets: ReadonlySet<AuditActorFacet>,
): readonly AuditEntryView[] {
  return entries.filter((entry) => facets.has(entry.facet));
}

// ---------------------------------------------------------------------------
// Day grouping
// ---------------------------------------------------------------------------

/**
 * Day headings, in the one locale the console formats dates in.
 *
 * `src/lib/formatTime.ts` owns every *timestamp* the product renders — the
 * relative time in each entry, the absolute value on its `title`, the machine
 * value in its `dateTime`. A day heading is not a timestamp: it is the grouping
 * key this page derives, and grouping is deliberately the caller's job (see
 * `Timeline`). The parsing still goes through the shared `parseTimestamp`, so
 * there is one answer to "is this value a usable time?".
 */
const DAY_HEADING_FORMATTER = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" });

/** One day of the record: a heading and the entries that fall under it. */
export interface AuditDayView {
  /** Stable key for the day. The heading itself: one per calendar day. */
  readonly key: string;
  /** For example "12 Mar 2025". */
  readonly heading: string;
  readonly entries: readonly AuditEntryView[];
}

/**
 * Group entries into days, newest day first.
 *
 * Entries whose timestamp cannot be parsed are not dropped — an audit record
 * that quietly loses rows is worse than one that admits it cannot place them —
 * they collect under a final "Time unavailable" group, matching the way
 * `Timeline` sinks them to the end of a list.
 *
 * Ordering *within* a day is left to `Timeline`, which sorts newest-first
 * itself, so the two components cannot disagree about order.
 */
export function groupAuditEntriesByDay(
  entries: readonly AuditEntryView[],
): readonly AuditDayView[] {
  const placed = entries.map((entry, index) => {
    const parsed = parseTimestamp(entry.timestamp);

    return {
      entry,
      index,
      time: parsed === null ? null : parsed.getTime(),
      key: parsed === null ? UNKNOWN_TIME_LABEL : DAY_HEADING_FORMATTER.format(parsed),
    };
  });

  placed.sort((a, b) => {
    if (a.time === null || b.time === null) {
      if (a.time === b.time) return a.index - b.index;

      return a.time === null ? 1 : -1;
    }

    if (a.time === b.time) return a.index - b.index;

    return b.time - a.time;
  });

  const days: AuditDayView[] = [];
  const entriesByKey = new Map<string, AuditEntryView[]>();

  for (const { entry, key } of placed) {
    const existing = entriesByKey.get(key);

    if (existing === undefined) {
      const collected: AuditEntryView[] = [entry];
      entriesByKey.set(key, collected);
      days.push({ key, heading: key, entries: collected });
    } else {
      existing.push(entry);
    }
  }

  return days;
}
