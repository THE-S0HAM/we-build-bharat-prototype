/**
 * `StatusBadge` — the only component in CommunityOps permitted to turn a status
 * into a colour (requirement 12.5, design.md §6.4). No page and no other
 * component maps a status value to a visual treatment.
 *
 * Two contracts hold for every status this component can render:
 *
 *   1. A text label is always rendered, so the status survives without colour
 *      (requirements 12.9, 15.10, design.md §6.3). The coloured dot repeats the
 *      label, it never replaces it, and it is hidden from assistive technology.
 *   2. Status values come from the real backend unions in `src/types.ts`, read
 *      through indexed access (`Task["status"]`, …) rather than retyped here.
 *      Each table is a `Record` over its union, so a new backend status is a
 *      compile error in this file instead of a silent fall-through to a
 *      default colour. A value the *types* have not caught up with yet — the
 *      unions are asserted by `apiFetch`, not validated — resolves to a neutral
 *      labelled badge instead of throwing mid-render.
 *
 * The four tones are the §6.4 treatments, and nothing else:
 *
 *   | Tone        | §6.4 row(s)                      | Treatment                                     |
 *   |-------------|----------------------------------|-----------------------------------------------|
 *   | `handled`   | Handled                          | `--text-secondary` text, neutral dot, no fill  |
 *   | `attention` | Needs your decision / Overdue    | `--attention-soft` tint, `--attention`         |
 *   | `blocked`   | Cannot be automated / Blocked    | Neutral surface, `--border-strong`             |
 *   | `muted`     | Completed                        | `--text-muted` pill, lowest weight on the page |
 *
 * `--risk` and `--risk-soft` are deliberately absent: the red is reserved for
 * CRITICAL severity and destructive confirmation (design.md §6.4), which is
 * `RiskIndicator`'s table, not this one.
 *
 * Risk and severity levels are not part of this component. They render through
 * `RiskIndicator`, which owns the two risk rows of §6.4.
 */

import type { ReactElement } from "react";
import { humaniseUnknownValue, readTableEntry } from "../lib/unknownValue";
import type {
  Approval,
  Event,
  Registration,
  Speaker,
  Task,
  VerificationCheck,
} from "../types";
import "./StatusBadge.css";

/**
 * The three operational states from design.md §1.1. Requirement 12.9 says every
 * operational item renders exactly one of them, so they are a first-class
 * domain here rather than something a page derives.
 */
export type OperationalState = "HANDLED" | "NEEDS_DECISION" | "CANNOT_BE_AUTOMATED";

type Tone = "handled" | "attention" | "blocked" | "muted";

interface Presentation {
  /** Always rendered. Colour is never the only signal. */
  readonly label: string;
  readonly tone: Tone;
}

/** design.md §1.1 and §15.2 — these three labels are canonical copy. */
const OPERATIONAL_STATES: Record<OperationalState, Presentation> = {
  HANDLED: { label: "Handled", tone: "handled" },
  NEEDS_DECISION: { label: "Needs your decision", tone: "attention" },
  CANNOT_BE_AUTOMATED: { label: "Cannot be automated", tone: "blocked" },
};

