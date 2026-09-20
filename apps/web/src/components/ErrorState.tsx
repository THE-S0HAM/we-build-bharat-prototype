/**
 * ErrorState — the one error pattern in the product (design.md §7).
 *
 * Two guarantees hold this component together.
 *
 * 1. It re-runs only the failed request. "Try again" invokes the `onRetry`
 *    callback the caller supplied, which is the caller's own fetch for the
 *    region that failed. There is no page reload and no global refetch, so a
 *    failure in one strip never resets the rest of the page (requirement 13.3,
 *    design.md §12.1).
 *
 * 2. It never surfaces backend detail. The component reads exactly two fields of
 *    the failure — `category` and `status` — and renders neither. Copy comes from
 *    `src/lib/errorCategory.ts`, the reviewed table from design.md §12. The
 *    error's own `message`, `name` and `stack` are never read, so a stack trace,
 *    an exception name, an AWS ARN, an account id, a table name, a Lambda name, a
 *    request path or a request id has no route to the DOM (correctness
 *    property 7, requirement 16.7). The one string a caller may override is put
 *    through `toApprovedCopy`, which falls back to the table if the string looks
 *    like internal detail.
 *
 * This component renders; it does not act. The behaviour column of design.md §12
 * — ending the session on a 401, refreshing a stale list on a 404, linking to
 * Approvals, writing configuration detail to the console — belongs to
 * `useApiFailure` and `ApiErrorState`, which read the same table. A page showing
 * an API failure should reach for `ApiErrorState`; this component stays the
 * primitive underneath it, and the one to use for a failure that is not an API
 * response at all.
 */

import type { ReactNode } from "react";

import {
  approvedMessage,
  failurePolicy,
  toApprovedCopy,
  type ErrorContext,
} from "../lib/errorCategory";

import "./ErrorState.css";

const RETRY_LABEL = "Try again";

export interface ErrorStateProps {
  /**
   * The failure to explain, normally the `ApiError` the API client threw. Only
   * its `category` and `status` are read, and neither is rendered.
   */
  error?: unknown;
  /**
   * Re-runs ONLY the request that failed (requirement 13.3). Never a page
   * reload: the rest of the page stays as the user left it.
   */
  onRetry?: () => void;
  /**
   * Whether the request was loading this view (the default) or carrying out
   * something the user asked for.
   */
  context?: ErrorContext;
  /**
   * Approved copy for a view whose wording is specified separately, for example
   * "Demo access is temporarily unavailable." (design.md §12.2). Never pass an
   * error message through this prop; it is gated, not trusted.
   */
  message?: string;
  /** One extra sentence of guidance, gated the same way. */
  detail?: string;
  /** Defaults to "Try again". */
  retryLabel?: string;
  /**
   * Caller-owned safe content: the masked candidates of an ambiguous check-in
   * match (requirement 13.5), or the link to Approvals (requirement 13.6).
   */
  children?: ReactNode;
}

export function ErrorState({
  error,
  onRetry,
  context = "view",
  message,
  detail,
  retryLabel,
  children,
}: ErrorStateProps) {
  const policy = failurePolicy(error);
  const headline = toApprovedCopy(message, approvedMessage(policy, context));
  const guidance = toApprovedCopy(detail, "");
  const showRetry = onRetry !== undefined && policy.retryable;

  return (
    <div className="error-state" role="alert">
      <p className="error-state__message">{headline}</p>
      {guidance === "" ? null : <p className="error-state__detail">{guidance}</p>}
      {children === undefined ? null : <div className="error-state__extra">{children}</div>}
      {showRetry ? (
        <button type="button" className="btn error-state__retry" onClick={onRetry}>
          {toApprovedCopy(retryLabel, RETRY_LABEL)}
        </button>
      ) : null}
    </div>
  );
}
