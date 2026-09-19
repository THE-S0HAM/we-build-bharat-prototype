/**
 * Session-level error handling: the behaviour column of design.md §12
 * (requirements 1.8, 13.4, 13.6, 13.7).
 *
 * `ErrorState` says the right sentence. Three of the responses design.md §12
 * specifies are not sentences at all, and none of them can happen inside a
 * presentational component:
 *
 *   - **401 — the session is gone.** Clear it. The route guard then returns the
 *     visitor to `/login` with the route they were on retained, and nothing is
 *     rendered about it (requirement 1.8).
 *   - **404 — the list is stale.** Re-fetch the list the missing record belonged
 *     to, alongside the copy (requirement 13.4).
 *   - **Missing configuration.** Write the detail to the browser console, where
 *     the person deploying the console can read it and the person using it
 *     cannot (requirement 13.7).
 *
 * The hook is on the data path rather than beside it: it returns the failure to
 * render, or `null` when there is nothing to render, so `setFailure(report(e))`
 * is the whole adoption and a page cannot take the failure without passing it
 * through here. A page reports once, in the rejection handler:
 *
 * ```tsx
 * const report = useApiFailure();
 * const [failure, setFailure] = useState<unknown>(null);
 *
 * const load = useCallback(() => {
 *   setFailure(null);
 *   getSpeakers(eventId).then(setSpeakers, (error: unknown) => {
 *     setFailure(report(error, { refresh: reloadList }));
 *   });
 * }, [eventId, report, reloadList]);
 *
 * if (failure !== null) return <ApiErrorState error={failure} onRetry={load} />;
 * ```
 *
 * Reporting from the rejection handler, not from render, is deliberate: the
 * effects then run exactly once per failure. A refresh driven from render would
 * re-run on every re-render, and a list that keeps answering 404 would refresh
 * itself in a loop.
 */

import { useCallback } from "react";

import { failurePolicy, logConfigurationDetail } from "../lib/errorCategory";
import { useSession } from "./sessionContext";

export interface ApiFailureOptions {
  /**
   * Re-fetch the list the failed record belongs to (requirement 13.4).
   *
   * This is the list *around* the failure — the queue a decided approval sat in,
   * the table a removed row was still shown in — never the request that just
   * failed. A view whose own load failed offers the user "Try again" through
   * `ApiErrorState`; re-running it unprompted would be a retry loop, not a
   * refresh.
   */
  readonly refresh?: () => void;
}

/**
 * Carry out the console's response to a failure.
 *
 * @returns the failure to render, or `null` when the console's answer is not to
 * render anything — today that is only an ended session, which returns the
 * visitor to sign-in with no notification (requirement 1.8).
 */
export type ReportApiFailure = (error: unknown, options?: ApiFailureOptions) => unknown;

export function useApiFailure(): ReportApiFailure {
  const { signOut } = useSession();

  return useCallback<ReportApiFailure>(
    (error, options) => {
      const policy = failurePolicy(error);

      if (policy.logsDetail) {
        logConfigurationDetail(error);
      }

      if (policy.endsSession) {
        /**
         * Clearing the session is the whole of it, and the navigation follows:
         * the visitor is on a protected route, so `RequireSession` resolves it to
         * `/login` the moment the status turns anonymous — carrying the route
         * they were on, search and hash included, in the navigation's history
         * state. That is requirement 1.8's "retain the intended route", and it is
         * the same path a sign-out and an expired reload already take, so there
         * is one answer to "where does a session-less visitor go".
         *
         * Navigating from here as well would be a second redirect competing for
         * the same transition. The guard wins that race; the imperative one only
         * looks like it worked.
         */
        signOut();

        // Nothing to render. A 401 is not news the user can act on, and an error
        // notification on the way back to sign-in would blame them for a token's
        // clock (requirement 1.8, design.md §5.2).
        return null;
      }

      if (policy.refreshesList) {
        options?.refresh?.();
      }

      return error;
    },
    [signOut],
  );
}
