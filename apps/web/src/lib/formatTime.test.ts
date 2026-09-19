/**
 * Tests for the single shared time formatter (design.md §7.1, §15.3 check 12).
 *
 * A fixed reference point keeps every expectation deterministic.
 */

import { describe, expect, it } from "vitest";
import {
  UNKNOWN_TIME_LABEL,
  formatAbsoluteTime,
  formatRelativeTime,
  parseTimestamp,
  toMachineTime,
} from "./formatTime";

const NOW = new Date("2025-03-12T10:00:00.000Z");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** ISO timestamp offset from the fixed reference point. */
function at(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

describe("formatRelativeTime", () => {
  it("names the present and both directions of the past and future", () => {
    expect(formatRelativeTime(at(0), NOW)).toBe("now");
    expect(formatRelativeTime(at(-5 * MINUTE), NOW)).toBe("5 minutes ago");
    expect(formatRelativeTime(at(3 * HOUR), NOW)).toBe("in 3 hours");
    expect(formatRelativeTime(at(-26 * HOUR), NOW)).toBe("yesterday");
    expect(formatRelativeTime(at(-40 * DAY), NOW)).toBe("last month");
  });

  it("promotes to the next unit instead of overflowing the current one", () => {
    // 59.6 seconds must not read "60 seconds ago".
    expect(formatRelativeTime(at(-59_600), NOW)).toBe("1 minute ago");
  });

  it("reports an unusable timestamp without echoing the value", () => {
    expect(formatRelativeTime("who knows", NOW)).toBe(UNKNOWN_TIME_LABEL);
  });
});

describe("absolute and machine time", () => {
  it("formats a full date and time for titles and drawers", () => {
    const absolute = formatAbsoluteTime(at(0));

    expect(absolute).toContain("2025");
    expect(absolute).not.toBe(UNKNOWN_TIME_LABEL);
  });

  it("normalises a parseable timestamp and rejects an unusable one", () => {
    expect(toMachineTime(at(0))).toBe("2025-03-12T10:00:00.000Z");
    expect(toMachineTime("who knows")).toBeNull();
    expect(parseTimestamp("who knows")).toBeNull();
  });
});
