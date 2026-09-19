/**
 * Tests for the API client's mode selection, error surfacing and money formatting.
 *
 * The invariant under test: mock data is opt-in only. A deployed console with a misconfigured or
 * failing backend must produce an explicit error rather than silently presenting fabricated
 * operational data as real. That is the one failure this product cannot afford, so it is the one
 * tested hardest.
 *
 * Module-level constants are read from `import.meta.env` at import time, so each test stubs the
 * environment and then re-imports the module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadApi(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    vi.stubEnv(k, v);
  }
  vi.doMock("./auth", () => ({
    getIdToken: vi.fn(async () => mockToken),
    storeDemoSession: vi.fn(),
  }));
  return import("./api");
}

let mockToken: string | null = null;

/**
 * A fetch stub shaped like the real `Response` surface the client uses.
 *
 * `text()` matters: the client reads the body as text and parses it, so that an empty 204 from a
 * mutation is a valid response rather than a JSON parse error. A stub with only `json()` would
 * pass while the real client broke.
 */
function stubFetch(response: { ok: boolean; status: number; body: unknown | (() => never) }) {
  const payload = () =>
    typeof response.body === "function" ? (response.body as () => never)() : response.body;

  const fetchMock = vi.fn(
    (_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: response.ok,
        status: response.status,
        json: async () => payload(),
        text: async () => {
          const value = payload();
          return value === undefined ? "" : JSON.stringify(value);
        },
      }) as unknown as Promise<Response>,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  mockToken = "fake.jwt.token";
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mock mode gating", () => {
  it("is off by default so real calls are attempted", async () => {
    const api = await loadApi({ VITE_API_URL: "https://api.example.com", VITE_USE_MOCK: "" });
    expect(api.isMockMode).toBe(false);
  });

  it("is on only when explicitly requested", async () => {
    const api = await loadApi({ VITE_USE_MOCK: "true", VITE_API_URL: "" });
    expect(api.isMockMode).toBe(true);
  });

  it("serves demo data when explicitly enabled", async () => {
    const api = await loadApi({ VITE_USE_MOCK: "true", VITE_API_URL: "" });
    const result = await api.getCommandCenter();
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.summary.budget_remaining_inr).toBe(75000);
  });

  it("returns an empty shape rather than inventing one for unmocked routes", async () => {
    // Deliberate: a fabricated figure presented as operational state is worse than a blank screen.
    const api = await loadApi({ VITE_USE_MOCK: "true", VITE_API_URL: "" });
    const budget = await api.getBudget("EVT-acd-mh-2026");
    expect(budget.total_budget).toBeUndefined();
  });

  it("does NOT fall back to mock data when the API URL is missing", async () => {
    const api = await loadApi({ VITE_API_URL: "", VITE_USE_MOCK: "" });
    await expect(api.getSpeakers("EVT-acd-mh-2026")).rejects.toThrow(/No API URL is configured/);
  });

  it("reports a configuration error category rather than returning data", async () => {
    const api = await loadApi({ VITE_API_URL: "", VITE_USE_MOCK: "" });
    await expect(api.getCommandCenter()).rejects.toMatchObject({
      category: "CONFIGURATION_ERROR",
    });
  });
});

describe("authentication handling", () => {
  it("surfaces an explicit error when there is no session", async () => {
    mockToken = null;
    const api = await loadApi({ VITE_API_URL: "https://api.example.com", VITE_USE_MOCK: "" });
    await expect(api.getCommandCenter()).rejects.toMatchObject({ status: 401 });
  });

  it("attaches the ID token as the Authorization header", async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, body: { speakers: [], count: 0 } });

    const api = await loadApi({ VITE_API_URL: "https://api.example.com", VITE_USE_MOCK: "" });
    await api.getSpeakers("EVT-acd-mh-2026");

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    // The API Gateway user-pool authorizer expects the bare token, not a Bearer prefix.
    expect(headers.Authorization).toBe("fake.jwt.token");
  });

  it("scopes requests to the configured organization", async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, body: { speakers: [], count: 0 } });

    const api = await loadApi({
      VITE_API_URL: "https://api.example.com",
      VITE_USE_MOCK: "",
      VITE_ORG_ID: "ORG-wemakedev",
    });
    await api.getSpeakers("EVT-acd-mh-2026");

    expect(fetchMock.mock.calls[0]?.[0]).toContain("organization_id=ORG-wemakedev");
  });

  it("sends the demo session request without a token", async () => {
    // The whole point of the demo route: the browser holds no credential, so it must not be
    // required to present one.
    mockToken = null;
    const fetchMock = stubFetch({
      ok: true,
      status: 200,
      body: {
        id_token: "demo.token",
        expires_in: 3600,
        email: "demo@communityops.local",
        organization_id: "ORG-wemakedev",
        role: "TEAM_MEMBER",
        is_demo: true,
        message: "ok",
      },
    });

    const api = await loadApi({ VITE_API_URL: "https://api.example.com", VITE_USE_MOCK: "" });
    const session = await api.startDemoSession();

    expect(session.is_demo).toBe(true);
    const init = fetchMock.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("never sends a password on the demo route", async () => {
    const fetchMock = stubFetch({
      ok: true,
      status: 200,
      body: {
        id_token: "demo.token",
        expires_in: 3600,
        email: "demo@communityops.local",
        organization_id: "ORG-wemakedev",
        role: "TEAM_MEMBER",
        is_demo: true,
        message: "ok",
      },
    });

    const api = await loadApi({ VITE_API_URL: "https://api.example.com", VITE_USE_MOCK: "" });
    await api.startDemoSession();

    const sent = String(fetchMock.mock.calls[0]?.[1]?.body ?? "");
    expect(sent.toLowerCase()).not.toContain("password");
  });
});

