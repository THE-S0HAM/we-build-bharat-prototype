/**
 * "Recently decided" — the decisions taken in *this* session (requirement 5.11,
 * A3).
 *
 * `GET /events/{eventId}/approvals` queries `GSI1` with
 * `sk_begins_with="APPROVAL#PENDING"`, so it returns pending items and nothing
 * else. There is no endpoint that returns a decided approval, which is why the
 * page's old "Resolved" table could never populate and has been deleted.
 *
 * This strip is the honest replacement: it is built from what the user did in
 * the tab they are looking at, it says so in as many words, and it hands them
 * the durable record — the Audit Log, which really does carry
 * `APPROVAL_APPROVED` / `APPROVAL_DECLINED` / `APPROVAL_EDITED`. It makes no
 * claim to be a history. Reload and it is empty, because the session is gone and
 * the strip never pretended to outlive it.
 *
 * Newest first: this is a short-term record of what you just did, which reads
 * backwards from the queue itself (oldest first, because the oldest decision is
 * the most overdue).
 */

import { Link } from "react-router-dom";

import { formatAbsoluteTime, formatRelativeTime, toMachineTime } from "../lib/formatTime";
import { NAV_ITEMS } from "../navConfig";
import { decisionOutcome, type ApprovalDecision } from "./decision";

import "./RecentlyDecided.css";

export const RECENTLY_DECIDED_HEADING = "Recently decided";

/**
 * Requirement 5.11's label. It states the scope and names where the durable
 * record lives, so nothing here can be mistaken for an approval history.
 */
export const SESSION_SCOPE_NOTICE =
  "Decided by you in this session. The durable record is the Audit Log.";

export const AUDIT_LOG_LINK_LABEL = "Open the Audit Log";

/**
 * The Audit Log route, read from the one navigation list rather than spelled a
 * second time here (`navConfig.ts` is the single source of what the console
 * navigates to). If that entry ever goes away the link goes with it, instead of
 * pointing at a path this file believes in on its own.
 */
const AUDIT_LOG_ENTRY = NAV_ITEMS.find((item) => item.id === "audit-log");

/** One decision the user took in this session. */
export interface SessionDecision {
  /** Stable React key; also what stops one approval being listed twice. */
  readonly approvalId: string;
  readonly title: string;
  readonly decision: ApprovalDecision;

  /**
   * The prepared action, so the outcome sentence can be the concrete one rather
   * than a generic "this action" (requirement 5.7).
   */
  readonly requestedAction: string;

  /** When the decision was recorded, as an ISO-8601 string. */
  readonly decidedAt: string;
}

export interface RecentlyDecidedProps {
  /** Newest first. Rendered in the order given. */
  readonly decisions: readonly SessionDecision[];
}

/**
 * Renders nothing until there is something to show: requirement 5.11 is a
 * `WHILE`, so an empty strip with a heading and a disclaimer would be furniture
 * on a page whose whole job is to be about what needs deciding.
 */
export function RecentlyDecided({ decisions }: RecentlyDecidedProps) {
  if (decisions.length === 0) {
    return null;
  }

  return (
    <section className="card recently-decided" aria-labelledby="recently-decided-heading">
      <div className="recently-decided__head">
        <h2 className="recently-decided__heading" id="recently-decided-heading">
          {RECENTLY_DECIDED_HEADING}
        </h2>
        <p className="recently-decided__scope">{SESSION_SCOPE_NOTICE}</p>
      </div>

      <ul className="recently-decided__list">
        {decisions.map((entry) => (
          <li className="recently-decided__item" key={entry.approvalId}>
            <span className="recently-decided__title">{entry.title}</span>
            <span className="recently-decided__outcome">
              {decisionOutcome(entry.decision, entry.requestedAction)}
            </span>
            {/* One formatter for every timestamp in the product, with the
                absolute time on the element itself (design.md §7.1). */}
            <time
              className="recently-decided__time"
              dateTime={toMachineTime(entry.decidedAt) ?? undefined}
              title={formatAbsoluteTime(entry.decidedAt)}
            >
              {formatRelativeTime(entry.decidedAt)}
            </time>
          </li>
        ))}
      </ul>

      {AUDIT_LOG_ENTRY === undefined ? null : (
        <Link className="recently-decided__link" to={AUDIT_LOG_ENTRY.path}>
          {AUDIT_LOG_LINK_LABEL}
        </Link>
      )}
    </section>
  );
}
