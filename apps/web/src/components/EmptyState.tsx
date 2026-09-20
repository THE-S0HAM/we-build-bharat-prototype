/**
 * EmptyState — the one empty pattern in the product (design.md §7).
 *
 * The copy is supplied by the caller, because every view has its own specified
 * wording: the Command Center says "Abhi koi drama nahi." with "CommunityOps is
 * keeping things moving.", an operational page says a plain sentence
 * (requirement 13.2, design.md §12.2). This component owns the rhythm, the type
 * and the single optional action, never the words.
 *
 * An empty state is not a failure. It carries no error treatment and no retry:
 * a view that resolved with zero records has nothing to retry. Failures are
 * `ErrorState`.
 */

import "./EmptyState.css";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

export interface EmptyStateProps {
  /** The headline for this view, e.g. "Abhi koi drama nahi." */
  title: string;
  /** One supporting sentence, e.g. "CommunityOps is keeping things moving." */
  description?: string;
  /**
   * At most one action (design.md §7). Supplied as a single object so it cannot
   * be half-specified.
   */
  action?: EmptyStateAction;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <p className="empty-state__title">{title}</p>
      {description === undefined ? null : (
        <p className="empty-state__description">{description}</p>
      )}
      {action === undefined ? null : (
        <button type="button" className="btn empty-state__action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
