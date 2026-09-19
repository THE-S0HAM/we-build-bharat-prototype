import type { ComponentType } from "react";

import { ErrorState } from "../components/ErrorState";
import { Skeleton, SkeletonRegion } from "../components/Skeleton";
import { useEventContext } from "./eventContext";

/** What an event-scoped page needs from the context, and nothing else. */
export interface EventScopedPageProps {
  readonly eventId: string;
}

export interface EventScopedViewProps {
  /**
   * The page to render once an event is resolved. It receives the identifier as
   * a prop rather than reading the context itself, so the six event-scoped pages
   * stay plain components that take an event and fetch for it — testable with a
   * string and no provider.
   */
  readonly view: ComponentType<EventScopedPageProps>;
}

/**
 * The event gate on an event-scoped route (design.md §5.5, requirement 3.7).
 *
 * Replaces the hardcoded `EVENT_ID` the route table used to pass to six pages
 * (design.md A16). One wrapper, four outcomes, and the order matters:
 *
 *   1. `loading` → a skeleton in the shape of the page. Not the page: a page
 *      mounted before the event is known would either fetch with a guessed
 *      identifier or fetch twice (requirement 13.1).
 *   2. `failed` → the standard view-load failure with a retry that re-runs
 *      `GET /events` only (requirement 13.3). `ErrorState` owns the copy and
 *      renders nothing from the failure itself.
 *   3. no event resolved → nothing here. The organization has no events, and
 *      requirement 3.10 puts that state in the shell — one sentence for the
 *      whole console, not the same sentence repeated on six routes.
 *   4. otherwise → the page, with the resolved event.
 */
export function EventScopedView({ view: View }: EventScopedViewProps) {
  const { status, activeEventId, error, refresh } = useEventContext();

  if (status === "loading") {
    return (
      <SkeletonRegion>
        <Skeleton shape="heading" width="half" />
        <Skeleton shape="line" width="narrow" />
        <Skeleton shape="block" />
      </SkeletonRegion>
    );
  }

  if (status === "failed") {
    return <ErrorState error={error} onRetry={refresh} />;
  }

  if (activeEventId === null) {
    return null;
  }

  return <View eventId={activeEventId} />;
}
