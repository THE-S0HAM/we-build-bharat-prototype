/**
 * Check-In behaviour (task 8.7; requirements 9.3, 9.4, 9.5, 9.6, 9.8, 9.9, 9.10,
 * 9.12, 16.8).
 *
 * The page is exercised the way a volunteer at the desk does: type, search, pick,
 * read the checks, let the person in. The API is supplied as a `CheckinService`
 * so the responses under test are the real response shapes — nothing here stubs
 * `fetch`, and nothing here asserts on an implementation detail of the wiring.
 *
 * The candidate fixtures deliberately carry a phone number the multi-match
 * endpoint would never send. That is the point: if the page ever widens a masked
 * candidate back into a full record, the number appears in the DOM and the
 * masking test fails.
 */

import { describe, expect, it, vi } from "vitest";
import { configure, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { ApiError } from "../api";
import { SessionContext, type SessionValue } from "../session/sessionContext";
import type { Registration, SearchResult, TicketResult, VerificationCheck } from "../types";
import { CheckinConsole } from "./CheckinConsole";
import { VERIFICATION_CHECK_NAMES, type SearchField } from "./checkin/checkinFlow";
import type {
  CheckinCompletion,
  CheckinService,
  ReconcileOutcome,
  VerificationOutcome,
} from "./checkin/checkinService";

const EVENT_ID = "EVT-devcon-2026";

/**
 * These are the slowest tests in the suite by construction: each one types into a
 * real input, renders the whole page twice, and waits on two sequential
 * responses. Under the full suite's parallel workers that is slow, not wrong, and
 * the defaults (5s per test, 1s per `findBy`) leave no headroom for it. The
 * budgets below are generous on purpose — a timeout here should mean the flow
 * genuinely stopped, never that the machine was busy.
 */
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function registration(overrides: Partial<Registration> = {}): Registration {
  return {
    registration_id: "REG-2026-004821",
    event_id: EVENT_ID,
    attendee_name: "Priya Sharma",
    attendee_email: "priya.sharma@example.com",
    attendee_phone: "+919876543210",
    status: "CONFIRMED",
    payment_status: "CAPTURED",
    ticket_type: "GENERAL",
    is_checked_in: false,
    ...overrides,
  };
}

const CHECK_MESSAGES: Readonly<Record<string, string>> = {
  registration_exists: "Registration record found",
  event_match: "Registration belongs to the correct event",
  registration_status: "Registration is confirmed",
  payment_status: "Payment status: CAPTURED",
  not_cancelled: "Registration is not cancelled",
  not_refunded: "No refund recorded",
  checkin_eligibility: "Attendee is eligible for check-in",
};

const ALL_PASS: readonly VerificationCheck[] = VERIFICATION_CHECK_NAMES.map((name) => ({
  name,
  status: "PASS",
  message: CHECK_MESSAGES[name] ?? name,
}));

function withCheck(
  name: string,
  status: VerificationCheck["status"],
  message: string,
): readonly VerificationCheck[] {
  return ALL_PASS.map((check) => (check.name === name ? { name, status, message } : check));
}

function verification(
  checks: readonly VerificationCheck[] = ALL_PASS,
): VerificationOutcome {
  return {
    registrationId: "REG-2026-004821",
    allPassed: checks.every((check) => check.status === "PASS"),
    checks,
    registration: {
      attendee_name: "Priya Sharma",
      ticket_type: "GENERAL",
      status: "CONFIRMED",
      payment_status: "CAPTURED",
    },
  };
}

function completion(overrides: Partial<CheckinCompletion> = {}): CheckinCompletion {
  return {
    registrationId: "REG-2026-004821",
    status: "CHECKED_IN",
    checkedInAt: "2026-10-15T09:12:00Z",
    message: "Check-in completed successfully.",
    wasAlreadyCheckedIn: false,
    ...overrides,
  };
}

function ticket(overrides: Partial<TicketResult> = {}): TicketResult {
  return {
    ticket_id: "REG-2026-004821",
    registration_id: "REG-2026-004821",
    download_url: "#",
    already_existed: false,
    message: "Ticket generated successfully.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Calls {
  readonly search: { field: SearchField; value: string }[];
  readonly verify: string[];
  readonly recover: string[];
  readonly reconcile: string[];
  readonly complete: string[];
}

interface Responses {
  readonly search?: SearchResult | (() => Promise<SearchResult>);
  readonly verify?: VerificationOutcome;
  readonly recover?: TicketResult;
  readonly reconcile?: ReconcileOutcome;
  readonly complete?: CheckinCompletion;
}

const SESSION: SessionValue = {
  status: "authenticated",
  refresh: () => Promise.resolve(),
  signOut: () => undefined,
};

function unconfigured(name: string): Promise<never> {
  return Promise.reject(new Error(`${name} was not expected in this test`));
}

/** The page, with the responses this test cares about and a record of the calls. */
function renderConsole(responses: Responses) {
  const calls: Calls = { search: [], verify: [], recover: [], reconcile: [], complete: [] };

  const service: CheckinService = {
    search(_eventId, term) {
      calls.search.push(term);

      if (typeof responses.search === "function") return responses.search();

      return responses.search === undefined
        ? unconfigured("search")
        : Promise.resolve(responses.search);
    },
    verify(_eventId, registrationId) {
      calls.verify.push(registrationId);

      return responses.verify === undefined
        ? unconfigured("verify")
        : Promise.resolve(responses.verify);
    },
    recover(_eventId, registrationId) {
      calls.recover.push(registrationId);

      return responses.recover === undefined
        ? unconfigured("recover")
        : Promise.resolve(responses.recover);
    },
    reconcile(_eventId, transactionId) {
      calls.reconcile.push(transactionId);

      return responses.reconcile === undefined
        ? unconfigured("reconcile")
        : Promise.resolve(responses.reconcile);
    },
    complete(_eventId, registrationId) {
      calls.complete.push(registrationId);

      return responses.complete === undefined
        ? unconfigured("complete")
        : Promise.resolve(responses.complete);
    },
  };

  const view = render(
    <MemoryRouter>
      <SessionContext.Provider value={SESSION}>
        <CheckinConsole eventId={EVENT_ID} service={service} />
      </SessionContext.Provider>
    </MemoryRouter>,
  );

  return { ...view, calls };
}

async function search(term: string) {
  await userEvent.type(
    screen.getByLabelText("Registration ID, email, phone or name"),
    term,
  );
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
}

/**
 * Outcome copy appears twice by design: once where the volunteer is looking, and
 * once in the `aria-live` region that announces it (requirement 15.8). Assertions
 * about what a surface *says* are scoped to that surface, so the announcement
 * cannot satisfy them on its own.
 */
function region(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("a single match advances to verification (requirement 9.3)", () => {
  it("verifies the matched registration without asking for anything else", async () => {
    const { calls } = renderConsole({
      search: { found: true, count: 1, registrations: [registration()], requires_disambiguation: false },
      verify: verification(),
    });

    await search("REG-2026-004821");

    expect(await screen.findByRole("heading", { name: "Verification" })).toBeInTheDocument();
    expect(calls.verify).toEqual(["REG-2026-004821"]);

    // The one field ran the lookup the endpoint documents for that shape.
    expect(calls.search).toEqual([{ field: "registration_id", value: "REG-2026-004821" }]);

    // Step 3 of the four-step stepper has actually been reached.
    expect(screen.getByText("Step 4 of 4: Check in. 3 of 4 complete.")).toBeInTheDocument();
  });

  it("explains what can be searched while it is idle (requirement 9.11)", () => {
    renderConsole({ search: { found: false, count: 0, registrations: [] } });

    expect(screen.getByText("Search to find an attendee.")).toBeInTheDocument();
    expect(screen.getByText(/a registration ID like REG-2026-004821/)).toBeInTheDocument();
  });
});

describe("a multi-match renders masked candidates only (requirements 9.4, 16.8)", () => {
  const ambiguous: SearchResult = {
    found: true,
    count: 2,
    requires_disambiguation: true,
    message: "Multiple registrations found. Please provide additional identifying information.",
    registrations: [
      registration({ attendee_email: "p***@example.com" }),
      registration({ registration_id: "REG-2026-004899", attendee_email: "p***@example.net" }),
    ],
  };

  it("shows the masked fields, withholds everything else, and waits to be told", async () => {
    const { container, calls } = renderConsole({ search: ambiguous, verify: verification() });

    await search("Priya Sharma");

    expect(
      await screen.findByRole("heading", { name: "Pick the right registration" }),
    ).toBeInTheDocument();

    // The four fields the API returned for a candidate.
    expect(screen.getByText("REG-2026-004821")).toBeInTheDocument();
    expect(screen.getByText("REG-2026-004899")).toBeInTheDocument();
    expect(screen.getByText("p***@example.com")).toBeInTheDocument();

    // Nothing else off the record reaches the DOM: no unmasked address, no phone
    // number, no registration or payment status.
    expect(container.innerHTML).not.toContain("priya.sharma@example.com");
    expect(container.innerHTML).not.toContain("+919876543210");
    expect(container.innerHTML).not.toContain("CAPTURED");

    // No auto-selection: nothing is verified until a volunteer picks.
    expect(calls.verify).toEqual([]);
    expect(screen.getByText("Step 2 of 4: Identify. 1 of 4 complete.")).toBeInTheDocument();
  });

  it("advances only on an explicit selection", async () => {
    const { calls } = renderConsole({ search: ambiguous, verify: verification() });

    await search("Priya Sharma");
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Use registration REG-2026-004899 for Priya Sharma",
      }),
    );

    expect(await screen.findByRole("heading", { name: "Verification" })).toBeInTheDocument();
    expect(calls.verify).toEqual(["REG-2026-004899"]);
  });
});

