/**
 * The no-events state (requirement 3.10, design.md §5.4).
 *
 * `GET /events` answered, and the answer was zero events. That is not a failure
 * and not a loading state: the organization exists, the console reached it, and
 * there is simply nothing yet to run operations for.
 *
 * It lives in the shell's content region rather than in each event-scoped page.
 * Requirement 3.10 puts it on the `App_Shell`, and `EventScopedView` deliberately
 * renders nothing for `empty` so this is the one sentence for the whole console
 * instead of the same sentence repeated on six routes.
 *
 * Two things carry the state together, and the navigation is the other half of
 * it: every event-scoped entry is disabled while this renders, so the reason a
 * route cannot be opened is visible in the same frame as the explanation.
 *
 * No action. There is no event-creation endpoint in `api.ts` and no create-event
 * screen in the product, so a "Create an event" button would be an affordance
 * with nowhere to go — the same rule that keeps unconfigured provider buttons off
 * the sign-in screen.
 */

import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";

/** The page title, which is also this state's document title. */
const TITLE = "No events yet";

const HEADLINE = "This organization has no events.";

/**
 * Says what is unavailable and why, without listing the navigation back to the
 * user — the disabled entries are on screen beside this.
 */
const DESCRIPTION =
  "Event areas stay disabled until one exists. CommunityOps has nothing to scope to an event yet.";

export function NoEventsState() {
  return (
    <>
      <PageHeader title={TITLE} />
      <EmptyState title={HEADLINE} description={DESCRIPTION} />
    </>
  );
}
