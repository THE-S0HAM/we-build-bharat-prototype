/**
 * The Command Center's view model and its copy (design.md §8.1, requirement 4).
 *
 * The page answers one question — "is anything waiting on me right now?" — and
 * every derivation behind that answer lives here as a pure function, so the
 * rules can be asserted without rendering and the page stays a composition of
 * shared components.
 *
 * Three constraints from design.md shape this module, and all three are about
 * refusing to overstate what the data says:
 *
 *   - **A13 — watched events are not all events.** `command_center_handler`
 *     puts only `ACTIVE` and `PUBLISHED` events in `events[]`, while
 *     `summary.total_events` counts drafts and completed events too. So the
 *     headline count is `summary.active_events`, never `total_events`, and a
 *     total is only ever shown labelled "of N total" (requirement 4.2).
 *   - **A12 — `recent_actions` is organization-wide.** It is the newest ten
 *     audit entries across every event, so it cannot be presented as "what
 *     CommunityOps is doing about this event". The handled strip comes from
 *     `GET /events/{eventId}/audit`; the org-wide feed is labelled as such
 *     (requirements 4.6, 4.7). The copy for both labels is here.
 *   - **Requirement 4.10 — metrics live in two places only.** The greeting
 *     context line and the contextual visual. Nothing else on the page states a
 *     count, which is why the sentences below are the only ones that compose
 *     one.
 *
 * Every count read here comes from `EventSummary`, which is a declared shape
 * rather than a validated one (`apiFetch` asserts), so each is passed through
 * `countOf` before it reaches a sentence.
 */

import type { OperationalState } from "../components/StatusBadge";
import { parseTimestamp } from "../lib/formatTime";
import type { Approval, CommandCenterData, EventSummary } from "../types";

/* --- Copy (design.md §1.2, §8.1, §12.2) ----------------------------------- */

/** The page name, used as the heading when the token carries no `name` claim. */
export const PAGE_NAME = "Command Center";

/** Requirement 4.8 / design.md §12.2 — the calm state, verbatim. */
export const CALM_TITLE = "Abhi koi drama nahi.";
export const CALM_DESCRIPTION = "CommunityOps is keeping things moving.";

/**
 * The slot-two sentence for an operation that needs no *decision* but is not
 * calm: something is open, and the visual below states what.
 *
 * It states no count on purpose (requirement 4.10): the counts belong to the
 * greeting context line and to the visual, and a third place to read them would
 * be the beginning of the KPI wall design.md §8.1 rules out.
 */
export const NO_DECISION_TITLE = "Nothing needs your decision right now.";
export const NO_DECISION_DESCRIPTION = "CommunityOps is on the open items below.";

/** The visual's own heading and empty sentence (requirement 4.4). */
export const ORBIT_HEADING = "What CommunityOps is watching";
export const ORBIT_EMPTY = "CommunityOps isn't watching any active or published events yet.";

/** The handled strip (requirement 4.6). design.md §7 names it in these words. */
export const HANDLED_HEADING = "CommunityOps is handling";
export const HANDLED_EMPTY = "CommunityOps hasn't recorded any activity for this event yet.";

/** Requirement 4.7 — the org-wide feed says so, in the label and the sentence. */
export const ORG_WIDE_HEADING = "Organization-wide activity";
export const ORG_WIDE_EMPTY = "No activity recorded across your organization yet.";

/** Requirement 5.7 / A9 — recorded, with no claim that execution continues. */
export const DECISION_RECORDED = "Decision recorded.";

/** Announced while the page's first load is in flight (design.md §12.2). */
export const LOADING_LABEL = "Getting the latest operation state…";

/* --- Small helpers -------------------------------------------------------- */

