/**
 * What the client actually puts on the wire: the token on every request, and the
 * organization every request claims (design.md Properties 1, 4 and 5;
 * requirements 1.7, 2.7, 16.3, 16.4).
 *
 * `api.test.ts` checks these once each, through `getSpeakers`, and that is the
 * right shape for a test of mode selection. Properties 1 and 4 are quantified
 * over *every* request the console issues, so they are checked here across the
 * whole client surface — reads and writes both, because a write carries the
 * organization in its body and a read carries it in the query string, and those
 * are two different pieces of code.
 *
 * Two clarifications about what these tests can and cannot establish:
 *
 *   - **Non-expiry is `auth.ts`'s guarantee, not the client's.** `getIdToken`
 *     refreshes inside the Cognito SDK before answering, and a user pool is not
 *     reachable from jsdom. What the client owes Property 1 is what is checked
 *     below: ask for a token per request, send exactly that token, and issue
 *     nothing at all when there is none.
 *   - **Demo isolation is proven end to end by the deployed-stack check**
 *     (design.md §21.3). The half that is reachable here is the outbound half: a
 *     demo-scoped token fixture, and every request naming the demo organization
 *     and nothing else. Nothing in the browser enforces isolation —
 *     `tenancy.authorize_organization` does — and these tests deliberately do not
 *     pretend otherwise.
 *
 * Module-level constants in `api.ts` are read from `import.meta.env` at import
 * time, so each case stubs the environment and re-imports the module, the same
 * way `api.test.ts` does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ApiModule = typeof import("./api");

const API_BASE = "https://api.example.com";
const EVENT = "EVT-devcon-2026";
const REGISTRATION = "REG-2026-004829";

/** The organization the demo identity's token names (design.md A18). */
const DEMO_ORG = "ORG-demo";

/**
 * A build-time `VITE_ORG_ID` naming something else entirely, present in every
 * case below. Whenever a token names an organization the token wins, so this
 * value appearing in a request would be a defect rather than a fallback.
 */
const CONFIGURED_ORG = "ORG-build-time-default";

/** An organization the token does not name. Nothing may ever send it. */
const FOREIGN_ORG = "ORG-someone-else";

/** Stand-in for the Cognito SDK's token, which jsdom cannot obtain. */
const session: { queue: (string | null)[]; issued: (string | null)[] } = {
  queue: [null],
  issued: [],
};

/**
 * The next token `api.ts` is handed. The last entry repeats once the queue is
 * down to one, so a case that does not care about rotation sets a single token.
 */
function nextToken(): string | null {
  const [head, ...rest] = session.queue;

  if (rest.length > 0) {
    session.queue = rest;
  }

  const token = head ?? null;
  session.issued.push(token);

  return token;
}

/** An ID token carrying the given claims. Unsigned: nothing here verifies one. */
function tokenFor(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `header.${payload}.signature`;
}

/** The demo identity's session: one group, which is the demo organization. */
function demoToken(): string {
  return tokenFor({ sub: "demo-user", "cognito:groups": [DEMO_ORG] });
}

/**
 * Import `api.ts` under a stubbed environment and a stubbed Cognito boundary.
 *
 * `getIdToken` is the only thing replaced. `orgContext.ts` stays real, because
 * the claim it reads and the token the client sends have to be derived from one
 * value for Property 4 to mean anything.
 */
async function loadApi(env: Record<string, string> = {}): Promise<ApiModule> {
  vi.resetModules();

  vi.stubEnv("VITE_API_URL", API_BASE);
  vi.stubEnv("VITE_USE_MOCK", "");
  vi.stubEnv("VITE_ORG_ID", CONFIGURED_ORG);

  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }

  vi.doMock("./auth", () => ({
    getIdToken: () => Promise.resolve(nextToken()),
    storeDemoSession: vi.fn(),
  }));

  return import("./api");
}

type FetchMock = ReturnType<typeof stubFetch>;

/** A fetch that answers every request with an empty object. */
function stubFetch() {
  const fetchMock = vi.fn(
    (_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      } as unknown as Response),
  );

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

