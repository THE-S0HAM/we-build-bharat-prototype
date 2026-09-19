import { useEffect } from "react";
import type { ReactNode } from "react";
import "./PageHeader.css";

/**
 * The product name, used wherever a name is rendered or written to document
 * metadata. There is exactly one (requirement 3.1).
 */
const PRODUCT_NAME = "CommunityOps";

export interface PageHeaderProps {
  /**
   * The page title. Rendered as the page's single `<h1>` and written into the
   * document title, so it reads as a page name rather than a sentence.
   */
  title: string;

  /**
   * One line of context under the title — who the page is for, which event it
   * describes, or what it counts. Keep it to inline content: it renders inside
   * a `<p>`.
   */
  context?: ReactNode;

  /**
   * The page's primary action. One slot, not a list, because a page renders at
   * most one primary action (requirement 12.11). Secondary actions belong to the
   * section or row they act on.
   */
  action?: ReactNode;

  /**
   * Optional id for the `<h1>`, so a region can be labelled by the page title
   * through `aria-labelledby`.
   */
  titleId?: string;
}

/**
 * The page title zone (design.md §7, §15.1).
 *
 * Owning the title, the context line and the single primary action in one
 * component is what guarantees the same title baseline and the same header
 * rhythm on every route (requirement 12.4). Pages supply content; they never
 * restyle the header.
 *
 * The `<h1>` here is the page's only top-level heading: `AppShell` renders none,
 * and sections below start at `<h2>` (requirement 15.1). The surrounding
 * `<header>` is a descendant of the shell's `<main>`, so it is a generic group
 * and not a second banner landmark.
 */
export function PageHeader({ title, context, action, titleId }: PageHeaderProps) {
  // The page title is the honest source for the document title, and this is the
  // one place that owns it (requirement 3.1). It is not restored on unmount:
  // the next route sets its own, and reverting first would flash a stale name.
  useEffect(() => {
    document.title = `${title} · ${PRODUCT_NAME}`;
  }, [title]);

  return (
    <header className="page-header">
      <div className="page-header__text">
        <h1 className="page-header__title" id={titleId}>
          {title}
        </h1>
        {context ? <p className="page-header__context">{context}</p> : null}
      </div>

      {action ? <div className="page-header__action">{action}</div> : null}
    </header>
  );
}
