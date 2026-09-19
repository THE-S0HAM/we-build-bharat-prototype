/**
 * ApiErrorState — the error surface for a failed API request.
 *
 * `ErrorState` is the pattern; this is the pattern wired to the two things
 * design.md §12 asks of the *rendering* of an API failure, neither of which a
 * caller should have to remember:
 *
 *   - **A 401 renders nothing.** The session is gone, the route guard is already
 *     returning the visitor to sign-in, and requirement 1.8 is explicit that no
 *     error notification accompanies it. Deciding that here rather than in every
 *     page means the guarantee holds structurally: a page that stores the failure
 *     and renders it anyway still shows nothing.
 *   - **`POLICY_REQUIRES_APPROVAL` carries a link to Approvals** (requirement
 *     13.6). The sentence names a place, so the copy hands the user the way
 *     there instead of asking them to go and find it.
 *
 * Everything else — the copy, the retry gating, the refusal to render backend
 * detail — is `ErrorState`'s, unchanged. The props are `ErrorState`'s props, so
 * adopting this is a one-word change at the call site.
 *
 * This is the rendering half of the response to a failure. The acting half —
 * clearing the session, refreshing a stale list, logging configuration detail —
 * is `useApiFailure`, called once where the request rejected. Both read the same
 * table in `src/lib/errorCategory.ts`.
 */

import { Link } from "react-router-dom";

import { failurePolicy } from "../lib/errorCategory";
import { APPROVALS_PATH } from "../navConfig";
import { ErrorState, type ErrorStateProps } from "./ErrorState";

// The link renders inside `ErrorState`'s own block, so its class belongs to that
// block and its rule lives in that stylesheet. Imported here as well because
// this component owns the element that carries the class.
import "./ErrorState.css";

const APPROVALS_LINK_LABEL = "Go to Approvals";

export type ApiErrorStateProps = ErrorStateProps;

export function ApiErrorState({ error, children, ...rest }: ApiErrorStateProps) {
  const policy = failurePolicy(error);

  if (policy.endsSession) {
    return null;
  }

  const extra = policy.linksToApprovals ? (
    <>
      {children}
      <Link className="error-state__link" to={APPROVALS_PATH}>
        {APPROVALS_LINK_LABEL}
      </Link>
    </>
  ) : (
    children
  );

  return (
    <ErrorState error={error} {...rest}>
      {extra}
    </ErrorState>
  );
}
