/**
 * Tests for the check-in desk.
 *
 * This is the screen used under pressure with a queue waiting, so the tests focus on the paths where
 * a dead end costs real time:
 *
 *   - a name matching several people must become a choice, not an instruction to retype
 *   - a failed reconciliation must read as a finding with a next step, not as a broken app
 *   - a failed verification must have no override, because the backend has none either
 *
 * The happy path is asserted end to end — search, verify, ticket, check in — because that sequence is
 * the product's original promise and a regression anywhere in it is invisible from a unit test of one
 * step.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import { EVENT_ID } from "../test/fixtures";

const searchCheckin = vi.fn();
const verifyCheckin = vi.fn();
const recoverTicket = vi.fn();
const completeCheckin = vi.fn();
const reconcilePayment = vi.fn();

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    searchCheckin: (...args: unknown[]) => searchCheckin(...args),
    verifyCheckin: (...args: unknown[]) => verifyCheckin(...args),
    recoverTicket: (...args: unknown[]) => recoverTicket(...args),
    completeCheckin: (...args: unknown[]) => completeCheckin(...args),
    reconcilePayment: (...args: unknown[]) => reconcilePayment(...args),
  };
});

const { CheckinConsole } = await import("./CheckinConsole");

const REGISTRATION = {
  registration_id: "REG-00042",
  attendee_name: "Kavya Nair",
  attendee_email: "kavya@example.com",
  attendee_phone: "+919876543210",
  event_id: EVENT_ID,
  status: "CONFIRMED" as const,
  payment_status: "CAPTURED" as const,
  ticket_type: "GENERAL",
  is_checked_in: false,
};

const ALL_PASSED = {
  registration_id: "REG-00042",
  verification: {
    all_passed: true,
    checks: [
      { name: "registration_exists", status: "PASS" as const, message: "Registration found." },
      { name: "payment_captured", status: "PASS" as const, message: "Payment captured." },
    ],
  },
  registration: {
    attendee_name: "Kavya Nair",
    ticket_type: "GENERAL",
    status: "CONFIRMED",
    payment_status: "CAPTURED",
  },
};

async function search(value = "Kavya") {
  await userEvent.type(screen.getByLabelText(/^Name$/), value);
  await userEvent.click(screen.getByRole("button", { name: /^Search$/ }));
}

beforeEach(() => {
  searchCheckin.mockResolvedValue({
    found: true,
    count: 1,
    registrations: [REGISTRATION],
    requires_disambiguation: false,
  });
  verifyCheckin.mockResolvedValue(ALL_PASSED);
  recoverTicket.mockResolvedValue({
    ticket_id: "REG-00042",
    registration_id: "REG-00042",
    download_url: "https://example.com/ticket.pdf",
    already_existed: false,
    message: "Ticket generated successfully.",
  });
  completeCheckin.mockResolvedValue({
    registration_id: "REG-00042",
    status: "CHECKED_IN",
    was_already_checked_in: false,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the happy path", () => {
  it("goes from a name to a recorded check-in", async () => {
    render(<CheckinConsole eventId={EVENT_ID} />);

    await search();
    expect(await screen.findByText("Kavya Nair")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Run the checks/i }));
    expect(await screen.findByText(/Everything checks out/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Issue the ticket/i }));
    expect(await screen.findByText(/Ticket ready/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Check them in/i }));
    expect(await screen.findByText(/^Checked in$/i)).toBeInTheDocument();

    expect(completeCheckin).toHaveBeenCalledWith(EVENT_ID, "REG-00042");
  });

  it("searches on the field the volunteer chose", async () => {
    render(<CheckinConsole eventId={EVENT_ID} />);

    await userEvent.selectOptions(screen.getByLabelText(/Search by/i), "registration_id");
    await userEvent.type(screen.getByLabelText(/Registration ID/i), "REG-00042");
    await userEvent.click(screen.getByRole("button", { name: /^Search$/ }));

    await waitFor(() =>
      expect(searchCheckin).toHaveBeenCalledWith(EVENT_ID, { registration_id: "REG-00042" }),
    );
  });

  it("says plainly when somebody was already checked in", async () => {
    completeCheckin.mockResolvedValue({
      registration_id: "REG-00042",
      status: "CHECKED_IN",
      was_already_checked_in: true,
    });

    render(<CheckinConsole eventId={EVENT_ID} />);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /Run the checks/i }));
    await userEvent.click(await screen.findByRole("button", { name: /Issue the ticket/i }));
    await userEvent.click(await screen.findByRole("button", { name: /Check them in/i }));

    expect(await screen.findByText(/Already checked in/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing was duplicated/i)).toBeInTheDocument();
  });

  it("notes when a ticket was reissued rather than created", async () => {
    recoverTicket.mockResolvedValue({
      ticket_id: "REG-00042",
      registration_id: "REG-00042",
      download_url: "https://example.com/ticket.pdf",
      already_existed: true,
      message: "Ticket already exists.",
    });

    render(<CheckinConsole eventId={EVENT_ID} />);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /Run the checks/i }));
    await userEvent.click(await screen.findByRole("button", { name: /Issue the ticket/i }));

    expect(await screen.findByText(/reissued, not duplicated/i)).toBeInTheDocument();
  });
});

describe("several people match", () => {
  it("offers the candidates instead of asking for a retype", async () => {
    searchCheckin.mockResolvedValue({
      found: true,
      count: 2,
      requires_disambiguation: true,
      message: "Multiple registrations found.",
      registrations: [
        {
          registration_id: "REG-00042",
          attendee_name: "Kavya Nair",
          attendee_email: "k***@example.com",
          ticket_type: "GENERAL",
        },
        {
          registration_id: "REG-00119",
          attendee_name: "Kavya Naik",
          attendee_email: "k***@other.com",
          ticket_type: "STUDENT",
        },
      ],
    });

    render(<CheckinConsole eventId={EVENT_ID} />);
    await search();

    expect(await screen.findByText(/2 people match that/i)).toBeInTheDocument();
    expect(screen.getByText("REG-00119")).toBeInTheDocument();
  });

  it("moves straight to verification once one is picked", async () => {
    searchCheckin.mockResolvedValue({
      found: true,
      count: 2,
      requires_disambiguation: true,
      registrations: [
        { registration_id: "REG-00042", attendee_name: "Kavya Nair" },
        { registration_id: "REG-00119", attendee_name: "Kavya Naik" },
      ],
    });

    render(<CheckinConsole eventId={EVENT_ID} />);
    await search();

    const buttons = await screen.findAllByRole("button", { name: /This one/i });
    await userEvent.click(buttons[0]!);

    expect(await screen.findByRole("button", { name: /Run the checks/i })).toBeInTheDocument();
  });

  it("keeps contact details partly hidden until somebody is identified", async () => {
    searchCheckin.mockResolvedValue({
      found: true,
      count: 2,
      requires_disambiguation: true,
      registrations: [
        {
          registration_id: "REG-00042",
          attendee_name: "Kavya Nair",
          attendee_email: "k***@example.com",
        },
        {
          registration_id: "REG-00119",
          attendee_name: "Kavya Naik",
          attendee_email: "k***@other.com",
        },
      ],
    });

    render(<CheckinConsole eventId={EVENT_ID} />);
    await search();

    await screen.findByText(/2 people match that/i);
    expect(screen.getByText(/k\*\*\*@example\.com/)).toBeInTheDocument();
    expect(screen.queryByText("kavya@example.com")).not.toBeInTheDocument();
  });
});

describe("nobody found", () => {
  it("offers the payment-reference fallback", async () => {
    searchCheckin.mockResolvedValue({
      found: false,
      count: 0,
      registrations: [],
      message: "No matching registration found.",
    });

    render(<CheckinConsole eventId={EVENT_ID} />);
    await search("Nobody");

    expect(await screen.findByText(/Try a payment reference/i)).toBeInTheDocument();
  });

  it("warns against asking for card details", async () => {
    searchCheckin.mockResolvedValue({ found: false, count: 0, registrations: [] });

    render(<CheckinConsole eventId={EVENT_ID} />);
    await search("Nobody");

    expect(
      await screen.findByText(/Never ask for a card number, CVV or PIN/i),
    ).toBeInTheDocument();
  });

  it("continues to verification when a payment reconciles", async () => {
    searchCheckin.mockResolvedValue({ found: false, count: 0, registrations: [] });
    reconcilePayment.mockResolvedValue({
      reconciled: true,
      registration_id: "REG-00042",
      registration: {
        attendee_name: "Kavya Nair",
        ticket_type: "GENERAL",
        status: "CONFIRMED",
        payment_status: "CAPTURED",
      },
      message: "Payment reconciled with registration.",
    });

    render(<CheckinConsole eventId={EVENT_ID} />);
    await search("Nobody");

    await userEvent.type(
      await screen.findByLabelText(/Transaction reference/i),
      "TXN-KH-78901",
    );
    await userEvent.click(screen.getByRole("button", { name: /Check payment/i }));

    expect(await screen.findByRole("button", { name: /Run the checks/i })).toBeInTheDocument();
  });

  it("reports an unmatched reference as a finding with a next step", async () => {
    // HTTP 200 with reconciled: false. The lookup worked; the answer is that it cannot be verified.
    searchCheckin.mockResolvedValue({ found: false, count: 0, registrations: [] });
    reconcilePayment.mockResolvedValue({
      reconciled: false,
      message: "No matching payment record was found for this event.",
      recovery_case_created: true,
    });

    render(<CheckinConsole eventId={EVENT_ID} />);
    await search("Nobody");

    await userEvent.type(await screen.findByLabelText(/Transaction reference/i), "TXN-BOGUS");
    await userEvent.click(screen.getByRole("button", { name: /Check payment/i }));

    expect(await screen.findByText(/No matching payment record was found/i)).toBeInTheDocument();
    expect(screen.getByText(/A recovery case has been opened/i)).toBeInTheDocument();
  });
});

describe("verification failures", () => {
  it("offers no way to proceed anyway", async () => {
    verifyCheckin.mockResolvedValue({
      registration_id: "REG-00042",
      verification: {
        all_passed: false,
        checks: [
          { name: "registration_exists", status: "PASS", message: "Registration found." },
          {
            name: "payment_captured",
            status: "FAIL",
            message: "Payment status is REFUNDED, so this ticket is not valid.",
          },
        ],
      },
      registration: {
        attendee_name: "Kavya Nair",
        ticket_type: "GENERAL",
        status: "CONFIRMED",
        payment_status: "REFUNDED",
      },
    });

    render(<CheckinConsole eventId={EVENT_ID} />);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /Run the checks/i }));

    expect(await screen.findByText(/There is no override/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Issue the ticket/i })).not.toBeInTheDocument();
    // The reason appears twice on purpose: once in the check list, once in the refusal notice.
    expect(screen.getAllByText(/Payment status is REFUNDED/i)).toHaveLength(2);
  });

  it("reports a verification error without losing the registration", async () => {
    verifyCheckin.mockRejectedValue(
      new ApiError("Registration system is currently unavailable.", 502),
    );

    render(<CheckinConsole eventId={EVENT_ID} />);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /Run the checks/i }));

    expect(
      await screen.findByText(/Registration system is currently unavailable/i),
    ).toBeInTheDocument();
    expect(screen.getByText("REG-00042")).toBeInTheDocument();
  });
});

describe("starting over", () => {
  it("clears everything for the next attendee", async () => {
    render(<CheckinConsole eventId={EVENT_ID} />);
    await search();
    await screen.findByText("Kavya Nair");

    await userEvent.click(screen.getByRole("button", { name: /Next attendee/i }));

    expect(screen.getByLabelText(/^Name$/)).toHaveValue("");
    expect(screen.getByRole("button", { name: /^Search$/ })).toBeInTheDocument();
  });
});
