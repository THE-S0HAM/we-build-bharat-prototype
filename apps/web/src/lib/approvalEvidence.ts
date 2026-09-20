/**
 * Reading `Approval.evidence` for display — allowlist only (A10, A11).
 *
 * `evidence` is a free-form dict on the backend: the seeded approvals carry
 * `{incident_id, backup_speaker}` and `{speaker_id, followup_count}`, and
 * `incident_response.py` stores whatever the agent's recommendation object held.
 * Two rules follow, and this module is where both are enforced:
 *
 *   - **A11 — never render raw JSON.** A key is rendered only if it is in
 *     `EVIDENCE_LABELS` *and* its value is a primitive that reads as text.
 *     Everything else is counted, never serialized: "3 further data points
 *     recorded". No `JSON.stringify` appears in the product.
 *   - **A10 — never synthesize a figure.** A financial line exists only when
 *     `evidence` carries one of the recognised amount keys with a finite number
 *     in it. No estimate, no default currency when none is recorded, no total
 *     derived from anything else.
 *
 * Pure, so the rules are testable without rendering, and shared by every surface
 * that shows a decision (the Command Center drawer today, Approvals next).
 */

/** One row of evidence, ready to render as a labelled pair. */
export interface EvidenceRow {
  /** The key this row came from, for a stable React key. */
  readonly key: string;
  /** Reviewed label. Never the raw key. */
  readonly label: string;
  /** The value as display text. Already known to be safe to render. */
  readonly value: string;
}

export interface EvidenceFinancialLine {
  readonly label: string;
  /** Formatted with the recorded currency, or as a plain number without one. */
  readonly value: string;
}

export interface EvidenceView {
  readonly rows: readonly EvidenceRow[];
  /**
   * Keys that were not rendered, for the "N further data points recorded" line.
   * A count is the whole disclosure: the values themselves may be personal data
   * (A11) or a nested object, and neither belongs on screen.
   */
  readonly unrecognisedCount: number;
  /** `null` unless a recognised amount field carried a finite number (A10). */
  readonly financial: EvidenceFinancialLine | null;
}

/**
 * The rendered keys. Everything outside this table is counted, so a backend that
 * starts writing a new key cannot leak it by default.
 */
const EVIDENCE_LABELS: Readonly<Record<string, string>> = {
  incident_id: "Incident",
  speaker_id: "Speaker",
  backup_speaker: "Backup speaker",
  followup_count: "Follow-ups already sent",
  recommendation: "What CommunityOps proposes",
  task_id: "Task",
  team_id: "Team",
  registration_id: "Registration",
  session_type: "Session type",
  severity: "Severity recorded",
};

/**
 * Amount keys, with the label each one earns. The label states what the number
 * actually is, so an "estimated" key never reads as a committed figure.
 */
const AMOUNT_LABELS: Readonly<Record<string, string>> = {
  amount: "Amount",
  total_amount: "Total amount",
  estimated_amount: "Estimated commitment",
  estimated_cost: "Estimated cost",
  cost: "Cost",
};

/** The key an amount's currency is read from, when one is recorded. */
const CURRENCY_KEY = "currency";

/** One locale for every formatted number, matching `src/lib/formatTime.ts`. */
const LOCALE = "en-IN";

/**
 * Longest evidence string that still reads as a value rather than a document.
 * Anything longer is counted instead of rendered: a recommendation paragraph is
 * the drawer's `reason` field's job, and an unbounded string is a layout and a
 * disclosure risk.
 */
const MAX_VALUE_LENGTH = 240;

const plainNumberFormatter = new Intl.NumberFormat(LOCALE);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The value as display text, or `null` when it must be counted instead.
 *
 * Objects and arrays return `null` by construction — that is the whole of the
 * "no raw JSON" rule. Booleans read as words so a flag is never shown as `true`.
 */
function displayValue(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.trim();

    return text === "" || text.length > MAX_VALUE_LENGTH ? null : text;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? plainNumberFormatter.format(value) : null;
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  return null;
}

/**
 * Format a recorded amount.
 *
 * With a recorded three-letter currency code the number is formatted in that
 * currency; without one it is formatted as a plain number and the label carries
 * the meaning. A currency symbol is never assumed — "₹12,500" from a bare
 * `12500` would be a synthesized figure (A10).
 */
function formatAmount(amount: number, currency: unknown): string {
  if (typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(LOCALE, {
        style: "currency",
        currency: currency.toUpperCase(),
      }).format(amount);
    } catch {
      // An unknown code throws rather than falling back, so the plain number is
      // used and nothing claims a currency the data does not name.
      return plainNumberFormatter.format(amount);
    }
  }

  return plainNumberFormatter.format(amount);
}

/**
 * Partition an approval's evidence into rendered rows, a counted remainder and
 * the optional financial line.
 *
 * Typed as `unknown` rather than `Record<string, unknown>` because
 * `Approval.evidence` is a declared shape, not a validated one: the workflows
 * write the agent's recommendation object into it, and a non-object value has to
 * resolve to "nothing to show" instead of throwing during render.
 */
export function readEvidence(evidence: unknown): EvidenceView {
  if (!isRecord(evidence)) {
    return { rows: [], unrecognisedCount: 0, financial: null };
  }

  const rows: EvidenceRow[] = [];
  let unrecognisedCount = 0;
  let financial: EvidenceFinancialLine | null = null;

  // Resolved first, so the keys it consumes are not also counted below.
  for (const [key, label] of Object.entries(AMOUNT_LABELS)) {
    const value = Object.hasOwn(evidence, key) ? evidence[key] : undefined;

    if (typeof value === "number" && Number.isFinite(value)) {
      financial = { label, value: formatAmount(value, evidence[CURRENCY_KEY]) };
      break;
    }
  }

  for (const [key, value] of Object.entries(evidence)) {
    if (financial !== null && (Object.hasOwn(AMOUNT_LABELS, key) || key === CURRENCY_KEY)) {
      continue;
    }

    const label = Object.hasOwn(EVIDENCE_LABELS, key) ? EVIDENCE_LABELS[key] : undefined;
    const text = label === undefined ? null : displayValue(value);

    if (label === undefined || text === null) {
      unrecognisedCount += 1;
      continue;
    }

    rows.push({ key, label, value: text });
  }

  return { rows, unrecognisedCount, financial };
}

/**
 * The counted-remainder sentence (A11). `null` when there is nothing to count,
 * so the caller renders no line at all.
 */
export function unrecognisedEvidenceNote(count: number): string | null {
  if (count <= 0) {
    return null;
  }

  return count === 1
    ? "1 further data point recorded."
    : `${count} further data points recorded.`;
}