describe("backend failure surfacing", () => {
  it("propagates the backend error message and status", async () => {
    stubFetch({
      ok: false,
      status: 403,
      body: {
        error: "FORBIDDEN",
        message: "You are not authorized to access this organization's data.",
      },
    });

    const api = await loadApi({ VITE_API_URL: "https://api.example.com", VITE_USE_MOCK: "" });
    await expect(api.getCommandCenter()).rejects.toMatchObject({
      status: 403,
      category: "FORBIDDEN",
    });
  });

  it("still raises when the error body is not JSON", async () => {
    stubFetch({
      ok: false,
      status: 502,
      body: () => {
        throw new Error("not json");
      },
    });

    const api = await loadApi({ VITE_API_URL: "https://api.example.com", VITE_USE_MOCK: "" });
    await expect(api.getCommandCenter()).rejects.toMatchObject({ status: 502 });
  });

  it("distinguishes a refusal from a lost session", async () => {
    const api = await loadApi({ VITE_API_URL: "https://api.example.com", VITE_USE_MOCK: "" });

    const forbidden = new api.ApiError("no", 403, "FORBIDDEN");
    expect(forbidden.isForbidden).toBe(true);
    expect(forbidden.isUnauthenticated).toBe(false);

    const expired = new api.ApiError("gone", 401, "UNAUTHORIZED");
    expect(expired.isUnauthenticated).toBe(true);
    expect(expired.isForbidden).toBe(false);
  });

  it("reports a network failure separately from a backend error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    const api = await loadApi({ VITE_API_URL: "https://api.example.com", VITE_USE_MOCK: "" });
    await expect(api.getCommandCenter()).rejects.toMatchObject({
      status: 0,
      category: "NETWORK_ERROR",
    });
  });

  it("accepts an empty body from a mutation", async () => {
    stubFetch({ ok: true, status: 204, body: undefined });

    const api = await loadApi({ VITE_API_URL: "https://api.example.com", VITE_USE_MOCK: "" });
    await expect(
      api.markNotificationRead("NOTIF-1"),
    ).resolves.toEqual({});
  });
});

describe("money formatting", () => {
  it("uses Indian digit grouping", async () => {
    const api = await loadApi({ VITE_API_URL: "https://api.example.com", VITE_USE_MOCK: "" });
    expect(api.formatInr(250000)).toBe("2,50,000");
    expect(api.formatInr(75000)).toBe("75,000");
    expect(api.formatInrWithSymbol(62500)).toBe("₹62,500");
  });

  it("shows a dash rather than zero for a missing figure", async () => {
    // "—" and "₹0" mean different things operationally, and conflating them would misreport a
    // budget that has not been set as a budget that is exhausted.
    const api = await loadApi({ VITE_API_URL: "https://api.example.com", VITE_USE_MOCK: "" });
    expect(api.formatInr(undefined)).toBe("—");
    expect(api.formatInrWithSymbol(null)).toBe("—");
    expect(api.formatInr(0)).toBe("0");
  });

  it("turns backend enum values into readable text", async () => {
    const api = await loadApi({ VITE_API_URL: "https://api.example.com", VITE_USE_MOCK: "" });
    expect(api.humanize("BUDGET_COMMITTED")).toBe("Budget committed");
    expect(api.humanize("ACCOMMODATION")).toBe("Accommodation");
    expect(api.humanize(undefined)).toBe("");
  });

  it("returns empty strings for unparseable timestamps rather than Invalid Date", async () => {
    const api = await loadApi({ VITE_API_URL: "https://api.example.com", VITE_USE_MOCK: "" });
    expect(api.formatDate("not-a-date")).toBe("");
    expect(api.formatTime(undefined)).toBe("");
    expect(api.formatRelative("")).toBe("");
  });
});

describe("event context", () => {
  it("defaults to the configured event and can be overridden", async () => {
    const api = await loadApi({
      VITE_API_URL: "https://api.example.com",
      VITE_USE_MOCK: "",
      VITE_EVENT_ID: "EVT-somewhere-else",
    });
    expect(api.DEFAULT_EVENT_ID).toBe("EVT-somewhere-else");
  });
});