interface ClientCall {
  readonly name: string;
  /** Reads carry the organization in the query string, writes in the body. */
  readonly kind: "read" | "write";
  readonly issue: (api: ApiModule) => Promise<unknown>;
}

/**
 * Every function in the client's public surface that issues a request.
 *
 * A new endpoint added to `api.ts` without an entry here is the one way these
 * properties can quietly stop being universal, which is why the list is
 * exhaustive rather than representative.
 */
const CLIENT_CALLS: readonly ClientCall[] = [
  { name: "getCommandCenter", kind: "read", issue: (api) => api.getCommandCenter() },
  { name: "getEvents", kind: "read", issue: (api) => api.getEvents() },
  { name: "getEvent", kind: "read", issue: (api) => api.getEvent(EVENT) },
  { name: "getAttention", kind: "read", issue: (api) => api.getAttention(EVENT) },
  { name: "getBrief", kind: "read", issue: (api) => api.getBrief(EVENT) },
  { name: "getEventHealth", kind: "read", issue: (api) => api.getEventHealth(EVENT) },
  { name: "getWorkload", kind: "read", issue: (api) => api.getWorkload(EVENT) },
  { name: "getAttendeeOps", kind: "read", issue: (api) => api.getAttendeeOps(EVENT) },
  { name: "getTeams", kind: "read", issue: (api) => api.getTeams(EVENT) },
  { name: "getTeam", kind: "read", issue: (api) => api.getTeam(EVENT, "TEAM-logistics") },
  { name: "getEventTasks", kind: "read", issue: (api) => api.getEventTasks(EVENT) },
  { name: "getSpeakers", kind: "read", issue: (api) => api.getSpeakers(EVENT) },
  { name: "draftSpeakerFollowup", kind: "write", issue: (api) => api.draftSpeakerFollowup(EVENT, "SPK-1") },
  { name: "updateSpeaker", kind: "write", issue: (api) => api.updateSpeaker(EVENT, "SPK-1", { status: "CONFIRMED" }) },
  { name: "getTasks", kind: "read", issue: (api) => api.getTasks(EVENT, "TEAM-logistics") },
  { name: "updateTask", kind: "write", issue: (api) => api.updateTask(EVENT, "TEAM-logistics", "TSK-1", { status: "IN_PROGRESS" }) },
  { name: "reassignTask", kind: "write", issue: (api) => api.reassignTask(EVENT, "TEAM-logistics", "TSK-1", { assigned_to: "USR-2", reason: "Coverage" }) },
  { name: "getApprovals", kind: "read", issue: (api) => api.getApprovals(EVENT) },
  { name: "getApproval", kind: "read", issue: (api) => api.getApproval(EVENT, "APR-001") },
  { name: "getIncidents", kind: "read", issue: (api) => api.getIncidents(EVENT) },
  { name: "getIncident", kind: "read", issue: (api) => api.getIncident(EVENT, "INC-1") },
  { name: "getIncidentComments", kind: "read", issue: (api) => api.getIncidentComments(EVENT, "INC-1") },
  { name: "addIncidentComment", kind: "write", issue: (api) => api.addIncidentComment(EVENT, "INC-1", { body: "Checked" }) },
  { name: "updateIncident", kind: "write", issue: (api) => api.updateIncident(EVENT, "INC-1", { status: "ANALYZING" }) },
  { name: "resolveIncident", kind: "write", issue: (api) => api.resolveIncident(EVENT, "INC-1", { resolution_summary: "Resolved" }) },
  { name: "reopenIncident", kind: "write", issue: (api) => api.reopenIncident(EVENT, "INC-1", "Recurrence") },
  { name: "getAuditLog", kind: "read", issue: (api) => api.getAuditLog(EVENT) },
  { name: "getBudget", kind: "read", issue: (api) => api.getBudget(EVENT) },
  { name: "getExpenses", kind: "read", issue: (api) => api.getExpenses(EVENT) },
  { name: "projectBudget", kind: "write", issue: (api) => api.projectBudget(EVENT, "VENUE", 1000) },
  { name: "getAgentCapabilities", kind: "read", issue: (api) => api.getAgentCapabilities() },
  { name: "getAgentActivity", kind: "read", issue: (api) => api.getAgentActivity(EVENT) },
  { name: "agentChat", kind: "write", issue: (api) => api.agentChat({ event_id: EVENT, message: "Status" }) },
  {
    name: "decideApproval",
    kind: "write",
    issue: (api) => api.decideApproval(EVENT, "APR-001", "APPROVED", ""),
  },
  {
    name: "searchCheckin",
    kind: "write",
    issue: (api) => api.searchCheckin(EVENT, { email: "ada@example.org" }),
  },
  {
    name: "verifyCheckin",
    kind: "write",
    issue: (api) => api.verifyCheckin(EVENT, REGISTRATION),
  },
  {
    name: "recoverTicket",
    kind: "write",
    issue: (api) => api.recoverTicket(EVENT, REGISTRATION),
  },
  {
    name: "completeCheckin",
    kind: "write",
    issue: (api) => api.completeCheckin(EVENT, REGISTRATION),
  },
  {
    name: "verifyQrPayload",
    kind: "write",
    issue: (api) => api.verifyQrPayload(EVENT, "signed-qr-payload"),
  },
  {
    name: "reconcilePayment",
    kind: "write",
    issue: (api) => api.reconcilePayment(EVENT, "TXN-77421"),
  },
];

