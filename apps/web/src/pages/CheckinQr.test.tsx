import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { SessionContext } from "../session/sessionContext";
import type { CheckinService } from "./checkin/checkinService";
import { CheckinConsole } from "./CheckinConsole";

function service(): CheckinService {
  return {
    search: vi.fn(), recover: vi.fn(), reconcile: vi.fn(), complete: vi.fn(),
    verify: vi.fn().mockResolvedValue({ registrationId: "REG-1", allPassed: true, checks: [], registration: { attendee_name: "Priya", ticket_type: "GENERAL", status: "CONFIRMED", payment_status: "CAPTURED" } }),
    verifyQr: vi.fn().mockResolvedValue({ valid: true, registration_id: "REG-1", attendee_name: "Priya", ticket_status: "ACTIVE", message: "Valid" }),
  };
}
describe("QR check-in verification", () => {
  it("asks the server to verify the payload and still runs entry verification before completion", async () => {
    const api = service();
    render(<MemoryRouter><SessionContext.Provider value={{ status: "authenticated", refresh: () => Promise.resolve(), signOut: () => undefined }}><CheckinConsole eventId="EVT-1" service={api} /></SessionContext.Provider></MemoryRouter>);
    const payload = '{"r":"REG-1","e":"EVT-1","o":"ORG-1"}';
    fireEvent.change(screen.getByLabelText("Scanned QR payload"), { target: { value: payload } });
    await userEvent.click(screen.getByRole("button", { name: "Verify QR" }));
    expect(await screen.findByText("Valid ticket for Priya.")).toBeInTheDocument();
    expect(api.verifyQr).toHaveBeenCalledWith("EVT-1", payload);
    await userEvent.click(screen.getByRole("button", { name: "Run entry verification" }));
    expect(api.verify).toHaveBeenCalledWith("EVT-1", "REG-1");
    expect(screen.getByText("Ticket nahi mila? Koi scene nahi.")).toBeInTheDocument();
  });
});
