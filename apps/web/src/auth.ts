/**
 * Cognito authentication for the CommunityOps console.
 *
 * The deployed API Gateway uses a Cognito user-pool authorizer, so every request needs a valid ID
 * token. SRP is used for sign-in, so the password never leaves the browser in clear text, and the
 * Cognito SDK holds and refreshes the tokens.
 *
 * Two things are carried in the `cognito:groups` claim: groups prefixed `ORG-` are organization
 * memberships, and `LEADER` / `TEAM_MEMBER` are roles. The claim is read here to decide what to
 * render. It is *not* the authorization boundary — the API resolves team scope from DynamoDB and
 * will refuse an out-of-scope request whatever this module concluded. That matters in practice: a
 * member removed from a team keeps a valid token until it expires, so the UI can believe they have
 * access after the API has stopped agreeing.
 *
 * Demo sessions come from the backend. `POST /demo/session` authenticates one fixed restricted
 * identity server-side and returns its ID token, so no credential is ever present in this bundle.
 */

import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";

import type { Role } from "./types";

const USER_POOL_ID = import.meta.env.VITE_COGNITO_USER_POOL_ID || "";
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID || "";

export const isAuthConfigured = Boolean(USER_POOL_ID && CLIENT_ID);

/**
 * Where a backend-issued demo token lives.
 *
 * The Cognito SDK owns its own storage keys and there is no supported way to inject a token it did
 * not obtain itself, so a demo session is held separately and `getIdToken` checks both. Session
 * storage rather than local: a demo session should not outlive the tab, and there is no refresh
 * token to extend it with anyway.
 */
const DEMO_TOKEN_KEY = "communityops.demo.token";
const DEMO_META_KEY = "communityops.demo.meta";

let pool: CognitoUserPool | null = null;

function getPool(): CognitoUserPool {
  if (!isAuthConfigured) {
    throw new AuthError(
      "Sign-in is not configured. Set VITE_COGNITO_USER_POOL_ID and VITE_COGNITO_CLIENT_ID.",
    );
  }
  if (!pool) {
    pool = new CognitoUserPool({ UserPoolId: USER_POOL_ID, ClientId: CLIENT_ID });
  }
  return pool;
}

export class AuthError extends Error {}

// ---------------------------------------------------------------------------
// Sign in / out
// ---------------------------------------------------------------------------

export function signIn(email: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let user: CognitoUser;
    try {
      user = new CognitoUser({ Username: email, Pool: getPool() });
    } catch (err) {
      reject(err);
      return;
    }
    const details = new AuthenticationDetails({ Username: email, Password: password });

    user.authenticateUser(details, {
      onSuccess: () => {
        // A previous demo session would otherwise shadow the real one, since getIdToken checks
        // the demo token first.
        clearDemoSession();
        resolve();
      },
      onFailure: (err: Error) =>
        reject(new AuthError(err.message || "Sign-in failed. Check your email and password.")),
      newPasswordRequired: () =>
        reject(
          new AuthError(
            "This account still has a temporary password. Ask an administrator to set a permanent one.",
          ),
        ),
    });
  });
}

export function signOut(): void {
  clearDemoSession();
  if (!isAuthConfigured) return;
  getPool().getCurrentUser()?.signOut();
}

// ---------------------------------------------------------------------------
// Demo session
// ---------------------------------------------------------------------------

interface DemoMeta {
  email: string;
  organization_id: string;
  role: Role;
  expires_at: number;
}

/** Store a demo token obtained from the backend. */
export function storeDemoSession(token: string, meta: Omit<DemoMeta, "expires_at">, expiresIn: number): void {
  try {
    sessionStorage.setItem(DEMO_TOKEN_KEY, token);
    sessionStorage.setItem(
      DEMO_META_KEY,
      JSON.stringify({ ...meta, expires_at: Date.now() + expiresIn * 1000 }),
    );
  } catch {
    // Storage can be unavailable in private modes. The session is then in-memory only for this
    // page view, which still lets the visitor look around.
  }
}

export function clearDemoSession(): void {
  try {
    sessionStorage.removeItem(DEMO_TOKEN_KEY);
    sessionStorage.removeItem(DEMO_META_KEY);
  } catch {
    /* nothing to clear */
  }
}

