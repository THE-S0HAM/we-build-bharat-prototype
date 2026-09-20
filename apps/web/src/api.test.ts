/**
 * Tests for the API client's mode selection and error surfacing.
 *
 * The invariant under test: mock data is opt-in only. A deployed console with a
 * misconfigured or failing backend must produce an explicit error rather than
 * silently presenting fabricated operational data as real.
 *
 * Module-level constants are read from import.meta.env at import time, so each
 * test stubs the environment and then re-imports the module.
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

function tokenFor(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.signature`;
}

const AUTHORIZED_TOKEN = tokenFor({
  sub: "user-1",
  "cognito:groups": ["ORG-wemakedev"],
});

/** A fetch stub with typed call arguments so assertions stay type-safe. */
function stubFetch(response: { ok: boolean; status: number; body: unknown | (() => never) }) {
  const fetchMock = vi.fn(
    (_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: response.ok,
        status: response.status,
        json: async () =>
          typeof response.body === "function"
            ? (response.body as () => never)()
            : response.body,
      }) as unknown as Promise<Response>,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  mockToken = AUTHORIZED_TOKEN;
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
    const result = await api.getSpeakers("EVT-devcon-2026");
    expect(result.speakers).toEqual([]);
  });

  it("does NOT fall back to mock data when the API URL is missing", async () => {
    const api = await loadApi({ VITE_API_URL: "", VITE_USE_MOCK: "" });
    await expect(api.getSpeakers("EVT-devcon-2026")).rejects.toThrow(/No API URL is configured/);
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
    await api.getSpeakers("EVT-devcon-2026");

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(AUTHORIZED_TOKEN);
  });

  it("scopes requests to the configured organization", async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, body: { speakers: [], count: 0 } });

    const api = await loadApi({
      VITE_API_URL: "https://api.example.com",
      VITE_USE_MOCK: "",
      VITE_ORG_ID: "ORG-wemakedev",
    });
    await api.getSpeakers("EVT-devcon-2026");

    expect(fetchMock.mock.calls[0]?.[0]).toContain("organization_id=ORG-wemakedev");
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
});
