/**
 * IncidentOps' domain reading — everything the page decides *about* an incident,
 * away from the rendering (design.md §8.5, requirements 8.1, 8.2, 8.4).
 *
 * The page answers "what could disrupt the event?", and a leader should decide
 * on a prepared proposal rather than diagnose the problem. Three readings make
 * that possible, and all three are pure functions so they are testable without a
 * DOM:
 *
 *   1. **Order.** Severity, CRITICAL first, with resolved incidents separated out
 *      so the active ones are never buried under history (requirement 8.1).
 *   2. **Where it stands.** `Incident.status` is typed `string` in
 *      `src/types.ts`, not a union, while the backend's `IncidentStatus` carries
 *      nine values. So there is no status→colour domain for it: the status is
 *      rendered as text, and the thing a leader actually needs — the next action,
 *      and which of the three operational states it is in — is derived here
 *      (requirements 8.2, 12.9).
 *   3. **The analysis.** `impact_analysis`, `dependencies` and
 *      `resolution_summary` are on the backend's `Incident` model and in the
 *      `PUT` allowlist, but not yet on the typed `Incident` in `src/types.ts`.
 *      They are declared and validated here instead, so the drawer still renders
 *      only fields a typed model declares (requirement 16.5) — see
 *      `readIncidentAnalysis`.
 *
 * `impact_analysis` deserves its own warning: `services/workflows/incident_response.py`
 * writes it with `json.dumps(...)`, so the field frequently holds a JSON object
 * rather than prose. A11 forbids rendering raw JSON anywhere, so a structured
 * value is read into labelled rows from a known-key allowlist with the
 * unrecognised keys counted — the same rule the approvals evidence rows follow.
 */

import { humaniseUnknownValue, readTableEntry } from "../lib/unknownValue";
import type { Approval, Incident } from "../types";

/* ---------------------------------------------------------------------------
 * Severity ordering
 * ------------------------------------------------------------------------ */

/** Most severe first. `Incident["severity"]` is a real union, so this is total. */
export const SEVERITY_ORDER: readonly Incident["severity"][] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
];

/**
 * Sort position for a severity: 0 is CRITICAL.
 *
 * A severity outside the declared union sorts *after* the four — `apiFetch`
 * asserts response shapes rather than validating them, so an unknown value can
 * arrive, and ranking it above CRITICAL would let a value nothing has
 * established outrank a real critical incident.
 */
export function severityRank(severity: string): number {
  const rank = SEVERITY_ORDER.findIndex((known) => known === severity);

  return rank === -1 ? SEVERITY_ORDER.length : rank;
}

/** A usable authoritative resolution time, or null when the backend has cleared/omitted it. */
export function resolvedTimestamp(incident: Incident): string | null {
  const timestamp = incident.resolved_at;
  return typeof timestamp === "string" && timestamp.trim() !== "" ? timestamp : null;
}

/** The exact terminal set shared by the backend incident model and list endpoint. */
const CLOSED_INCIDENT_STATUSES: readonly string[] = ["RESOLVED", "CLOSED", "REJECTED"];

/** Closed incidents are classified by backend lifecycle status; REOPENED stays active. */
export function isResolved(incident: Incident): boolean {
  return CLOSED_INCIDENT_STATUSES.includes(incident.status);
}

export interface OrderedIncidents {
  /** Unresolved, severity-ordered, CRITICAL first. */
  readonly active: readonly Incident[];
  /** Resolved, newest resolution first. Collapsed below the active ones. */
  readonly resolved: readonly Incident[];
}

/**
 * Requirement 8.1 — severity order with CRITICAL first, resolved collapsed below.
 *
 * Within one severity the newer incident comes first: two criticals are equally
 * severe, and the later one is the one still developing. `[...]` before `sort`
 * keeps the caller's array untouched, because the input is the fetched response
 * and sorting it in place would mutate state React owns.
 */
export function orderIncidents(incidents: readonly Incident[]): OrderedIncidents {
  const bySeverityThenRecency = (left: Incident, right: Incident): number =>
    severityRank(left.severity) - severityRank(right.severity) ||
    detectedOrder(right) - detectedOrder(left);

  const active = incidents.filter((incident) => !isResolved(incident)).sort(bySeverityThenRecency);
  const resolved = incidents
    .filter(isResolved)
    .sort((left, right) => resolvedOrder(right) - resolvedOrder(left));

  return { active, resolved };
}