function readDemoMeta(): DemoMeta | null {
  try {
    const raw = sessionStorage.getItem(DEMO_META_KEY);
    if (!raw) return null;
    const meta = JSON.parse(raw) as DemoMeta;
    // Expired tokens are dropped rather than sent: the API would reject them and the user would
    // see an authorization error instead of being asked to sign in again.
    if (meta.expires_at && meta.expires_at < Date.now()) {
      clearDemoSession();
      return null;
    }
    return meta;
  } catch {
    return null;
  }
}

function readDemoToken(): string | null {
  if (!readDemoMeta()) return null;
  try {
    return sessionStorage.getItem(DEMO_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function isDemoSession(): boolean {
  return readDemoToken() !== null;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * Return a valid ID token, refreshing it if needed, or null when not signed in.
 *
 * Checks the demo token first because a demo session has no Cognito SDK state to consult.
 */
export function getIdToken(): Promise<string | null> {
  const demoToken = readDemoToken();
  if (demoToken) return Promise.resolve(demoToken);

  return new Promise((resolve) => {
    if (!isAuthConfigured) {
      resolve(null);
      return;
    }
    const user = getPool().getCurrentUser();
    if (!user) {
      resolve(null);
      return;
    }
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session || !session.isValid()) {
        resolve(null);
        return;
      }
      resolve(session.getIdToken().getJwtToken());
    });
  });
}

export async function isSignedIn(): Promise<boolean> {
  return (await getIdToken()) !== null;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * Decode a JWT payload without verifying it.
 *
 * Verification is the API's job, and it does verify — the user-pool authorizer rejects anything
 * unsigned or expired. Reading the claim here only decides what to render, so a tampered token
 * buys nothing: the request behind the button still fails.
 *
 * Returns an empty object on anything malformed, so a corrupt token degrades to the least
 * privileged interpretation rather than throwing during render.
 */
function decodeClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    const normalised = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(normalised)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseGroups(claims: Record<string, unknown>): string[] {
  const groups = claims["cognito:groups"];
  if (Array.isArray(groups)) return groups.map(String);
  // API Gateway sometimes flattens the claim to a comma-separated or bracketed string.
  if (typeof groups === "string" && groups) {
    return groups
      .replace(/[[\]]/g, "")
      .split(/[,\s]+/)
      .map((g) => g.trim())
      .filter(Boolean);
  }
  return [];
}

async function getClaims(): Promise<Record<string, unknown>> {
  const token = await getIdToken();
  return token ? decodeClaims(token) : {};
}

/** Organizations the signed-in user may access. */
export async function getMemberOrganizations(): Promise<string[]> {
  const demoMeta = readDemoMeta();
  if (demoMeta) return [demoMeta.organization_id];
  return parseGroups(await getClaims()).filter((g) => g.startsWith("ORG-"));
}

/**
 * The caller's role.
 *
 * Defaults to `TEAM_MEMBER`, matching the backend's `derive_role`. An unreadable or unexpected
 * claim yields the least privileged role, so a misconfigured account is under-privileged rather
 * than over-privileged — and the API applies the same rule independently.
 */
export async function getRole(): Promise<Role> {
  const demoMeta = readDemoMeta();
  if (demoMeta) return demoMeta.role;
  return parseGroups(await getClaims()).includes("LEADER") ? "LEADER" : "TEAM_MEMBER";
}

export async function getSignedInUser(): Promise<{
  email: string;
  name: string;
  role: Role;
  organizations: string[];
  isDemo: boolean;
} | null> {
  const token = await getIdToken();
  if (!token) return null;

  const demoMeta = readDemoMeta();
  if (demoMeta) {
    return {
      email: demoMeta.email,
      name: "Demo Volunteer",
      role: demoMeta.role,
      organizations: [demoMeta.organization_id],
      isDemo: true,
    };
  }

  const claims = decodeClaims(token);
  const groups = parseGroups(claims);
  return {
    email: String(claims.email || ""),
    name: String(claims.name || claims.email || ""),
    role: groups.includes("LEADER") ? "LEADER" : "TEAM_MEMBER",
    organizations: groups.filter((g) => g.startsWith("ORG-")),
    isDemo: false,
  };
}

/** Synchronous best-effort email, for a header that must render immediately. */
export function getSignedInEmail(): string | null {
  const demoMeta = readDemoMeta();
  if (demoMeta) return demoMeta.email;
  if (!isAuthConfigured) return null;
  return getPool().getCurrentUser()?.getUsername() ?? null;
}
