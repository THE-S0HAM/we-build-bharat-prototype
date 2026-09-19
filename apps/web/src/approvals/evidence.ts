/**
 * Approval evidence, read through an allowlist (A11, requirements 5.9, 5.10,
 * 16.5, 16.6; correctness properties 10, 11, 12).
 *
 * `evidence` is an unstructured `Record<string, unknown>` written by whichever
 * agent raised the approval, and `approvals_handler._list_approvals` returns raw
 * DynamoDB items — so it can carry anything the backend put on the item,
 * including personal data and, until the documented backend fix lands, the Step
 * Functions `task_token` and `workflow_execution_id` (A8). The page this module
 * serves used to render `JSON.stringify(evidence)` in a `<pre>`, which published
 * every one of those.
 *
 * So evidence is not rendered. It is *read*, key by key, against a fixed list:
 *
 *   - a key on the list, whose value is a short primitive → one labelled row;
 *   - a recognised amount (plus its currency, where the data states one) → the
 *     financial consequence line, and no row;
 *   - **everything else → a count, and nothing more.** An unknown key's name is
 *     never shown, its value is never shown, and nothing anywhere serializes the
 *     object. A token added to the item tomorrow lands in that count.
 *
 * The financial line is conditional for the same reason (A10): seeded approvals
 * carry `{incident_id, backup_speaker}` and `{speaker_id, followup_count}` with
 * no amount at all, so the reference design's "₹12,500 estimated commitment"
 * would have been fabricated. A figure renders only when the evidence states one.
 */

/* --- Keys that render ----------------------------------------------------- */

/**
 * The allowlist, and the label each key renders under. Insertion order is
 * presentation order, so evidence reads the same way on every card regardless of
 * the order the backend serialized the object in.
 *
 * Every entry is an identifier or a count — a reference to a record the console
 * can already show. No key that carries free text, a name, an email or a phone
 * number is on this list, so an allowlisted row cannot become a PII leak.
 */
const ROW_LABELS: Readonly<Record<string, string>> = {
  incident_id: "Incident",
  speaker_id: "Speaker",
  backup_speaker: "Backup speaker",
  followup_count: "Follow-ups already sent",
  task_id: "Task",
  team_id: "Team",
  registration_id: "Registration",
  session_type: "Session type",
  severity: "Severity",
  threshold: "Threshold",
};

/**
 * Amount fields, in the order they are preferred. A `_inr` suffix states its own
 * currency; the unsuffixed names take a currency from the `currency` field or go
 * without one.
 */
const AMOUNT_KEYS: readonly string[] = [
  "amount_inr",
  "estimated_amount_inr",
  "estimated_cost_inr",
  "total_amount_inr",
  "amount",
  "estimated_amount",
  "estimated_cost",
  "total_amount",
];

/** Qualifies an amount rather than standing on its own, so it renders no row. */
const CURRENCY_KEY = "currency";

/**
 * Longest string value a row will render. Evidence values are identifiers and
 * counts; anything longer than this is not one, so it is counted rather than
 * printed. A cap is the cheapest guard against an allowlisted key that starts
 * carrying a paragraph.
 */
const MAX_VALUE_LENGTH = 120;

/** One locale for every number the console formats (matches `formatTime.ts`). */
const LOCALE = "en-IN";

const numberFormatter = new Intl.NumberFormat(LOCALE);

/* --- The view ------------------------------------------------------------- */

export interface EvidenceRow {
  /** The allowlisted key, used as a stable React key. Not rendered. */
  readonly key: string;
  readonly label: string;
  /** Already formatted for display. Never a serialized object. */
  readonly value: string;
}

export interface EvidenceAmount {
  /** The amount field this came from, so it is not also counted or rowed. */
  readonly key: string;
  readonly amount: number;
  /** An ISO currency code the evidence stated, or `null` when it stated none. */
  readonly currency: string | null;
}

export interface EvidenceView {
  readonly rows: readonly EvidenceRow[];
  /**
   * How many keys were present and not rendered. The only thing the console ever
   * says about them (requirement 5.9).
   */
  readonly unrecognisedCount: number;
  /** Present only when the evidence states a figure (requirement 5.10). */
  readonly amount: EvidenceAmount | null;
}

