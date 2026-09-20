import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DemoAccountAction } from "./DemoAccountAction";

const demo = vi.hoisted(() => ({
  calls: 0,
  error: null as unknown,
  hold: false,
  release: null as null | (() => void),
}));

vi.mock("../api", () => ({
  startDemoSession: () => {
    demo.calls += 1;
    if (demo.error !== null) return Promise.reject(demo.error);
    return new Promise((resolve) => {
      if (demo.hold) demo.release = () => resolve({});
      else resolve({});
    });
  },
}));

beforeEach(() => {
  demo.calls = 0;
  demo.error = null;
  demo.hold = false;
  demo.release = null;
});

describe("DemoAccountAction", () => {
  it("requests a restricted backend session with no browser credentials", async () => {
    const signedIn = vi.fn();
    render(<DemoAccountAction onSignedIn={signedIn} />);
    await userEvent.click(screen.getByRole("button", { name: "Try Demo Account" }));
    await waitFor(() => expect(signedIn).toHaveBeenCalledOnce());
    expect(demo.calls).toBe(1);
  });

  it("shows an in-flight state", async () => {
    demo.hold = true;
    render(<DemoAccountAction onSignedIn={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Try Demo Account" }));
    expect(screen.getByRole("button", { name: "Preparing your demo workspace…" })).toBeDisabled();
    demo.release?.();
  });

  it("shows safe failure copy and supports retry for transient errors", async () => {
    demo.error = { status: 503, category: "EXTERNAL_SERVICE_ERROR" };
    render(<DemoAccountAction onSignedIn={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Try Demo Account" }));
    expect(await screen.findByText("Demo access is temporarily unavailable.")).toBeInTheDocument();
    demo.error = null;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(demo.calls).toBe(2));
  });

  it.each([
    { status: 404, category: "NOT_FOUND" },
    { status: 0, category: "CONFIGURATION_ERROR" },
  ])("retires retry for unavailable demo configuration", async (error) => {
    demo.error = error;
    render(<DemoAccountAction onSignedIn={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Try Demo Account" }));
    expect(await screen.findByText("Demo access is not available for this deployment.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Try/ })).not.toBeInTheDocument();
  });
});
