/**
 * Tests for the status vocabulary.
 *
 * Two invariants, and the second is the one that actually bites.
 *
 * 1. **Every backend status maps to a deliberate tone.** The lists below are the full enumerations
 *    from the Python models. If the backend adds a state and nobody maps it, it silently renders as
 *    neutral "pending" — an escalated incident looking identical to a backlog item.
 *
 * 2. **Every tone has a stylesheet rule.** A tone with no `.badge-*` rule renders as unstyled text
 *    with no background, which on a light theme is close to invisible. This is checked against the
 *    real `index.css` rather than a copy, so the two cannot drift apart.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { toneFor } from "./status";
import type { StatusTone } from "./types";

/**
 * The real stylesheet, as text.
 *
 * Read from disk rather than imported. Vitest does not process CSS, so `import "./index.css?raw"`
 * resolves to an empty module and the check would pass vacuously — which is worse than not having
 * it, because it would look like coverage.
 */
const STYLESHEET = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");

/** Every status the backend can put on the wire, grouped as the Python enums group them. */
const BACKEND_STATUSES = {
  task: [
    "BACKLOG",
    "PENDING",
    "ASSIGNED",
    "IN_PROGRESS",
    "BLOCKED",
    "REVIEW",
    "COMPLETED",
    "CANCELLED",
    "OVERDUE",
  ],
  speaker: [
    "IDENTIFIED",
    "INVITED",
    "AWAITING_RESPONSE",
    "FOLLOWUP_SENT",
    "CONFIRMED",
    "DECLINED",
    "CANCELLED",
    "BACKUP",
  ],
  incident: [
    "REPORTED",
    "DETECTED",
    "ACKNOWLEDGED",
    "ANALYZING",
    "RECOMMENDATION_READY",
    "AWAITING_APPROVAL",
    "APPROVED",
    "EXECUTING",
    "RESOLVED",
    "REOPENED",
    "CLOSED",
    "REJECTED",
    "ESCALATED",
  ],
  approval: ["PENDING", "APPROVED", "DECLINED", "EXPIRED", "EDITED"],
  event: ["DRAFT", "PUBLISHED", "ACTIVE", "PAUSED", "COMPLETED", "CANCELLED", "ARCHIVED"],
  severity: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
  riskTier: ["LOW", "MEDIUM", "HIGH", "NEVER"],
  taskRisk: ["NONE", "LOW", "MEDIUM", "HIGH"],
};

const ALL_STATUSES = [...new Set(Object.values(BACKEND_STATUSES).flat())];

/**
 * States where neutral really is the right answer: work that exists and is waiting its turn, with
 * nothing wrong and nothing required. Anything *not* on this list that resolves to `pending` is an
 * unmapped status rather than a deliberate one.
 */
const DELIBERATELY_NEUTRAL = new Set([
  "BACKLOG",
  "ASSIGNED",
  "REVIEW",
  "PENDING", // handled separately: it maps to needs-decision
  "IDENTIFIED",
  "INVITED",
  "BACKUP",
  "REPORTED",
  "DETECTED",
  "ACKNOWLEDGED",
  "DRAFT",
  "ARCHIVED",
]);

describe("status coverage", () => {
  it("maps every backend status to a deliberate tone", () => {
    const unmapped = ALL_STATUSES.filter(
      (status) => toneFor(status) === "pending" && !DELIBERATELY_NEUTRAL.has(status),
    );
    expect(unmapped).toEqual([]);
  });

  it("puts states that got worse while nobody acted into an at-risk tone", () => {
    for (const status of ["EXPIRED", "ESCALATED", "REOPENED", "AWAITING_RESPONSE", "PAUSED"]) {
      expect(toneFor(status)).toBe<StatusTone>("at-risk");
    }
  });

  it("separates 'needs a decision' from 'nothing is required'", () => {
    expect(toneFor("PENDING")).toBe<StatusTone>("needs-decision");
    expect(toneFor("AWAITING_APPROVAL")).toBe<StatusTone>("needs-decision");
    expect(toneFor("IN_PROGRESS")).toBe<StatusTone>("info");
  });

  it("treats every form of 'not happening' the same way", () => {
    for (const status of ["DECLINED", "REJECTED", "CANCELLED", "BLOCKED"]) {
      expect(toneFor(status)).toBe<StatusTone>("blocked");
    }
  });

  it("marks a capability no role may exercise as categorically off-limits", () => {
    // Not "high risk". The distinction is the product's whole authority model.
    expect(toneFor("NEVER")).toBe<StatusTone>("cannot-automate");
    expect(toneFor("HIGH")).toBe<StatusTone>("high");
  });

  it("distinguishes no risk from low risk", () => {
    expect(toneFor("NONE")).toBe<StatusTone>("handled");
    expect(toneFor("LOW")).toBe<StatusTone>("low");
  });

  it("is case-insensitive and tolerates absent values", () => {
    expect(toneFor("completed")).toBe<StatusTone>("completed");
    expect(toneFor(undefined)).toBe<StatusTone>("pending");
    expect(toneFor("")).toBe<StatusTone>("pending");
  });

  it("never returns a tone that would render unstyled", () => {
    const tones = new Set<string>(ALL_STATUSES.map((status) => toneFor(status)));
    tones.add(toneFor(undefined));

    // Guard against the check silently becoming vacuous if the read ever returns nothing.
    expect(STYLESHEET.length).toBeGreaterThan(1000);

    const missing = [...tones].filter((tone) => !STYLESHEET.includes(`.badge-${tone}`));
    expect(missing).toEqual([]);
  });
});