/** The `Authorization` header of the nth request. */
function authorizationOf(fetchMock: FetchMock, index: number): unknown {
  const headers = fetchMock.mock.calls[index]?.[1]?.headers;

  return headers === undefined ? undefined : (headers as Record<string, unknown>)["Authorization"];
}

/** Where the nth request claimed its organization, whatever kind of call it was. */
function organizationOf(fetchMock: FetchMock, index: number, kind: "read" | "write"): unknown {
  const [url, init] = fetchMock.mock.calls[index] ?? [];

  if (kind === "read") {
    return new URL(String(url)).searchParams.get("organization_id");
  }

  const body: unknown = JSON.parse(String(init?.body ?? "{}"));

  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)["organization_id"]
    : undefined;
}

beforeEach(() => {
  session.queue = [tokenFor({ sub: "user-1", "cognito:groups": ["ORG-wemakedev"] })];
  session.issued = [];
});

afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Property 1 — every request carries the session's token (requirement 1.7)", () => {
  it("attaches the ID token to every read and every write the client issues", async () => {
    const token = tokenFor({ sub: "user-1", "cognito:groups": ["ORG-wemakedev"] });
    session.queue = [token];

    const fetchMock = stubFetch();
    const api = await loadApi();

    for (const call of CLIENT_CALLS) {
      await call.issue(api);
    }

    expect(fetchMock).toHaveBeenCalledTimes(CLIENT_CALLS.length);

    CLIENT_CALLS.forEach((call, index) => {
      expect(authorizationOf(fetchMock, index), call.name).toBe(token);
    });
  });

  it("re-reads the token per request, so a refreshed one is what gets sent", async () => {
    const first = tokenFor({ sub: "user-1", "cognito:groups": ["ORG-wemakedev"], jti: "first" });
    const refreshed = tokenFor({
      sub: "user-1",
      "cognito:groups": ["ORG-wemakedev"],
      jti: "refreshed",
    });
    session.queue = [first, refreshed];

    const fetchMock = stubFetch();
    const api = await loadApi();

    await api.getEvents();
    await api.getSpeakers(EVENT);

    // Nothing is cached in the client: a token refreshed between two requests
    // reaches the second one, which is the whole of "non-expired" that this side
    // of the boundary can honour.
    expect(authorizationOf(fetchMock, 0)).toBe(first);
    expect(authorizationOf(fetchMock, 1)).toBe(refreshed);
  });

  it("issues no request at all when the session has no token", async () => {
    session.queue = [null];

    const fetchMock = stubFetch();
    const api = await loadApi();

    for (const call of CLIENT_CALLS) {
      await expect(call.issue(api), call.name).rejects.toMatchObject({
        status: 401,
        category: "UNAUTHORIZED",
      });
    }

    // The second half of Property 1, and the half an error message cannot prove:
    // an unauthenticated request is never put on the wire to be refused.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Property 4 — a demo session is scoped to the demo organization", () => {
  it("rejects a valid token with no organization before resolving context or issuing a request", async () => {
    session.queue = [tokenFor({ sub: "user-without-organization", "cognito:groups": ["TEAM_MEMBER"] })];

    const fetchMock = stubFetch();
    const api = await loadApi();

    await expect(api.getOrganizationContext()).rejects.toMatchObject({
      status: 403,
      category: "FORBIDDEN",
    });
    await expect(api.getEvents()).rejects.toMatchObject({
      status: 403,
      category: "FORBIDDEN",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the demo organization on every read and every write", async () => {
    session.queue = [demoToken()];

    const fetchMock = stubFetch();
    const api = await loadApi();

    for (const call of CLIENT_CALLS) {
      await call.issue(api);
    }

    CLIENT_CALLS.forEach((call, index) => {
      expect(organizationOf(fetchMock, index, call.kind), call.name).toBe(DEMO_ORG);
    });

    // The token names an organization, so the build-time default is not consulted
    // at all — it is a fallback for a session that names none, not a second
    // source of truth (requirement 16.3).
    const wire = JSON.stringify(fetchMock.mock.calls);
    expect(wire).not.toContain(CONFIGURED_ORG);
    expect(wire).not.toContain(FOREIGN_ORG);
  });

  it("disregards an organization named in the URL (Property 5)", async () => {
    session.queue = [demoToken()];
    window.history.replaceState({}, "", `/approvals?organization_id=${FOREIGN_ORG}`);

    const fetchMock = stubFetch();
    const api = await loadApi();

    await api.getApprovals(EVENT);

    expect(organizationOf(fetchMock, 0, "read")).toBe(DEMO_ORG);
  });

  it("disregards a stored preference for an organization the token does not name", async () => {
    session.queue = [demoToken()];
    window.localStorage.setItem("communityops.organization.demo-user", FOREIGN_ORG);

    const fetchMock = stubFetch();
    const api = await loadApi();

    await api.getIncidents(EVENT);

    expect(organizationOf(fetchMock, 0, "read")).toBe(DEMO_ORG);
  });

  it("disregards an organization a caller passes as a search field", async () => {
    session.queue = [demoToken()];

    const fetchMock = stubFetch();
    const api = await loadApi();

    // `searchCheckin` spreads caller fields into the request body, so a field
    // named like the scoping parameter is the one way a page could substitute an
    // organization for the token's. The resolved value has to win.
    await api.searchCheckin(EVENT, { name: "Ada", ...({ organization_id: FOREIGN_ORG } as { organization_id: string }) });

    expect(organizationOf(fetchMock, 0, "write")).toBe(DEMO_ORG);
  });
});


describe("mutation wire contracts", () => {
  it("serializes edited approval wording in edited_action", async () => {
    const fetchMock = stubFetch();
    const api = await loadApi();
    await api.decideApproval(EVENT, "APR-1", "EDITED", "", "Use the confirmed backup");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain(`/events/${EVENT}/approvals/APR-1`);
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      organization_id: "ORG-wemakedev",
      decision: "EDITED",
      notes: "",
      edited_action: "Use the confirmed backup",
    });
  });

  it("posts task assignment and reason to the dedicated reassign endpoint", async () => {
    const fetchMock = stubFetch();
    const api = await loadApi();
    await api.reassignTask(EVENT, "TEAM-1", "TSK-1", { assigned_to: "USR-2", reason: "Coverage" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain(`/events/${EVENT}/teams/TEAM-1/tasks/TSK-1/reassign`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      assigned_to: "USR-2",
      reason: "Coverage",
      organization_id: "ORG-wemakedev",
    });
  });
});
