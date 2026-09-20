/**
 * The one mapping from a failure to what the console says and does about it
 * (design.md §12, requirement 13).
 *
 * This table used to live inside `ErrorState.tsx`, which was the right home
 * while rendering was the only response to a failure. It is not: design.md §12
 * gives every category two columns — copy *and* behaviour — and three of those
 * behaviours are things a presentational component cannot do. A 401 ends the
 * session and returns the visitor to sign-in; a 404 refreshes the list the
 * missing record belonged to; a configuration failure writes its detail to the
 * browser console. So the table moved here, where both the component and the
 * session-level handler read the same row, and a category cannot acquire one
 * meaning on screen and a different one in the session.
 *
 * Nothing in this module renders, imports React, or imports `api.ts`. A failure
 * is read structurally — `category`, then `status` — so any thrown value
 * resolves, and the module stays usable from a hook, a component or a test.
 *
 * Two rules hold across every entry:
 *
 *   1. **Copy is reviewed, never derived.** Every user-facing string in the
 *      table below is the wording design.md §12 specifies. A failure's own
 *      `message`, `name` and `stack` are never read for display, so a stack
 *      trace, an exception name, an AWS ARN, an account id, a table name, a
 *      Lambda name, a request path or a request id has no route to the DOM
 *      (requirement 16.7, correctness property 7).
 *   2. **The one string a caller may supply is gated.** `toApprovedCopy` refuses
 *      anything shaped like machine output and falls back to the reviewed
 *      sentence.
 */

/** Prefix for the console channel. The browser console, never the DOM. */
const LOG_TAG = "[CommunityOps]";

/** Categories `api.ts` and the backend produce, per design.md §12. */
const ERROR_CATEGORIES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "AMBIGUOUS_MATCH",
  "CONFLICT",
  "DUPLICATE",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "POLICY_REQUIRES_APPROVAL",
  "EXTERNAL_SERVICE_ERROR",
  "TIMEOUT",
  "INTERNAL_ERROR",
  "CONFIGURATION_ERROR",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/**
 * Whether the failed request was loading a view or carrying out something the
 * user asked for. It selects between the two wordings the spec gives the
 * transient failures; everything else reads the same either way.
 */
export type ErrorContext = "view" | "action";

/** One row of design.md §12: what the console says, and what it does. */
export interface CategoryPolicy {
  /** The sentence for a view that could not be loaded (requirement 13.3). */
  readonly message: string;

  /**
   * The sentence for an action that could not be carried out, where design.md
   * §12 words it differently. Absent means the category reads the same both
   * ways.
   */
  readonly actionMessage?: string;

  /**
   * Whether re-running the request can plausibly succeed. `false` hides "Try
   * again" even when the caller supplies a retry: design.md §12 gives retry to
   * the transient failures only, and offering it for a forbidden organization or
   * a missing record would invite a pointless second failure.
   */
  readonly retryable: boolean;

  /**
   * The session is gone (requirement 1.8). The console clears it and lets the
   * route guard return the visitor to `/login` with the intended route retained,
   * and renders **no** error notification — an expired session is not news, and
   * a toast about it would be the console blaming the user for a token clock.
   */
  readonly endsSession: boolean;

  /**
   * What is on screen is stale: the record is gone (requirement 13.4), or the
   * decision was already taken elsewhere (design.md §12, "refresh the queue").
   * The caller's list is re-fetched alongside the copy.
   */
  readonly refreshesList: boolean;

  /**
   * The work is waiting on an approval, so the copy carries a link to Approvals
   * (requirement 13.6). Without it the sentence names a place the user then has
   * to go and find.
   */
  readonly linksToApprovals: boolean;

  /**
   * The specific detail belongs to whoever is deploying this console, not to the
   * person using it, so it goes to the browser console and nowhere else
   * (requirement 13.7).
   */
  readonly logsDetail: boolean;
}

/**
 * The copy and behaviour table from design.md §12 and requirement 13. The only
 * source of user-facing failure wording in the product.
 *
 * Requirement 13.3 gives `INTERNAL_ERROR`, `EXTERNAL_SERVICE_ERROR` and
 * `TIMEOUT` the same view-load sentence, while design.md §12 words the last two
 * as a failed attempt. Both are kept: the view sentence is the default, and
 * `context === "action"` selects the attempt sentence. Neither document is
 * overruled and no caller has to supply the wording itself.
 */