/** A count, defended against a non-numeric or negative value in a response. */
function countOf(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function plural(count: number, singular: string, many: string): string {
  return count === 1 ? singular : many;
}

/* --- The greeting --------------------------------------------------------- */

/**
 * The page's single heading (requirement 4.1).
 *
 * With no usable `name` claim it is the page name: `readDisplayName` returns
 * `null` rather than a guess, and the console never invents a name (A2).
 */
export function greeting(name: string | null): string {
  return name === null ? PAGE_NAME : `Hello, ${name}`;
}

/**
 * The watched-event count for the greeting context line (requirement 4.2, A13).
 *
 * `active_events` is the headline. `total_events` appears only as "of N total",
 * and only when it is actually larger — a total identical to the headline adds a
 * number and no information.
 */
export function watchedEventLine(summary: CommandCenterData["summary"]): string {
  const active = countOf(summary.active_events);
  const total = countOf(summary.total_events);
  const headline = `CommunityOps is watching ${active} ${plural(active, "event", "events")}`;

  return total > active ? `${headline}, of ${total} total.` : `${headline}.`;
}

/* --- Watched events ------------------------------------------------------- */

/** One watched event, as the visual and its text alternative render it. */
export interface WatchedEventView {
  readonly eventId: string;
  readonly name: string;
  /** The event's own status, still an untyped `string` in the contract. */
  readonly status: string;
  readonly state: OperationalState;
  readonly pendingApprovals: number;
  readonly criticalIncidents: number;
  readonly overdueTasks: number;
  readonly blockedTasks: number;
  /** The four counts added up: how much of this event is not moving on its own. */
  readonly attentionCount: number;
  /** The same counts in words, for the visual's text alternative (15.12). */
  readonly summary: string;
}

/** Copy for a watched event with nothing open against it. */
export const NOTHING_WAITING = "nothing waiting";

/**
 * Which of the three operational states an event is in (requirement 12.9),
 * derived from the four counts requirement 4.4 names and from nothing else.
 *
 * The precedence is the order a leader would want it in:
 *
 *   1. a pending approval is literally a decision waiting on them, so it wins;
 *   2. a critical incident, an overdue task or a blocked task is work
 *      CommunityOps cannot clear on its own — it needs a person, which is what
 *      "Cannot be automated" says;
 *   3. otherwise the event is progressing normally, which is "Handled".
 *
 * `blocked_tasks` is deliberately part of step 2 rather than a state of its own:
 * §1.1 has three operational states and requirement 12.9 allows exactly one per
 * item.
 */
export function watchedEventState(event: EventSummary): OperationalState {
  if (countOf(event.pending_approvals) > 0) {
    return "NEEDS_DECISION";
  }

  const unautomatable =
    countOf(event.critical_incidents) +
    countOf(event.overdue_tasks) +
    countOf(event.blocked_tasks);

  return unautomatable > 0 ? "CANNOT_BE_AUTOMATED" : "HANDLED";
}

/** The four counts as one readable clause. */
function attentionSummary(event: EventSummary): string {
  const approvals = countOf(event.pending_approvals);
  const incidents = countOf(event.critical_incidents);
  const overdue = countOf(event.overdue_tasks);
  const blocked = countOf(event.blocked_tasks);
  const parts: string[] = [];

  if (approvals > 0) {
    parts.push(`${approvals} ${plural(approvals, "decision", "decisions")} waiting`);
  }
  if (incidents > 0) {
    parts.push(`${incidents} critical ${plural(incidents, "incident", "incidents")}`);
  }
  if (overdue > 0) {
    parts.push(`${overdue} overdue ${plural(overdue, "task", "tasks")}`);
  }
  if (blocked > 0) {
    parts.push(`${blocked} blocked ${plural(blocked, "task", "tasks")}`);
  }

  return parts.length === 0 ? NOTHING_WAITING : parts.join(", ");
}

/** Compose the visual's nodes from `events[]` — watched events only (A13). */
export function toWatchedEventViews(
  events: readonly EventSummary[],
): readonly WatchedEventView[] {
  return events.map((event) => {
    const pendingApprovals = countOf(event.pending_approvals);
    const criticalIncidents = countOf(event.critical_incidents);
    const overdueTasks = countOf(event.overdue_tasks);
    const blockedTasks = countOf(event.blocked_tasks);

    return {
      eventId: event.event_id,
      name: event.name,
      status: event.status,
      state: watchedEventState(event),
      pendingApprovals,
      criticalIncidents,
      overdueTasks,
      blockedTasks,
      attentionCount: pendingApprovals + criticalIncidents + overdueTasks + blockedTasks,
      summary: attentionSummary(event),
    };
  });
}

/**
 * The sentence the visual states in text (requirements 15.12, 4.4).
 *
 * It counts the nodes actually drawn rather than repeating the headline: the
 * greeting line answers "how many events is CommunityOps watching", and this
 * answers "what is in this picture". `events[]` carries ACTIVE and PUBLISHED
 * events, so the two numbers can legitimately differ and the wording keeps them
 * distinguishable (A13).
 */
export function orbitAlternative(views: readonly WatchedEventView[]): string {
  const count = views.length;

  return `${count} active and published ${plural(count, "event", "events")} in this view.`;
}

/**
 * Requirement 4.8's condition, exactly as written: no pending approval, no
 * critical incident and no overdue task across watched events.
 *
 * `blocked_tasks` is not part of it. A blocked task is a dependency waiting, not
 * a drama — §6.4 gives it a neutral treatment — and the criterion names three
 * counts.
 */
export function nothingNeedsYou(views: readonly WatchedEventView[]): boolean {
  return views.every(
    (view) =>
      view.pendingApprovals === 0 && view.criticalIncidents === 0 && view.overdueTasks === 0,
  );
}

/** The watched events with a pending approval: the only ones worth fetching. */
export function eventsWithPendingApprovals(
  events: readonly EventSummary[],
): readonly EventSummary[] {
  return events.filter((event) => countOf(event.pending_approvals) > 0);
}

/* --- The one decision ----------------------------------------------------- */

/**
 * The oldest pending approval (requirement 4.3).
 *
 * "Oldest" is read from `requested_at`, not from response order: the approvals
 * come back from several events, so the order they arrive in is the order the
 * requests resolved. An approval whose timestamp cannot be parsed sinks to the
 * end rather than being dropped or treated as the oldest — the same rule
 * `Timeline` applies — and the original position breaks ties, so the result is
 * stable for identical timestamps.
 *
 * @returns the approval to render as the single decision surface, or `null` when
 * nothing is pending.
 */
export function oldestPendingApproval(approvals: readonly Approval[]): Approval | null {
  const pending = approvals
    .filter((approval) => approval.status === "PENDING")
    .map((approval, index) => {
      const parsed = parseTimestamp(approval.requested_at);

      return { approval, index, time: parsed === null ? null : parsed.getTime() };
    });

  pending.sort((a, b) => {
    if (a.time === null || b.time === null) {
      if (a.time === b.time) return a.index - b.index;

      return a.time === null ? 1 : -1;
    }

    if (a.time === b.time) return a.index - b.index;

    return a.time - b.time;
  });

  return pending[0]?.approval ?? null;
}

/**
 * The note sent with a decision.
 *
 * `api.ts::decideApproval` sends `{decision, notes}` and carries no
 * `edited_action` field, so an adjusted wording is recorded *as the note* —
 * which is the audit trail — rather than silently dropped. That is exactly what
 * `EDITED_OUTCOME` in `src/lib/decisionConsequence.ts` promises the user, and it
 * is why this function exists instead of the page reaching for `notes` directly.
 * Raising the request to `edited_action` fidelity belongs to the Approvals phase
 * that owns the client (A4).
 */
export function noteFor(request: {
  readonly notes: string;
  readonly editedAction?: string;
}): string {
  const edited = request.editedAction?.trim() ?? "";

  return edited === "" ? request.notes : edited;
}