/** Sortable form of a timestamp. An unparseable one sorts last rather than throwing. */
function timeOrder(timestamp: string | undefined): number {
  if (typeof timestamp !== "string") {
    return 0;
  }

  const parsed = new Date(timestamp).getTime();

  return Number.isNaN(parsed) ? 0 : parsed;
}

function detectedOrder(incident: Incident): number {
  return timeOrder(incident.detected_at);
}

function resolvedOrder(incident: Incident): number {
  return timeOrder(resolvedTimestamp(incident) ?? incident.detected_at);
}

/* ---------------------------------------------------------------------------
 * Severity distribution — the page's one contextual visual
 * ------------------------------------------------------------------------ */

export interface SeverityShare {
  readonly severity: Incident["severity"];
  /** Text label. Severity is never colour-only (requirements 12.9, 15.10). */
  readonly label: string;
  readonly count: number;
}

const SEVERITY_LABELS: Record<Incident["severity"], string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

/**
 * Label for a severity, including one outside the declared union.
 *
 * `SEVERITY_LABELS` stays a `Record` over the union, so a level added to
 * `src/types.ts` without a label here is a compile error. The lookup goes through
 * `SEVERITY_ORDER` rather than casting the caller's `string` into the union.
 */
export function severityLabel(severity: string): string {
  const known = SEVERITY_ORDER.find((level) => level === severity);

  if (known === undefined) {
    return humaniseUnknownValue(severity) ?? "Unrecorded";
  }

  return SEVERITY_LABELS[known];
}

/**
 * Real counts per severity, in CRITICAL-first order (requirement 8.3).
 *
 * Every segment is returned, including the empty ones, so the legend states all
 * four counts — "0 low" is information, and a legend that silently drops a level
 * would make the reader guess whether it was zero or missing.
 *
 * Counts only: the strip's geometry is `DistributionBar`'s, which derives each
 * segment's width and offset from the counts it is given. Three pages used to
 * compute that arithmetic three times over.
 */
export function severityDistribution(incidents: readonly Incident[]): readonly SeverityShare[] {
  return SEVERITY_ORDER.map((severity) => ({
    severity,
    label: SEVERITY_LABELS[severity],
    count: incidents.filter((incident) => incident.severity === severity).length,
  }));
}

/* ---------------------------------------------------------------------------
 * Status, next action and operational state
 * ------------------------------------------------------------------------ */

/**
 * The three states of design.md §1.1, as requirement 12.9 requires for every
 * operational item. Kept as the literal union `StatusBadge` accepts, so the page
 * hands this straight to the badge and maps no status to a colour itself
 * (requirement 12.5).
 */
export type IncidentOperationalState = "HANDLED" | "NEEDS_DECISION" | "CANNOT_BE_AUTOMATED";

interface StatusReading {
  readonly label: string;
  /** What happens next, in one sentence (requirement 8.2). */
  readonly nextAction: string;
  readonly operationalState: IncidentOperationalState;
}

/**
 * `services/shared/models/incident.py::IncidentStatus`, read rather than invented.
 *
 * `Incident.status` is typed `string`, so this cannot be a `Record` over a union
 * and a value outside it is a live possibility — `unknownStatusReading` covers
 * that case honestly instead of guessing at a next action.
 */
const STATUS_READINGS: Record<string, StatusReading> = {
  DETECTED: {
    label: "Detected",
    nextAction: "CommunityOps is picking this up.",
    operationalState: "HANDLED",
  },
  ANALYZING: {
    label: "Analyzing",
    nextAction: "CommunityOps is working out the impact.",
    operationalState: "HANDLED",
  },
  RECOMMENDATION_READY: {
    label: "Recommendation ready",
    nextAction: "Open the incident and decide on the proposal.",
    operationalState: "NEEDS_DECISION",
  },
  AWAITING_APPROVAL: {
    label: "Awaiting approval",
    nextAction: "Waiting on your decision in Approvals.",
    operationalState: "NEEDS_DECISION",
  },
  APPROVED: {
    label: "Approved",
    nextAction: "CommunityOps is carrying out the approved response.",
    operationalState: "HANDLED",
  },
  EXECUTING: {
    label: "Executing",
    nextAction: "CommunityOps is carrying out the approved response.",
    operationalState: "HANDLED",
  },
  RESOLVED: {
    label: "Resolved",
    nextAction: "Nothing further. This incident is closed.",
    operationalState: "HANDLED",
  },
  REJECTED: {
    label: "Declined",
    nextAction: "The proposal was declined. Choose another response.",
    operationalState: "CANNOT_BE_AUTOMATED",
  },
  ESCALATED: {
    label: "Escalated",
    nextAction: "CommunityOps has no automated path left. This needs a person.",
    operationalState: "CANNOT_BE_AUTOMATED",
  },
};