export const CATEGORY_POLICY: Readonly<Record<ErrorCategory, CategoryPolicy>> = {
  // A validation failure belongs at the field or the form, where the backend's
  // own user-safe message is shown. If one reaches a whole view, the view could
  // not be loaded as requested and retrying the same request will not fix it.
  VALIDATION_ERROR: {
    message: "CommunityOps couldn't load this view.",
    retryable: false,
    endsSession: false,
    refreshesList: false,
    linksToApprovals: false,
    logsDetail: false,
  },
  NOT_FOUND: {
    message: "We couldn't find that record. It may have been removed.",
    retryable: false,
    endsSession: false,
    // Requirement 13.4: the list still showing the record is out of date.
    refreshesList: true,
    linksToApprovals: false,
    logsDetail: false,
  },
  AMBIGUOUS_MATCH: {
    message: "More than one person matches. Pick the right registration.",
    retryable: false,
    endsSession: false,
    refreshesList: false,
    linksToApprovals: false,
    logsDetail: false,
  },
  CONFLICT: {
    message: "This was already decided elsewhere.",
    retryable: false,
    endsSession: false,
    // Design.md §12: replace the card, refresh the queue.
    refreshesList: true,
    linksToApprovals: false,
    logsDetail: false,
  },
  DUPLICATE: {
    message: "This was already decided elsewhere.",
    retryable: false,
    endsSession: false,
    refreshesList: true,
    linksToApprovals: false,
    logsDetail: false,
  },
  // No copy is specified for this category, because the specified response is to
  // go back to sign-in silently (requirement 1.8). The sentence here is the
  // defensive floor for a surface that renders a failure without passing it
  // through the session-level handler; `ApiErrorState` renders nothing at all.
  UNAUTHORIZED: {
    message: "Your session has ended. Sign in again to continue.",
    retryable: false,
    endsSession: true,
    refreshesList: false,
    linksToApprovals: false,
    logsDetail: false,
  },
  FORBIDDEN: {
    message: "You don't have access to this organization's data.",
    // Requirement 1.9: no retry, and no silent organization switch either.
    retryable: false,
    endsSession: false,
    refreshesList: false,
    linksToApprovals: false,
    logsDetail: false,
  },
  POLICY_REQUIRES_APPROVAL: {
    message: "CommunityOps needs your approval before this can proceed.",
    retryable: false,
    endsSession: false,
    refreshesList: false,
    linksToApprovals: true,
    logsDetail: false,
  },
  EXTERNAL_SERVICE_ERROR: {
    message: "CommunityOps couldn't load this view.",
    actionMessage: "CommunityOps couldn't complete that just now.",
    retryable: true,
    endsSession: false,
    refreshesList: false,
    linksToApprovals: false,
    logsDetail: false,
  },
  TIMEOUT: {
    message: "CommunityOps couldn't load this view.",
    actionMessage: "CommunityOps couldn't complete that just now.",
    retryable: true,
    endsSession: false,
    refreshesList: false,
    linksToApprovals: false,
    logsDetail: false,
  },
  INTERNAL_ERROR: {
    message: "CommunityOps couldn't load this view.",
    retryable: true,
    endsSession: false,
    refreshesList: false,
    linksToApprovals: false,
    logsDetail: false,
  },
  CONFIGURATION_ERROR: {
    message: "This console isn't configured yet.",
    // Nothing the user can do, and nothing a second attempt would change.
    retryable: false,
    endsSession: false,
    refreshesList: false,
    linksToApprovals: false,
    // Requirement 13.7: the detail goes to the browser console only.
    logsDetail: true,
  },
} as const;

/** Anything unrecognised is a view that did not load. */
const FALLBACK_CATEGORY: ErrorCategory = "INTERNAL_ERROR";

/**
 * Used only when a failure arrives without a usable category, which is the case
 * for a raw `fetch` rejection or a non-`ApiError` throw.
 */
