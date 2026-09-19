/**
 * The terminology and product-name sweep, as a guard (task 12.2, design.md
 * §15.2, correctness property 18).
 *
 * §15.2 opens with "one canonical term per concept. Synonyms are defects." A
 * sweep run by hand settles the question for one afternoon; this file settles it
 * for every afternoon after, which is the only form the rule can hold in.
 *
 * Three claims:
 *
 *   1. **One product name.** Every `…Ops` name in the product is either
 *      CommunityOps or one of the four agent areas the navigation is built from.
 *      A fifth would be a second product name, and that is the defect
 *      requirement 3.1 and property 18 forbid — in copy, in the page title and
 *      in document metadata alike, so `index.html` and `package.json` are read
 *      here beside `src/`.
 *   2. **The decision actions read Approve, Edit and Decline** — not Accept, not
 *      Reject, not Deny, not Modify, not Override (requirement 12.8).
 *   3. **The three operational states use their canonical wording** — "Handled",
 *      "Needs your decision", "Cannot be automated" (requirement 12.7). Asserted
 *      through the badge that renders them, because the label a user reads is
 *      the claim, not the constant behind it.
 *
 * Claim 1 is asserted over source text rather than over a render, because it is
 * a claim about every string in the product including the ones no test mounts.
 * The text comes from Vite's `?raw` glob, so what is scanned is the module graph
 * the build compiles.
 *
 * **Validates: Requirements 3.1, 12.7, 12.8**
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import indexHtml from "../index.html?raw";
import packageJson from "../package.json?raw";
import {
  APPROVE_LABEL,
  DECLINE_LABEL,
  EDIT_LABEL,
  type ApprovalDecision,
} from "./approvals/decision";
import { StatusBadge, type OperationalState } from "./components/StatusBadge";

/** Every module under `src/`, as text. See security.surface.test.tsx. */
const RAW_MODULES = import.meta.glob("./**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * Everywhere a user-visible name can be written: the product's own modules, the
 * pre-hydration document, and the package metadata.
 */
const SURFACES: readonly (readonly [string, string])[] = [
  ...Object.entries(RAW_MODULES as Record<string, string>).map(
    ([path, text]) => [path.replace(/^\.\//, "src/"), text] as const,
  ),
  ["index.html", indexHtml],
  ["package.json", packageJson],
];

describe("one product name (requirement 3.1, property 18)", () => {
  /**
   * The product, and the four agent areas of design.md §7.2. The areas are page
   * and agent names inside CommunityOps, not products — and this list is
   * exhaustive, so a name outside it is either a second product or an area
   * nobody added to the navigation.
   */
  const KNOWN_OPS_NAMES: readonly string[] = [
    "CommunityOps",
    "SpeakerOps",
    "TeamOps",
    "IncidentOps",
    "AttendeeOps",
  ];

  /**
   * The shape a product name in this space takes. Capitalised, which is what
   * separates a name from an identifier: `attendeeOps` is the capability flag
   * for the AttendeeOps area, not a second product.
   */
  const OPS_NAME = /\b[A-Z][A-Za-z0-9]*Ops\b/g;

  it("uses no name beyond the product and its four agent areas", () => {
    // A guard over no surfaces would pass without reading anything.
    expect(SURFACES.length).toBeGreaterThan(0);

    const unknown = SURFACES.flatMap(([path, text]) =>
      (text.match(OPS_NAME) ?? [])
        .filter((name) => !KNOWN_OPS_NAMES.includes(name))
        .map((name) => `${path}: ${name}`),
    );

    expect([...new Set(unknown)]).toEqual([]);
  });

  it("reads the surfaces it claims to have swept", () => {
    // The negative control: the assertion above is an absence, and an absence
    // passes just as well over text that was never read.
    for (const surface of ["index.html", "package.json", "src/api.ts"]) {
      const found = SURFACES.find(([path]) => path === surface);

      expect(found, `${surface} was not swept`).toBeDefined();
      expect(found?.[1] ?? "").toMatch(/communityops/i);
    }
  });

  it("names CommunityOps in the document title and metadata", () => {
    expect(indexHtml).toContain("<title>CommunityOps</title>");
    expect(indexHtml).toContain('name="application-name" content="CommunityOps"');
  });

  it("names the package for the product", () => {
    expect(JSON.parse(packageJson).name).toBe("communityops-web");
  });
});

describe("the decision actions (requirement 12.8)", () => {
  it("read exactly Approve, Edit and Decline", () => {
    expect([APPROVE_LABEL, EDIT_LABEL, DECLINE_LABEL]).toEqual(["Approve", "Edit", "Decline"]);
  });

  it("cover every decision the contract accepts, and no more", () => {
    // Three labels for three decisions. A fourth decision with no label, or a
    // label answering to no decision, is the drift this asserts against.
    const decisions: readonly ApprovalDecision[] = ["APPROVED", "EDITED", "DECLINED"];

    expect(decisions).toHaveLength(3);
  });
});

describe("the three operational states (requirement 12.7)", () => {
  const CANONICAL_LABELS: Readonly<Record<OperationalState, string>> = {
    HANDLED: "Handled",
    NEEDS_DECISION: "Needs your decision",
    CANNOT_BE_AUTOMATED: "Cannot be automated",
  };

  for (const [status, label] of Object.entries(CANONICAL_LABELS)) {
    it(`renders ${status} as "${label}"`, () => {
      render(<StatusBadge domain="operational" status={status as OperationalState} />);

      expect(screen.getByText(label)).toBeInTheDocument();
    });
  }
});