/**
 * A status this console does not know.
 *
 * The label carries the value in words so nothing is hidden, and the state is
 * "Cannot be automated": a status the console cannot interpret is not a state it
 * may describe as handled.
 */
function unknownStatusReading(status: string): StatusReading {
  return {
    label: humaniseUnknownValue(status) ?? "Status unavailable",
    nextAction: "Open the incident to see where it stands.",
    operationalState: "CANNOT_BE_AUTOMATED",
  };
}

export function statusReading(incident: Incident): StatusReading {
  return readTableEntry(STATUS_READINGS, incident.status) ?? unknownStatusReading(incident.status);
}

/** Status values the change form offers, in lifecycle order. */
export const INCIDENT_STATUS_OPTIONS: readonly string[] = Object.keys(STATUS_READINGS);

/** Editing label for a status. Text only — no colour is mapped here. */
export function statusOptionLabel(status: string): string {
  return readTableEntry(STATUS_READINGS, status)?.label ?? status;
}

/* ---------------------------------------------------------------------------
 * Affected resource
 * ------------------------------------------------------------------------ */

/**
 * "Speaker SPK-006", or the id alone when the type is blank. Both fields default
 * to `""` on the backend model, so an incident can legitimately name neither.
 */
export function affectedResourceLabel(incident: Incident): string | null {
  const type = humaniseUnknownValue(incident.affected_resource_type);
  const id = incident.affected_resource_id.trim();

  if (type === null && id === "") {
    return null;
  }
  if (type === null) {
    return id;
  }

  return id === "" ? type : `${type} ${id}`;
}

/* ---------------------------------------------------------------------------
 * Derived approval linkage (requirement 8.6)
 * ------------------------------------------------------------------------ */

/**
 * The pending approvals that concern this incident.
 *
 * `approval_id` is **not** an allowed field on the incident endpoint, and the
 * incidents response carries no approval reference, so there is no stored link
 * to read. The only honest linkage is the one computed here: an approval whose
 * `affected_resource_id` is this incident's id. The page states that the
 * relationship is derived rather than presenting it as a recorded fact.
 *
 * The status check is belt and braces — `GET /events/{id}/approvals` returns
 * PENDING only — so the section cannot start showing decided approvals if that
 * ever changes.
 */
export function derivedApprovalsFor(
  incident: Incident,
  approvals: readonly Approval[],
): readonly Approval[] {
  return approvals.filter(
    (approval) =>
      approval.status === "PENDING" && approval.affected_resource_id === incident.incident_id,
  );
}

/* ---------------------------------------------------------------------------
 * The analysis fields `src/types.ts` does not model yet
 * ------------------------------------------------------------------------ */

/** One labelled row read out of a structured `impact_analysis`. */
export interface ImpactRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/**
 * How the drawer should render `impact_analysis`.
 *
 * `structured` exists because the workflow writes the field with `json.dumps`.
 * Raw JSON never reaches the screen (A11): recognised keys become labelled rows
 * and everything else is counted.
 */
export type IncidentImpact =
  | { readonly kind: "absent" }
  | { readonly kind: "prose"; readonly text: string }
  | {
      readonly kind: "structured";
      readonly rows: readonly ImpactRow[];
      readonly undisplayedCount: number;
    };

export interface IncidentAnalysis {
  readonly impact: IncidentImpact;
  /** Other resources this incident affects. Ids, as the backend records them. */
  readonly dependencies: readonly string[];
  readonly resolutionSummary: string | null;
}

/**
 * The known keys of the analysis payload
 * `services/workflows/incident_response.py::_analyze` produces. Anything else is
 * counted rather than rendered.
 */