const EVENT_STATUSES: Record<Event["status"], Presentation> = {
  DRAFT: { label: "Draft", tone: "muted" },
  PUBLISHED: { label: "Published", tone: "handled" },
  ACTIVE: { label: "Active", tone: "handled" },
  PAUSED: { label: "Paused", tone: "attention" },
  COMPLETED: { label: "Completed", tone: "muted" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
  ARCHIVED: { label: "Archived", tone: "muted" },
};

const REGISTRATION_STATUSES: Record<Registration["status"], Presentation> = {
  CONFIRMED: { label: "Confirmed", tone: "handled" },
  PENDING: { label: "Pending", tone: "handled" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
  // A waitlisted attendee needs capacity that no agent can create.
  WAITLISTED: { label: "Waitlisted", tone: "blocked" },
};

const PAYMENT_STATUSES: Record<Registration["payment_status"], Presentation> = {
  CAPTURED: { label: "Paid", tone: "handled" },
  PENDING: { label: "Payment pending", tone: "handled" },
  // Reconciliation has no automated path left once the gateway rejected it.
  FAILED: { label: "Payment failed", tone: "blocked" },
  REFUNDED: { label: "Refunded", tone: "muted" },
  NOT_REQUIRED: { label: "No payment required", tone: "muted" },
};

const SPEAKER_STATUSES: Record<Speaker["status"], Presentation> = {
  // Everything up to CONFIRMED is SpeakerOps working the invitation on its own,
  // which §1.1 counts as Handled ("progressing normally"), not as a decision.
  IDENTIFIED: { label: "Identified", tone: "handled" },
  INVITED: { label: "Invited", tone: "handled" },
  AWAITING_RESPONSE: { label: "Awaiting response", tone: "handled" },
  FOLLOWUP_SENT: { label: "Follow-up sent", tone: "handled" },
  CONFIRMED: { label: "Confirmed", tone: "handled" },
  // A declined speaker leaves a slot only a person can refill.
  DECLINED: { label: "Declined", tone: "blocked" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
  BACKUP: { label: "Backup", tone: "muted" },
};

const TASK_STATUSES: Record<Task["status"], Presentation> = {
  BACKLOG: { label: "Backlog", tone: "muted" },
  PENDING: { label: "Pending", tone: "handled" },
  ASSIGNED: { label: "Assigned", tone: "handled" },
  IN_PROGRESS: { label: "In progress", tone: "handled" },
  BLOCKED: { label: "Blocked", tone: "blocked" },
  REVIEW: { label: "In review", tone: "handled" },
  COMPLETED: { label: "Completed", tone: "muted" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
  OVERDUE: { label: "Overdue", tone: "attention" },
};

const APPROVAL_STATUSES: Record<Approval["status"], Presentation> = {
  // The §6.4 "Needs your decision" row. A pending approval is never labelled
  // "Pending": §15.2 rules that out as a synonym.
  PENDING: { label: "Needs your decision", tone: "attention" },
  APPROVED: { label: "Approved", tone: "handled" },
  EDITED: { label: "Approved with edits", tone: "handled" },
  DECLINED: { label: "Declined", tone: "muted" },
  // An expired approval was never decided, so it still needs a person.
  EXPIRED: { label: "Expired", tone: "blocked" },
};

const VERIFICATION_STATUSES: Record<VerificationCheck["status"], Presentation> = {
  PASS: { label: "Pass", tone: "handled" },
  WARN: { label: "Warning", tone: "attention" },
  FAIL: { label: "Fail", tone: "blocked" },
};

interface BaseProps {
  /**
   * Supplementary text rendered beside the pill, not inside it. §6.4 requires it
   * for two rows: "Blocked" carries the blocking reason inline and "Overdue"
   * carries the relative age.
   */
  readonly detail?: string;
}

/**
 * The domain names the contract the status came from, so a status value can only
 * ever be paired with the union it belongs to.
 */
export type StatusBadgeProps = BaseProps &
  (
    | { readonly domain: "operational"; readonly status: OperationalState }
    | { readonly domain: "event"; readonly status: Event["status"] }
    | { readonly domain: "registration"; readonly status: Registration["status"] }
    | { readonly domain: "payment"; readonly status: Registration["payment_status"] }
    | { readonly domain: "speaker"; readonly status: Speaker["status"] }
    | { readonly domain: "task"; readonly status: Task["status"] }
    | { readonly domain: "approval"; readonly status: Approval["status"] }
    | { readonly domain: "verification"; readonly status: VerificationCheck["status"] }
  );

/** Copy used when an unrecognised status carries no readable text of its own. */
export const UNKNOWN_STATUS_LABEL = "Status unavailable";

/**
 * Treatment for a status none of the tables above define.
 *
 * The tables stay `Record<Union, Presentation>`, so a status the *types* declare
 * and a table omits is still a compile error. This covers the other direction:
 * `apiFetch` asserts response shapes rather than validating them (see
 * `src/lib/unknownValue.ts`), so a backend status outside the declared union
 * reaches this component. It used to throw here and take the page down.
 *
 * §6.4 defines no treatment for a status it does not list, so the badge takes
 * `muted` — the lowest-weight neutral in the table. It neither claims the item
 * is Handled nor dresses an unknown as attention or a blocker, and the label
 * still carries the value in words (requirements 12.9, 15.10).
 */
function unknownStatusPresentation(status: string): Presentation {
  return {
    label: humaniseUnknownValue(status) ?? UNKNOWN_STATUS_LABEL,
    tone: "muted",
  };
}

/**
 * Read one status table, degrading to the neutral presentation when the value is
 * outside the union the table is keyed on.
 *
 * `K` is inferred from both arguments, so a branch below cannot pair a status
 * with another domain's table without a compile error.
 */
function present<K extends string>(table: Record<K, Presentation>, status: K): Presentation {
  return readTableEntry(table, status) ?? unknownStatusPresentation(status);
}

/**
 * Exhaustive by construction: every branch reads a `Record` keyed on the whole
 * union, and the `never` binding in the default branch stops compiling the day a
 * domain is added without a table.
 */
function resolve(props: StatusBadgeProps): Presentation {
  switch (props.domain) {
    case "operational":
      return present(OPERATIONAL_STATES, props.status);
    case "event":
      return present(EVENT_STATUSES, props.status);
    case "registration":
      return present(REGISTRATION_STATUSES, props.status);
    case "payment":
      return present(PAYMENT_STATUSES, props.status);
    case "speaker":
      return present(SPEAKER_STATUSES, props.status);
    case "task":
      return present(TASK_STATUSES, props.status);
    case "approval":
      return present(APPROVAL_STATUSES, props.status);
    case "verification":
      return present(VERIFICATION_STATUSES, props.status);
    default: {
      const unhandled: never = props;
      return unhandled;
    }
  }
}

const TONE_CLASS: Record<Tone, string> = {
  handled: "status-badge--handled",
  attention: "status-badge--attention",
  blocked: "status-badge--blocked",
  muted: "status-badge--muted",
};

export function StatusBadge(props: StatusBadgeProps): ReactElement {
  const { label, tone } = resolve(props);

  const badge = (
    <span className={`status-badge ${TONE_CLASS[tone]}`}>
      {/* Supplementary only: it repeats the label's colour and is never read out. */}
      <span className="status-badge__dot" aria-hidden="true" />
      <span className="status-badge__label">{label}</span>
    </span>
  );

  if (props.detail === undefined || props.detail === "") {
    return badge;
  }

  return (
    <span className="status-badge-row">
      {badge}
      <span className="status-badge__detail">{props.detail}</span>
    </span>
  );
}
