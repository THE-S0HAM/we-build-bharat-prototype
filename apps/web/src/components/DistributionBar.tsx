import type { ReactNode } from "react";
import "./DistributionBar.css";

/**
 * The bar's own user space. 100 units wide, so one record's share of the whole
 * is a coordinate in it; `preserveAspectRatio="none"` stretches that space to
 * whatever width the CSS gives the element, and the height is the bar's aspect
 * rather than a rendered size.
 *
 * Both numbers live here and nowhere else: they are SVG geometry, not design
 * values, and keeping them in one file is what stops three pages from drawing
 * three subtly different bars (design.md §15.4).
 */
const BAR_WIDTH = 100;
const BAR_HEIGHT = 6;

export interface DistributionSegment {
  /**
   * Stable key for the segment, and the `data-segment` value both the bar rect
   * and the legend swatch carry. Page CSS keys its fills off it — the page owns
   * its own vocabulary, this component owns the treatment.
   */
  readonly id: string;

  /** The segment's own word, shown in the legend. Never a colour name. */
  readonly label: string;

  /** The real count this segment represents. */
  readonly count: number;

  /**
   * An optional SVG paint reference for the rect, e.g. `url(#hatch-id)`. Used
   * where a segment must be told apart by texture as well as by its label; the
   * pattern itself is supplied through `defs`.
   */
  readonly fill?: string;
}

export interface DistributionBarProps {
  /** The visual's heading, rendered as the region's `<h2>`. */
  heading: string;

  /** Id for the heading, so the `<section>` is named by it. */
  headingId: string;

  /**
   * Every segment, in display order. A segment with a zero count is kept out of
   * the bar and left in the legend, so the legend reads as a complete list of
   * the states that exist rather than only the ones that happen to be occupied.
   */
  segments: readonly DistributionSegment[];

  /**
   * The whole visual restated in words — requirement 15.12's text alternative.
   * The bar itself is hidden from assistive technology, so this sentence and the
   * legend are what a screen reader gets.
   */
  sentence: string;

  /** Optional `<defs>` content, for pages that fill a segment with a pattern. */
  defs?: ReactNode;
}

/**
 * The one contextual visual a page is allowed (requirement 12.10, design.md
 * §6.3): a horizontal distribution bar, a legend that names and counts every
 * segment, and a sentence that states the whole thing.
 *
 * Extracted because TeamOps, SpeakerOps and IncidentOps each grew their own
 * near-copy of it — three heights, two border treatments, two legend gaps. The
 * treatment is now stated once here and §15.4's "fixed in the shared component,
 * never patched locally" holds by construction. A page supplies counts, labels
 * and a sentence, and keys its segment fills off `data-segment`; it supplies no
 * geometry and no chrome.
 *
 * Drawn as SVG rather than as sized `<span>`s because a segment width is a real
 * derived number: as SVG geometry it is an attribute in the element's own user
 * space, so nothing needs an inline style or a design value outside `tokens.css`
 * (requirement 12.2, design.md §6.3).
 *
 * The bar is decorative and `aria-hidden`: every number in it is in the legend
 * beside it and in the sentence below it, so nothing is carried by geometry or
 * by colour alone (requirements 15.10, 15.11).
 */
export function DistributionBar({
  heading,
  headingId,
  segments,
  sentence,
  defs,
}: DistributionBarProps) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);

  // Laid out left to right in the order given, each segment starting where the
  // last one ended. Shares are computed once, here, rather than in each page.
  let offset = 0;
  const bars = segments
    .filter((segment) => segment.count > 0)
    .map((segment) => {
      const x = offset;
      const width = total === 0 ? 0 : (segment.count / total) * BAR_WIDTH;
      offset += width;

      return { id: segment.id, fill: segment.fill, x, width };
    });

  return (
    <section className="card distribution" aria-labelledby={headingId}>
      <h2 className="distribution__heading" id={headingId}>
        {heading}
      </h2>

      <svg
        className="distribution__bar"
        viewBox={`0 0 ${BAR_WIDTH} ${BAR_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {defs === undefined ? null : <defs>{defs}</defs>}

        {bars.map((bar) => (
          <rect
            className="distribution__segment"
            data-segment={bar.id}
            key={bar.id}
            x={bar.x}
            y={0}
            width={bar.width}
            height={BAR_HEIGHT}
            fill={bar.fill}
          />
        ))}
      </svg>

      <ul className="distribution__legend">
        {segments.map((segment) => (
          <li className="distribution__legend-item" key={segment.id}>
            <span
              className="distribution__swatch"
              data-segment={segment.id}
              aria-hidden="true"
            />
            <span className="distribution__legend-label">{segment.label}</span>
            <span className="distribution__legend-count">{segment.count}</span>
          </li>
        ))}
      </ul>

      <p className="distribution__sentence">{sentence}</p>
    </section>
  );
}
