/**
 * StatusBadge renders a text label for every status it is given (requirements
 * 12.5, 12.9, 15.10), including a status outside the declared union — `apiFetch`
 * asserts response shapes rather than validating them, so that value is
 * reachable in production and must not crash the render.
 *
 * The nested Property 8 block states that as the property it is: every domain,
 * every status, a readable label. The tests above it pin the two things the
 * property deliberately does not — the §6.4 tone, and the copy an unrecognised
 * value degrades to.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  StatusBadge,
  UNKNOWN_STATUS_LABEL,
  type OperationalState,
  type StatusBadgeProps,
} from "./StatusBadge";
import { unionValues, type UnionTable } from "../test/unionValues";
import type {
  Approval,
  Event,
  Registration,
  Speaker,
  Task,
  VerificationCheck,
} from "../types";

/**
 * A status the backend could return tomorrow and `src/types.ts` does not declare.
 * Widening through `string` is how a value arrives from `apiFetch`, which casts
 * the response rather than parsing it.
 */
const fromBackend: string = "AWAITING_PAYMENT";
const undeclaredStatus = fromBackend as Task["status"];

/**
 * Every domain the badge accepts, and for each one every status its contract
 * declares. Each table is keyed on the real union, so a value added in
 * `src/types.ts` — or a whole new domain added to `StatusBadgeProps` — stops this
 * file compiling until it is listed here.
 */
const DOMAINS: UnionTable<StatusBadgeProps["domain"]> = {
  operational: true,
  event: true,
  registration: true,
  payment: true,
  speaker: true,
  task: true,
  approval: true,
  verification: true,
};

const OPERATIONAL_STATES: UnionTable<OperationalState> = {
  HANDLED: true,
  NEEDS_DECISION: true,
  CANNOT_BE_AUTOMATED: true,
};

const EVENT_STATUSES: UnionTable<Event["status"]> = {
  DRAFT: true,
  PUBLISHED: true,
  ACTIVE: true,
  COMPLETED: true,
  CANCELLED: true,
};

const REGISTRATION_STATUSES: UnionTable<Registration["status"]> = {
  CONFIRMED: true,
  PENDING: true,
  CANCELLED: true,
  WAITLISTED: true,
};

const PAYMENT_STATUSES: UnionTable<Registration["payment_status"]> = {
  CAPTURED: true,
  PENDING: true,
  FAILED: true,
  REFUNDED: true,
  NOT_REQUIRED: true,
};

const SPEAKER_STATUSES: UnionTable<Speaker["status"]> = {
  IDENTIFIED: true,
  INVITED: true,
  AWAITING_RESPONSE: true,
  FOLLOWUP_SENT: true,
  CONFIRMED: true,
  DECLINED: true,
  CANCELLED: true,
  BACKUP: true,
};

const TASK_STATUSES: UnionTable<Task["status"]> = {
  PENDING: true,
  IN_PROGRESS: true,
  BLOCKED: true,
  COMPLETED: true,
  CANCELLED: true,
  OVERDUE: true,
};

const APPROVAL_STATUSES: UnionTable<Approval["status"]> = {
  PENDING: true,
  APPROVED: true,
  EDITED: true,
  DECLINED: true,
  EXPIRED: true,
};

const VERIFICATION_STATUSES: UnionTable<VerificationCheck["status"]> = {
  PASS: true,
  WARN: true,
  FAIL: true,
};

/**
 * One case per domain-and-status pair. `StatusBadgeProps` is what keeps the two
 * halves honest: a status can only be listed under the domain whose contract
 * declares it.
 */
