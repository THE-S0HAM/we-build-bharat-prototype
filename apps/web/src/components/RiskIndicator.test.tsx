/**
 * RiskIndicator renders a text label for every level it is given (requirements
 * 12.9, 15.10), including a severity outside the declared union — `apiFetch`
 * asserts response shapes rather than validating them, so that value is
 * reachable in production and must not crash the render.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RiskIndicator, UNKNOWN_RISK_LABEL, type RiskLevel } from "./RiskIndicator";
import { unionValues, type UnionTable } from "../test/unionValues";
import type { Incident } from "../types";

/** A severity the backend could return tomorrow and `src/types.ts` does not declare. */
const fromBackend: string = "SEVERE";
const undeclaredLevel = fromBackend as Incident["severity"];

/**
 * The whole scale, keyed on the union both contracts feed — a level added to
 * `Approval["risk_level"]` or `Incident["severity"]` stops this file compiling
 * until it is listed.
 */
const EVERY_LEVEL: UnionTable<RiskLevel> = {
  LOW: true,
  MEDIUM: true,
  HIGH: true,
  CRITICAL: true,
};

/** Any text a user could read. An empty node and a bare colour swatch both fail it. */
const READABLE_TEXT = /\S/;

describe("RiskIndicator", () => {
  it("renders the §6.4 label and treatment for a declared level", () => {
    render(<RiskIndicator level="CRITICAL" />);

    expect(screen.getByText("Critical risk")).toHaveClass("risk-indicator--critical");
  });

  it("degrades an undeclared level to a readable neutral pill", () => {
    render(<RiskIndicator level={undeclaredLevel} />);

    const pill = screen.getByText("Severe risk");

    expect(pill).toBeInTheDocument();
    // Neither the amber nor the red: nothing has established the severity.
    expect(pill).not.toHaveClass("risk-indicator--medium");
    expect(pill).not.toHaveClass("risk-indicator--high");
    expect(pill).not.toHaveClass("risk-indicator--critical");
  });

  it("falls back to fixed copy when an undeclared level has no readable text", () => {
    const blank: string = "";

    render(<RiskIndicator level={blank as Incident["severity"]} />);

    expect(screen.getByText(UNKNOWN_RISK_LABEL)).toBeInTheDocument();
  });

  /**
   * Property 8 for the risk scale (requirements 12.9, 15.10): the escalation
   * from neutral to amber to red is never the only signal.
   */
  describe("Property 8: a readable label for every level", () => {
    it.each(unionValues(EVERY_LEVEL))("labels the %s level", (level) => {
      render(<RiskIndicator level={level} />);

      // `getByText` fails when nothing matches and when more than one node does,
      // so this is both "a label rendered" and "it is the pill's only text".
      expect(screen.getByText(READABLE_TEXT)).toBeVisible();
    });
  });
});