const CATEGORY_BY_STATUS: ReadonlyMap<number, ErrorCategory> = new Map([
  [202, "POLICY_REQUIRES_APPROVAL"],
  [400, "VALIDATION_ERROR"],
  [401, "UNAUTHORIZED"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [409, "CONFLICT"],
  [500, "INTERNAL_ERROR"],
  [502, "EXTERNAL_SERVICE_ERROR"],
  [503, "EXTERNAL_SERVICE_ERROR"],
  [504, "TIMEOUT"],
] as const);

/**
 * Approved copy is short and plain. Backend detail is long, so length alone is
 * a useful guard on top of the patterns below.
 */
const MAX_COPY_LENGTH = 160;

/**
 * Shapes that mean "this string came from a machine, not from the product's
 * copy". Anything matching is refused, because the enumerated leaks of
 * design.md §12.1 all take one of these forms. The list errs towards refusing:
 * a refused string costs the caller the reviewed sentence instead, which is
 * always safe to show.
 */
const UNSAFE_COPY_PATTERNS: readonly RegExp[] = [
  /arn:/i, // AWS ARN
  /\b\d{12}\b/, // AWS account id
  /(?:error|exception|traceback)\b/i, // exception names and raw error text
  /\bat\s+\S+\s*\(/, // stack frame, e.g. "at Object.handler ("
  /\.(?:js|mjs|ts|tsx|py|java)\b/i, // source file names
  /\b(?:aws|amazonaws|lambda|dynamodb|dynamo|cloudwatch|cognito|apigateway|execute-api|s3|iam|sts|sfn|bedrock)\b/i,
  /\btable\b/i, // DynamoDB table names
  /request[\s_-]?id/i, // request identifiers
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // uuid
  /\b[0-9a-f]{16,}\b/i, // trace and correlation ids
  /\bhttps?:\/\//i, // URLs
  /(?:^|\s)\/[\w-]/, // request paths, e.g. "/events/EVT-1/speakers"
  /\bhttp\s*\d{3}\b/i, // "Request failed (HTTP 500)"
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, // raw SNAKE_CASE codes, e.g. DYNAMODB_ERROR
  /[{}]/, // JSON fragments
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrows a candidate category string to one the table knows. */
function asCategory(value: unknown): ErrorCategory | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  return ERROR_CATEGORIES.find((category) => category === normalized);
}

function categoryFromStatus(value: unknown): ErrorCategory | undefined {
  return typeof value === "number" ? CATEGORY_BY_STATUS.get(value) : undefined;
}

/**
 * Resolves any thrown value to a category. Accepts an `ApiError`, a plain object
 * carrying `category` or `status`, a bare category string, or anything at all;
 * everything unrecognised resolves to the safe default.
 *
 * The value is typed `unknown` on purpose: `api.ts` throws `ApiError`, but a
 * rejected promise can carry anything, and every unrecognised value has to land
 * on safe copy rather than on a crash.
 */
export function resolveCategory(error: unknown): ErrorCategory {
  const direct = asCategory(error);
  if (direct !== undefined) {
    return direct;
  }
  if (isRecord(error)) {
    return asCategory(error.category) ?? categoryFromStatus(error.status) ?? FALLBACK_CATEGORY;
  }
  return FALLBACK_CATEGORY;
}

/** The row of design.md §12 that governs this failure. */
export function failurePolicy(error: unknown): CategoryPolicy {
  return CATEGORY_POLICY[resolveCategory(error)];
}

/** The reviewed sentence for a policy, in the wording that context calls for. */
export function approvedMessage(policy: CategoryPolicy, context: ErrorContext): string {
  return context === "action" ? policy.actionMessage ?? policy.message : policy.message;
}

/**
 * The single gate every caller-supplied string passes through before it is
 * rendered. It is used only if it looks like product copy; if it looks like
 * machine output it is dropped in favour of `fallback`, and the rejected string
 * goes to the browser console for the developer, which is the same split
 * design.md §12 applies to configuration detail.
 */
export function toApprovedCopy(candidate: string | undefined, fallback: string): string {
  if (candidate === undefined) {
    return fallback;
  }
  const text = candidate.trim();
  if (text === "") {
    return fallback;
  }
  if (text.length > MAX_COPY_LENGTH || UNSAFE_COPY_PATTERNS.some((pattern) => pattern.test(text))) {
    if (import.meta.env.DEV) {
      console.warn(
        `${LOG_TAG} Refused copy that may carry internal detail; showing approved copy instead:`,
        text,
      );
    }
    return fallback;
  }
  return text;
}

/**
 * Write a configuration failure's own detail to the browser console
 * (requirement 13.7).
 *
 * The failure is passed straight to `console.error` rather than returned as a
 * string, so the detail never becomes a value a caller could hold and render.
 * This function is the only read of a failure's own message in the console, and
 * it has exactly one destination.
 *
 * It is not gated on `import.meta.env.DEV`: a misconfigured deployment is
 * diagnosed by whoever opens devtools against it, and this is the only channel
 * that detail has.
 */
export function logConfigurationDetail(error: unknown): void {
  console.error(
    `${LOG_TAG} Client configuration is incomplete, so this console cannot reach the API. ` +
      "The detail below is for whoever deploys this console and is never rendered (requirement 13.7).",
    error,
  );
}