const IMPACT_LABELS: Record<string, string> = {
  affected_resource_type: "Affected resource type",
  affected_resource_id: "Affected resource",
  severity: "Severity at analysis",
  dependencies: "Dependencies identified",
  backup_options: "Backup options found",
  analysis_complete: "Analysis complete",
};

/** Key order in the drawer, independent of the order the JSON happens to use. */
const IMPACT_KEY_ORDER: readonly string[] = Object.keys(IMPACT_LABELS);

/**
 * Read the fields of an incident as an unverified map.
 *
 * `Incident` in `src/types.ts` does not declare `impact_analysis`,
 * `dependencies` or `resolution_summary` yet, and that file is owned elsewhere
 * while this page lands. Going through `Object.entries` keeps every value
 * `unknown` and forces each read below to prove the type it renders — which is
 * stricter than an interface would be, since the response is asserted rather
 * than validated in the first place. Nothing is cast, and nothing reaches the
 * screen without passing a type check at runtime.
 */
function fieldsOf(incident: Incident): ReadonlyMap<string, unknown> {
  const entries: readonly (readonly [string, unknown])[] = Object.entries(incident);

  return new Map(entries);
}

/** Non-empty string, or `null`. Blank is the backend's default, i.e. "not set". */
function readText(fields: ReadonlyMap<string, unknown>, key: string): string | null {
  const value = fields.get(key);

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  return value.trim();
}

/** The string members of a list field, dropping anything that is not usable text. */
function readTextList(fields: ReadonlyMap<string, unknown>, key: string): readonly string[] {
  const value = fields.get(key);

  if (!Array.isArray(value)) {
    return [];
  }

  const items: readonly unknown[] = value;

  return items.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

/** `true` when the text is a JSON object or array rather than prose. */
function looksStructured(text: string): boolean {
  return text.startsWith("{") || text.startsWith("[");
}

/**
 * One recognised impact value as display text.
 *
 * @returns the text, or `null` when the value's type has no honest short form —
 * a nested object, say. The caller counts those instead of rendering them.
 */
function impactValueText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() === "" ? null : value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;

    return `${items.length}`;
  }

  return null;
}

/**
 * Read a structured `impact_analysis` into labelled rows.
 *
 * Keys outside the allowlist, and recognised keys whose value has no short form,
 * are counted together: the reader is told how much CommunityOps recorded that
 * the console does not display, which is A11's "unrecognised keys counted".
 */
function structuredImpact(text: string): IncidentImpact {
  const parsed: unknown = JSON.parse(text);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    // A JSON scalar or array. There are no keys to label, and the raw text is
    // not renderable, so the reader is told only that something is recorded.
    return { kind: "structured", rows: [], undisplayedCount: 1 };
  }

  const fields = new Map<string, unknown>(Object.entries(parsed));
  const rows: ImpactRow[] = [];
  let undisplayedCount = 0;

  for (const key of IMPACT_KEY_ORDER) {
    if (!fields.has(key)) {
      continue;
    }

    const label = IMPACT_LABELS[key];
    const value = impactValueText(fields.get(key));

    if (label === undefined || value === null) {
      undisplayedCount += 1;
      continue;
    }

    rows.push({ key, label, value });
  }

  for (const key of fields.keys()) {
    if (!Object.hasOwn(IMPACT_LABELS, key)) {
      undisplayedCount += 1;
    }
  }

  return { kind: "structured", rows, undisplayedCount };
}

function readImpact(fields: ReadonlyMap<string, unknown>): IncidentImpact {
  const text = readText(fields, "impact_analysis");

  if (text === null) {
    return { kind: "absent" };
  }

  if (!looksStructured(text)) {
    return { kind: "prose", text };
  }

  try {
    return structuredImpact(text);
  } catch {
    // Text that begins like JSON but is not. It is not prose either, so it is
    // reported as one undisplayed value rather than printed as-is.
    return { kind: "structured", rows: [], undisplayedCount: 1 };
  }
}

/**
 * The analysis CommunityOps recorded for one incident (requirement 8.4).
 *
 * Every value is proved at runtime before it is returned, so the drawer renders
 * nothing it cannot type.
 */
export function readIncidentAnalysis(incident: Incident): IncidentAnalysis {
  const fields = fieldsOf(incident);

  return {
    impact: readImpact(fields),
    dependencies: readTextList(fields, "dependencies"),
    resolutionSummary: readText(fields, "resolution_summary"),
  };
}
