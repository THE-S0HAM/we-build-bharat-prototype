/**
 * `RiskIndicator` — the two risk rows of design.md §6.4, and the only place the
 * red is allowed to appear for a level:
 *
 *   | Level    | Label           | Treatment                                  |
 *   |----------|-----------------|--------------------------------------------|
 *   | LOW      | "Low risk"      | Neutral pill                               |
 *   | MEDIUM   | "Medium risk"   | `--attention` pill (outline, no tint)      |
 *   | HIGH     | "High risk"     | `--attention-soft` tint, `--attention`     |
 *   | CRITICAL | "Critical risk" | `--risk-soft` tint with `--risk`           |
 *
 * `--risk` is reserved for CRITICAL (design.md §6.4, `tokens.css`), so MEDIUM and
 * HIGH escalate through the attention amber and only CRITICAL reaches the red.
 *
 * The level always renders as a text label, so the severity survives without
 * colour (requirements 12.9, 15.10). That holds for a level outside the four as
 * well: an unrecognised value renders its own humanised text in the neutral
 * pill rather than throwing. Used by Approvals, IncidentOps and the Command
 * Center decision surface (design.md §7).
 */

import type { ReactElement } from "react";
import { humaniseUnknownValue, readTableEntry } from "../lib/unknownValue";
import type { Approval, Incident } from "../types";
import "./RiskIndicator.css";

/**
 * The union of both backend contracts that carry this scale in `src/types.ts`:
 * `Approval.risk_level` and `Incident.severity`. Taking the union means either
 * contract gaining a value breaks `RISK_LEVELS` below at compile time instead of
 * falling through to a default colour.
 */
export type RiskLevel = Approval["risk_level"] | Incident["severity"];

interface Presentation {
  /** Always rendered. Colour is never the only signal. */
  readonly label: string;
  readonly modifier: string;
}

/** Labels are the exact §6.4 copy. */
const RISK_LEVELS: Record<RiskLevel, Presentation> = {
  LOW: { label: "Low risk", modifier: "risk-indicator--low" },
  MEDIUM: { label: "Medium risk", modifier: "risk-indicator--medium" },
  HIGH: { label: "High risk", modifier: "risk-indicator--high" },
  CRITICAL: { label: "Critical risk", modifier: "risk-indicator--critical" },
};

/** Copy used when an unrecognised level carries no readable text of its own. */
export const UNKNOWN_RISK_LABEL = "Risk level unavailable";

/**
 * Treatment for a level outside `RiskLevel`.
 *
 * `RISK_LEVELS` above stays a `Record<RiskLevel, Presentation>`, so a level the
 * *types* declare and this table omits is still a compile error. This covers the
 * other direction: `apiFetch` asserts response shapes rather than validating
 * them (see `src/lib/unknownValue.ts`), so a backend severity outside the
 * declared union reaches this component. It used to throw here and take the page
 * down; now it degrades.
 *
 * §6.4 defines a treatment for four levels and no others, so the pill keeps
 * LOW's neutral one. Amber and red would both assert a severity nothing has
 * established. The label carries the value itself, so nothing claims the level
 * is low either.
 */
function unknownRiskPresentation(level: string): Presentation {
  const humanised = humaniseUnknownValue(level);

  return {
    label: humanised === null ? UNKNOWN_RISK_LABEL : `${humanised} risk`,
    modifier: RISK_LEVELS.LOW.modifier,
  };
}

export interface RiskIndicatorProps {
  /** An approval's `risk_level` or an incident's `severity`. */
  readonly level: RiskLevel;
}

export function RiskIndicator({ level }: RiskIndicatorProps): ReactElement {
  const { label, modifier } =
    readTableEntry(RISK_LEVELS, level) ?? unknownRiskPresentation(level);

  return <span className={`risk-indicator ${modifier}`}>{label}</span>;
}