const EMPTY_VIEW: EvidenceView = { rows: [], unrecognisedCount: 0, amount: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite number from a JSON number or a plain numeric string, or `null`. */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  // Python `Decimal` fields serialize as strings through some code paths, so a
  // plain decimal string counts. Anything else — "about 12k", "", "1e5" — does
  // not: a figure is either stated exactly or not stated.
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/**
 * Display text for an allowlisted value, or `null` when the value is not
 * something this module will print. Objects, arrays, `null`, empty strings, NaN
 * and over-long strings all resolve to `null` and are counted instead — which is
 * what keeps serialization out of the page entirely.
 */
function renderableValue(value: unknown): string | null {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? numberFormatter.format(value) : null;
  }
  if (typeof value === "string") {
    const text = value.trim();
    return text === "" || text.length > MAX_VALUE_LENGTH ? null : text;
  }
  return null;
}

/** "INR" for a `_inr` key, otherwise whatever the evidence's `currency` states. */
function resolveCurrency(key: string, evidence: Record<string, unknown>): string | null {
  if (/_inr$/i.test(key)) {
    return "INR";
  }

  const stated = evidence[CURRENCY_KEY];

  return typeof stated === "string" && /^[A-Za-z]{3}$/.test(stated.trim())
    ? stated.trim().toUpperCase()
    : null;
}

function readAmount(evidence: Record<string, unknown>): EvidenceAmount | null {
  for (const key of AMOUNT_KEYS) {
    if (!Object.hasOwn(evidence, key)) {
      continue;
    }

    const amount = toFiniteNumber(evidence[key]);
    if (amount === null) {
      // An amount-shaped key carrying something that is not a figure is not a
      // figure. It falls through to the unrecognised count.
      continue;
    }

    return { key, amount, currency: resolveCurrency(key, evidence) };
  }

  return null;
}

/**
 * Read an approval's evidence into the only three things the console shows about
 * it: labelled rows, one optional figure, and a count of everything else.
 *
 * Takes `unknown` because `Approval.evidence` is a declared shape rather than a
 * verified one — `apiFetch` asserts response types — so a missing or non-object
 * value has to resolve rather than throw.
 */
export function readEvidence(evidence: unknown): EvidenceView {
  if (!isRecord(evidence)) {
    return EMPTY_VIEW;
  }

  const amount = readAmount(evidence);
  const rows: EvidenceRow[] = [];

  for (const [key, label] of Object.entries(ROW_LABELS)) {
    if (!Object.hasOwn(evidence, key)) {
      continue;
    }

    const value = renderableValue(evidence[key]);
    if (value !== null) {
      rows.push({ key, label, value });
    }
  }

  const rendered = new Set(rows.map((row) => row.key));
  let unrecognisedCount = 0;

  for (const key of Object.keys(evidence)) {
    // Rendered as a row, consumed by the financial line, or a currency code that
    // qualified one. Everything else is counted — including a `task_token`, a
    // `workflow_execution_id`, and any key added to the item in future (A8).
    if (rendered.has(key) || key === amount?.key || key === CURRENCY_KEY) {
      continue;
    }

    unrecognisedCount += 1;
  }

  return { rows, unrecognisedCount, amount };
}

/* --- Copy ----------------------------------------------------------------- */

/** The figure, exactly as the evidence stated it. Nothing is derived from it. */
export function formatEvidenceAmount({ amount, currency }: EvidenceAmount): string {
  if (currency === null) {
    return numberFormatter.format(amount);
  }

  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * The financial consequence line (requirement 5.10).
 *
 * When the evidence names no currency the figure is still shown, and the sentence
 * says so rather than assuming one. Inventing ₹ over an unlabelled number is the
 * same class of mistake as inventing the number.
 */
export function financialConsequenceLine(amount: EvidenceAmount): string {
  const figure = formatEvidenceAmount(amount);

  return amount.currency === null
    ? `Financial commitment if you approve: ${figure}. The evidence does not state a currency.`
    : `Financial commitment if you approve: ${figure}.`;
}

/**
 * The single sentence that stands in for every unrendered key (requirement 5.9).
 * It states how many there are and why they are not shown, and names none of them.
 */
export function unrecognisedEvidenceNotice(count: number): string {
  const subject = count === 1 ? "1 more field is" : `${count} more fields are`;

  return `${subject} recorded on this approval but not shown, because CommunityOps displays only the fields it recognises.`;
}
