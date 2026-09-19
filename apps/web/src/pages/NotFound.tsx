import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";

/**
 * The not-found view, rendered inside the shell (design.md §5.5).
 *
 * Two routes reach it: an address that matches nothing, and a capability-gated
 * area whose flag is off — AttendeeOps today (requirement 11.1, design.md §8.4).
 * The second case is why this view says nothing about *why* the page is missing:
 * an area that does not exist yet must not announce itself as coming soon, or
 * the console would be advertising a product it cannot deliver.
 *
 * It renders inside the shell rather than as a bare page, so the navigation is
 * the way out and this view needs no action of its own.
 */
export function NotFound() {
  return (
    <div className="page">
      <PageHeader title="Page not found" />

      <EmptyState
        title="We couldn't find that page."
        description="Check the address, or pick a destination from the navigation."
      />
    </div>
  );
}