describe("the seven checks render with their results (requirements 9.5, 9.7)", () => {
  it("renders all seven named checks, each with the response's verdict and message", async () => {
    const { container } = renderConsole({
      search: { found: true, count: 1, registrations: [registration()] },
      verify: verification(withCheck("payment_status", "FAIL", "Payment is still pending")),
    });

    await search("REG-2026-004821");
    await screen.findByRole("heading", { name: "Verification" });

    const rendered = [...container.querySelectorAll("[data-check-name]")].map((node) =>
      node.getAttribute("data-check-name"),
    );
    expect(rendered).toEqual([...VERIFICATION_CHECK_NAMES]);

    // Every message on screen is the response's own.
    expect(screen.getByText("Registration record found")).toBeInTheDocument();
    expect(screen.getByText("Payment is still pending")).toBeInTheDocument();

    // The verdict is paired with a text label, never carried by colour alone.
    expect(screen.getByText("Fail")).toBeInTheDocument();
    expect(screen.getAllByText("Pass")).toHaveLength(6);

    // A failed check withholds completion.
    expect(screen.getByRole("button", { name: "Complete check-in" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Recover ticket" })).toBeDisabled();
  });

  it("reports a check the response omitted as not evaluated rather than as a pass", async () => {
    renderConsole({
      search: { found: true, count: 1, registrations: [registration()] },
      verify: verification([
        { name: "registration_exists", status: "FAIL", message: "No registration record provided" },
      ]),
    });

    await search("REG-2026-004821");
    await screen.findByRole("heading", { name: "Verification" });

    expect(screen.getAllByText("Not checked")).toHaveLength(6);
    expect(screen.queryByText("Pass")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete check-in" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Recover ticket" })).toBeDisabled();
  });
});

describe("a checkin_eligibility WARN does not block completion (requirement 9.6)", () => {
  const warned = verification(
    withCheck("checkin_eligibility", "WARN", "Attendee has already checked in"),
  );

  it("reads \"Already checked in\", and completion stays available", async () => {
    renderConsole({
      search: { found: true, count: 1, registrations: [registration({ is_checked_in: true })] },
      verify: warned,
      complete: completion({ wasAlreadyCheckedIn: true, checkedInAt: "2026-10-15T09:12:00Z" }),
    });

    await search("REG-2026-004821");
    await screen.findByRole("heading", { name: "Verification" });

    expect(screen.getByText("Already checked in")).toBeInTheDocument();
    expect(screen.getByText("Warning")).toBeInTheDocument();
    expect(screen.getByText("Attendee has already checked in")).toBeInTheDocument();

    // The whole point of requirement 9.6: the queue keeps moving.
    const complete = screen.getByRole("button", { name: "Complete check-in" });
    expect(complete).toBeEnabled();

    await userEvent.click(complete);
    expect(await screen.findByRole("heading", { name: "Scene handled." })).toBeInTheDocument();
  });
});

describe("recover and complete report prior state truthfully (requirements 9.8, 9.10)", () => {
  it("names a pre-existing ticket as pre-existing, not as newly generated", async () => {
    renderConsole({
      search: { found: true, count: 1, registrations: [registration()] },
      verify: verification(),
      recover: ticket({ already_existed: true }),
    });

    await search("REG-2026-004821");
    await screen.findByRole("heading", { name: "Ticket nahi mila? Koi scene nahi." });

    await userEvent.click(screen.getByRole("button", { name: "Recover ticket" }));

    await screen.findByText("Ticket REG-2026-004821");

    const recovery = within(region("Ticket nahi mila? Koi scene nahi."));
    expect(recovery.getByText(/This ticket already existed/)).toBeInTheDocument();
    expect(recovery.queryByText("A new ticket has been generated.")).not.toBeInTheDocument();
  });

  it("names a new ticket as new", async () => {
    renderConsole({
      search: { found: true, count: 1, registrations: [registration()] },
      verify: verification(),
      recover: ticket({ already_existed: false }),
    });

    await search("REG-2026-004821");
    await userEvent.click(await screen.findByRole("button", { name: "Recover ticket" }));

    await screen.findByText("Ticket REG-2026-004821");
    expect(
      within(region("Ticket nahi mila? Koi scene nahi.")).getByText(
        "A new ticket has been generated.",
      ),
    ).toBeInTheDocument();
  });

  it("reports an existing check-in as existing, with the time it actually happened", async () => {
    renderConsole({
      search: { found: true, count: 1, registrations: [registration({ is_checked_in: true })] },
      verify: verification(withCheck("checkin_eligibility", "WARN", "Attendee has already checked in")),
      complete: completion({ wasAlreadyCheckedIn: true, checkedInAt: "2026-10-15T09:12:00Z" }),
    });

    await search("REG-2026-004821");
    await userEvent.click(await screen.findByRole("button", { name: "Complete check-in" }));

    expect(await screen.findByRole("heading", { name: "Scene handled." })).toBeInTheDocument();

    const done = within(region("Scene handled."));
    expect(done.getByText(/was already checked in at/)).toBeInTheDocument();
    expect(done.getByText(/No new check-in was recorded/)).toBeInTheDocument();
  });

  it("reports a new check-in as new, with checked_in_at", async () => {
    renderConsole({
      search: { found: true, count: 1, registrations: [registration()] },
      verify: verification(),
      complete: completion(),
    });

    await search("REG-2026-004821");
    await userEvent.click(await screen.findByRole("button", { name: "Complete check-in" }));

    expect(await screen.findByRole("heading", { name: "Scene handled." })).toBeInTheDocument();

    const done = within(region("Scene handled."));
    expect(done.getByText(/^Checked in at /)).toBeInTheDocument();
    expect(done.queryByText(/was already checked in/)).not.toBeInTheDocument();

    // The response's `checked_in_at`, as a machine-readable time.
    expect(done.getByText("15 Oct 2026, 2:42 pm")).toHaveAttribute(
      "datetime",
      "2026-10-15T09:12:00.000Z",
    );
  });
});

describe("the reconciliation branch (requirement 9.9)", () => {
  const nothingFound: SearchResult = {
    found: false,
    count: 0,
    registrations: [],
    message: "No matching registration found. You may try a payment reference for reconciliation.",
  };

  it("sends a transaction reference only, and offers no field for card data", async () => {
    const { calls } = renderConsole({
      search: nothingFound,
      reconcile: { kind: "reconciled", registrationId: "REG-2026-004821", attendeeName: "Priya Sharma", message: "" },
      verify: verification(),
    });

    await search("unknown person");

    const reference = await screen.findByLabelText("Transaction reference");
    expect(screen.getByText(/never asks for a card number, a CVV or a PIN/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/card/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/cvv/i)).not.toBeInTheDocument();

    await userEvent.type(reference, "TXN-KH-78901");
    await userEvent.click(screen.getByRole("button", { name: "Check payment reference" }));

    expect(calls.reconcile).toEqual(["TXN-KH-78901"]);
    expect(await screen.findByRole("heading", { name: "Verification" })).toBeInTheDocument();
  });

  it("reports recovery_case_created as a case, not as a resolution", async () => {
    const { calls } = renderConsole({
      search: nothingFound,
      reconcile: {
        kind: "case",
        message: "No matching registration or payment record was found.",
      },
    });

    await search("unknown person");
    await userEvent.type(await screen.findByLabelText("Transaction reference"), "TXN-NOPE");
    await userEvent.click(screen.getByRole("button", { name: "Check payment reference" }));

    expect(await screen.findByText("Recovery case opened. This is not resolved.")).toBeInTheDocument();
    expect(screen.getByText("Cannot be automated")).toBeInTheDocument();

    // Nothing advanced on the strength of a case.
    expect(calls.verify).toEqual([]);
    expect(screen.queryByRole("heading", { name: "Verification" })).not.toBeInTheDocument();
  });
});

describe("a failed request keeps the search term (requirements 9.12, 13.5)", () => {
  it("renders the category's copy and leaves what was typed in the field", async () => {
    renderConsole({
      search: () => Promise.reject(new ApiError("boom", 500, "INTERNAL_ERROR")),
    });

    await search("Priya Sharma");

    expect(await screen.findByText("CommunityOps couldn't load this view.")).toBeInTheDocument();
    expect(screen.getByLabelText("Registration ID, email, phone or name")).toHaveValue(
      "Priya Sharma",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("renders the masked candidates alongside an ambiguous-match failure", async () => {
    let attempt = 0;
    const { container } = renderConsole({
      search: () => {
        attempt += 1;

        return attempt === 1
          ? Promise.resolve<SearchResult>({
              found: true,
              count: 2,
              requires_disambiguation: true,
              registrations: [
                registration({ attendee_email: "p***@example.com" }),
                registration({ registration_id: "REG-2026-004899", attendee_email: "p***@example.net" }),
              ],
            })
          : Promise.reject(new ApiError("ambiguous", 409, "AMBIGUOUS_MATCH"));
      },
    });

    await search("Priya Sharma");
    await screen.findByRole("heading", { name: "Pick the right registration" });

    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(
      await screen.findByText("More than one person matches. Pick the right registration."),
    ).toBeInTheDocument();
    expect(container.innerHTML).not.toContain("priya.sharma@example.com");
  });
});
