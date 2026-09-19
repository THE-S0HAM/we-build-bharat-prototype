/**
 * Mapping backend status values onto the UI's status vocabulary.
 *
 * Lives outside `primitives.tsx` so that file exports components only — a module mixing
 * components with plain functions breaks Fast Refresh, and this is also the piece most worth
 * testing on its own.
 *
 * The backend has far more states than a leader needs to distinguish. `RECOMMENDATION_READY` and
 * `ANALYZING` are both "the agent is on it"; `DECLINED` and `REJECTED` are both "this is not
 * happening". Collapsing them onto shared tones is deliberate: the label stays specific, only the
 * colour is shared, so nothing is hidden but the screen does not ask the reader to learn thirteen
 * colours.
 */

import type { StatusTone } from "./types";

/**
 * Choose the tone for a backend status value.
 *
 * Unknown values fall back to `pending` rather than producing `badge-undefined`, which would
 * render unstyled and effectively invisible. A status nobody anticipated should look uncertain,
 * not disappear.
 */
export function toneFor(status: string | undefined): StatusTone {
  switch ((status || "").toUpperCase()) {
    // Finished, and finished well.
    case "COMPLETED":
    case "RESOLVED":
    case "CLOSED":
    case "CONFIRMED":
    case "APPROVED":
      return "completed";

    // Nothing is moving, or it is not happening at all.
    case "BLOCKED":
    case "DECLINED":
    case "REJECTED":
    case "CANCELLED":
      return "blocked";

    case "OVERDUE":
      return "overdue";

    // Somebody has to decide before this can move.
    case "PENDING":
    case "AWAITING_APPROVAL":
      return "needs-decision";

    // Moving, but in the wrong direction or running out of time. `EXPIRED` and `ESCALATED` belong
    // here rather than in the neutral fallback: an approval that timed out and an incident that
    // was escalated are both situations that got worse while nobody acted, and rendering them as
    // ordinary "pending" would hide exactly that.
    case "AT_RISK":
    case "AWAITING_RESPONSE":
    case "FOLLOWUP_SENT":
    case "EXPIRED":
    case "ESCALATED":
    case "REOPENED":
    case "PAUSED":
      return "at-risk";

    // Under way. Nothing is required of the reader.
    case "IN_PROGRESS":
    case "ANALYZING":
    case "EXECUTING":
    case "RECOMMENDATION_READY":
    case "EDITED":
    case "ACTIVE":
    case "PUBLISHED":
      return "info";

    // No risk attached. Distinct from LOW, which is a small risk rather than none.
    case "NONE":
      return "handled";

    // A capability no role may exercise. Never shown as merely high risk, because the boundary is
    // categorical rather than a matter of degree.
    case "NEVER":
      return "cannot-automate";

    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MEDIUM":
      return "medium";
    case "LOW":
      return "low";

    default:
      return "pending";
  }
}
