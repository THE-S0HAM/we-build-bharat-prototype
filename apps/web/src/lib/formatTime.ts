/**
 * The product's single time formatter.
 *
 * design.md §7.1 standardises relative time as "one formatter, used everywhere;
 * absolute timestamp available in the drawer or as a title attribute", and
 * §15.3 check 12 makes it a per-page review item. Every surface that shows a
 * timestamp — `Timeline`, drawers, decision cards, task rows — imports from
 * here. A component that formats a date inline is a defect.
 *
 * Built on `Intl` only: no date library is added (design.md §6.3 keeps the
 * dependency surface closed).
 *
 * All API timestamps are ISO-8601 strings on the modelled fields in
 * `src/types.ts` (`timestamp`, `requested_at`, `due_date`, `detected_at`, …).
 * An unparseable value is reported as `UNKNOWN_TIME_LABEL` rather than thrown
 * or echoed back, so no raw backend value reaches the screen.
 */

/** One locale for every formatted date and time in the console. */
const LOCALE = "en-IN";

/** Copy used when a timestamp cannot be parsed. Plain, and leaks nothing. */
export const UNKNOWN_TIME_LABEL = "Time unavailable";

const MS_PER_SECOND = 1000;

/**
 * Unit ladder walked by `formatRelativeTime`. Each `amount` is how many of the
 * current unit make up the next one, so the delta is divided down the list
 * until it fits. `week` uses the average month/week ratio; anything beyond the
 * last entry is expressed in years.
 */
const DIVISIONS = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
] as const satisfies readonly { amount: number; unit: Intl.RelativeTimeFormatUnit }[];

/* Formatter instances are created once: constructing `Intl` objects is the
   expensive part, and a timeline renders hundreds of entries. */

/** `numeric: "auto"` gives "now", "yesterday" and "last month" where English has them. */
const relativeFormatter = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

const absoluteFormatter = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * Parse an API timestamp.
 *
 * @returns the `Date`, or `null` when the value is not a usable timestamp.
 */
export function parseTimestamp(timestamp: string): Date | null {
  const parsed = new Date(timestamp);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Human-readable distance from `now` — "5 minutes ago", "yesterday", "in 3 hours".
 *
 * @param timestamp ISO-8601 timestamp from an API response.
 * @param now reference point; pass an explicit value to keep rendering deterministic.
 */
export function formatRelativeTime(timestamp: string, now: Date = new Date()): string {
  const date = parseTimestamp(timestamp);

  if (date === null) {
    return UNKNOWN_TIME_LABEL;
  }

  let delta = (date.getTime() - now.getTime()) / MS_PER_SECOND;

  for (const division of DIVISIONS) {
    const rounded = Math.round(delta);

    // Compare the *rounded* value so a delta of 59.6s reads "1 minute ago"
    // rather than "60 seconds ago".
    if (Math.abs(rounded) < division.amount) {
      return relativeFormatter.format(rounded, division.unit);
    }

    delta /= division.amount;
  }

  return relativeFormatter.format(Math.round(delta), "year");
}

/**
 * Full date and time, for the `title` attribute beside a relative time and for
 * the absolute timestamp shown inside a drawer (design.md §7.1).
 */
export function formatAbsoluteTime(timestamp: string): string {
  const date = parseTimestamp(timestamp);

  return date === null ? UNKNOWN_TIME_LABEL : absoluteFormatter.format(date);
}

/**
 * Machine-readable value for a `<time dateTime>` attribute.
 *
 * @returns the normalised ISO-8601 string, or `null` when the attribute should
 * be omitted because the timestamp is unusable.
 */
export function toMachineTime(timestamp: string): string | null {
  const date = parseTimestamp(timestamp);

  return date === null ? null : date.toISOString();
}