const EVERY_STATUS: StatusBadgeProps[] = [
  ...unionValues(OPERATIONAL_STATES).map(
    (status): StatusBadgeProps => ({ domain: "operational", status }),
  ),
  ...unionValues(EVENT_STATUSES).map((status): StatusBadgeProps => ({ domain: "event", status })),
  ...unionValues(REGISTRATION_STATUSES).map(
    (status): StatusBadgeProps => ({ domain: "registration", status }),
  ),
  ...unionValues(PAYMENT_STATUSES).map(
    (status): StatusBadgeProps => ({ domain: "payment", status }),
  ),
  ...unionValues(SPEAKER_STATUSES).map(
    (status): StatusBadgeProps => ({ domain: "speaker", status }),
  ),
  ...unionValues(TASK_STATUSES).map((status): StatusBadgeProps => ({ domain: "task", status })),
  ...unionValues(APPROVAL_STATUSES).map(
    (status): StatusBadgeProps => ({ domain: "approval", status }),
  ),
  ...unionValues(VERIFICATION_STATUSES).map(
    (status): StatusBadgeProps => ({ domain: "verification", status }),
  ),
];

/** Any text a user could read. An empty node and a bare colour swatch both fail it. */
const READABLE_TEXT = /\S/;

describe("StatusBadge", () => {
  it("renders the §6.4 label and tone for a declared status", () => {
    render(<StatusBadge domain="task" status="OVERDUE" detail="3 days late" />);

    expect(screen.getByText("Overdue")).toHaveClass("status-badge__label");
    expect(screen.getByText("Overdue").parentElement).toHaveClass("status-badge--attention");
    expect(screen.getByText("3 days late")).toBeInTheDocument();
  });

  it("degrades an undeclared status to a readable neutral badge", () => {
    render(<StatusBadge domain="task" status={undeclaredStatus} />);

    // Humanised, so nothing on screen looks like a raw internal token.
    const label = screen.getByText("Awaiting payment");

    expect(label).toBeInTheDocument();
    // Neutral: severity is unknown, so the badge claims neither attention nor
    // that the item was handled.
    expect(label.parentElement).toHaveClass("status-badge--muted");
  });

  it("falls back to fixed copy when an undeclared status has no readable text", () => {
    const blank: string = "  ";

    render(<StatusBadge domain="approval" status={blank as Approval["status"]} />);

    expect(screen.getByText(UNKNOWN_STATUS_LABEL)).toBeInTheDocument();
  });

  /**
   * Property 8 — status is conveyed by label as well as colour
   * (requirements 12.5, 12.9, 15.10).
   */
  describe("Property 8: a readable label for every status", () => {
    it("covers every domain the badge accepts", () => {
      // `DOMAINS` is a compile-time check that no domain is forgotten; this is
      // the runtime half — a new domain listed there but not enumerated below
      // fails here instead of silently shrinking the property's coverage.
      const enumerated = new Set(EVERY_STATUS.map((props) => props.domain));

      expect([...enumerated].sort()).toEqual(unionValues(DOMAINS).sort());
    });

    it.each(EVERY_STATUS)("labels the $domain status $status", (props) => {
      render(<StatusBadge {...props} />);

      // `getByText` fails both when nothing matches and when more than one node
      // does, so this asserts a label rendered *and* that it is the badge's only
      // readable text. A badge that leaned on its colour would fail here.
      const label = screen.getByText(READABLE_TEXT);

      expect(label).toBeVisible();
      expect(label).not.toHaveAttribute("aria-hidden");
    });

    it("keeps the colour swatch out of the accessibility tree", () => {
      const { container } = render(
        <StatusBadge domain="task" status="BLOCKED" detail="Waiting on the venue" />,
      );

      // The dot has no role and no name by design, so the DOM is the only handle
      // on it. One hidden node, and it is the dot: the label is not hidden.
      const hidden = container.querySelectorAll("[aria-hidden='true']");

      expect(hidden).toHaveLength(1);
      // It repeats the label's colour and carries no text of its own, so losing
      // colour loses nothing a user needs to read.
      expect(hidden.item(0)).toBeEmptyDOMElement();
      expect(screen.getByText("Blocked")).toBeVisible();
      expect(screen.getByText("Waiting on the venue")).toBeVisible();
    });
  });
});
