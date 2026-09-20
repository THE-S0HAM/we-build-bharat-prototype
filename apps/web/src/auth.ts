/** Cognito SRP authentication plus restricted backend-issued demo sessions. */
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";
import { decodeTokenClaims, readMemberOrganizations } from "./lib/tokenClaims";
import type { DemoSession, Role, SignedInUser } from "./types";

const USER_POOL_ID = import.meta.env.VITE_COGNITO_USER_POOL_ID || "";
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID || "";
const DEMO_TOKEN_KEY = "communityops.demo.token";
const DEMO_META_KEY = "communityops.demo.meta";
export const isAuthConfigured = Boolean(USER_POOL_ID && CLIENT_ID);

interface DemoMeta {
  email: string;
  organization_id: string;
  role: "TEAM_MEMBER";
  expires_at: number;
}

let memoryDemo: { token: string; meta: DemoMeta } | null = null;
let pool: CognitoUserPool | null = null;

export class AuthError extends Error {}

function getPool(): CognitoUserPool {
  if (!isAuthConfigured) throw new AuthError("Authentication is not configured.");
  pool ??= new CognitoUserPool({ UserPoolId: USER_POOL_ID, ClientId: CLIENT_ID });
  return pool;
}

export function signIn(email: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let user: CognitoUser;
    try {
      user = new CognitoUser({ Username: email, Pool: getPool() });
    } catch (error) {
      reject(error);
      return;
    }
    user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
      onSuccess: () => {
        clearDemoSession();
        resolve();
      },
      onFailure: (error: Error) => reject(new AuthError(error.message || "Sign-in failed")),
      newPasswordRequired: () =>
        reject(new AuthError("This account requires a permanent password.")),
    });
  });
}

function groupsFrom(token: string | null): string[] {
  const claims = decodeTokenClaims(token);
  const raw = claims?.["cognito:groups"];
  const groups = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? raw.replace(/^\[|\]$/g, "").split(/[,\s]+/)
      : [];
  return [...new Set(groups.map((group) => group.trim()).filter(Boolean))];
}

function validDemoMeta(value: unknown): value is DemoMeta {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DemoMeta>;
  return (
    typeof candidate.email === "string" &&
    candidate.email !== "" &&
    typeof candidate.organization_id === "string" &&
    candidate.organization_id.startsWith("ORG-") &&
    candidate.role === "TEAM_MEMBER" &&
    typeof candidate.expires_at === "number" &&
    Number.isFinite(candidate.expires_at)
  );
}

function validateDemoSession(session: DemoSession): DemoMeta {
  if (
    session.is_demo !== true ||
    session.role !== "TEAM_MEMBER" ||
    typeof session.id_token !== "string" ||
    session.id_token.trim() === "" ||
    typeof session.email !== "string" ||
    session.email.trim() === "" ||
    typeof session.organization_id !== "string" ||
    !session.organization_id.startsWith("ORG-") ||
    !Number.isFinite(session.expires_in) ||
    session.expires_in <= 0
  ) {
    throw new AuthError("The demo session response is invalid.");
  }

  const claims = decodeTokenClaims(session.id_token);
  const groups = groupsFrom(session.id_token);
  const claimedOrganizations = groups.filter((group) => group.startsWith("ORG-"));
  if (claims !== null && !claimedOrganizations.includes(session.organization_id)) {
    throw new AuthError("The demo session organization does not match its token.");
  }
  if (claims !== null && !groups.includes("TEAM_MEMBER")) {
    throw new AuthError("The demo session role does not match its token.");
  }
  if (groups.includes("LEADER")) {
    throw new AuthError("A demo session cannot have leader authority.");
  }
  if (typeof claims?.email === "string" && claims.email !== session.email) {
    throw new AuthError("The demo session email does not match its token.");
  }
  if (claims?.is_demo !== undefined && claims.is_demo !== true) {
    throw new AuthError("The demo session marker does not match its token.");
  }

  const responseExpiry = Date.now() + session.expires_in * 1000;
  const tokenExpiry =
    typeof claims?.exp === "number" && Number.isFinite(claims.exp)
      ? claims.exp * 1000
      : responseExpiry;
  const expiresAt = Math.min(responseExpiry, tokenExpiry);
  if (expiresAt <= Date.now()) {
    throw new AuthError("The demo session is expired.");
  }

  return {
    email: session.email,
    organization_id: session.organization_id,
    role: "TEAM_MEMBER",
    expires_at: expiresAt,
  };
}

export function storeDemoSession(session: DemoSession): void {
  const meta = validateDemoSession(session);
  memoryDemo = { token: session.id_token, meta };
  try {
    sessionStorage.setItem(DEMO_TOKEN_KEY, session.id_token);
    sessionStorage.setItem(DEMO_META_KEY, JSON.stringify(meta));
  } catch {
    // The in-memory session remains available for this page lifetime.
  }
}

export function clearDemoSession(): void {
  memoryDemo = null;
  try {
    sessionStorage.removeItem(DEMO_TOKEN_KEY);
    sessionStorage.removeItem(DEMO_META_KEY);
  } catch {
    // Storage is unavailable; memory has still been cleared.
  }
}

function readStoredDemo(): { token: string; meta: DemoMeta } | null {
  if (memoryDemo && memoryDemo.meta.expires_at > Date.now()) return memoryDemo;
  memoryDemo = null;
  try {
    const token = sessionStorage.getItem(DEMO_TOKEN_KEY);
    const rawMeta = sessionStorage.getItem(DEMO_META_KEY);
    if (!token || !rawMeta) return null;
    const parsed: unknown = JSON.parse(rawMeta);
    if (!validDemoMeta(parsed) || parsed.expires_at <= Date.now()) {
      clearDemoSession();
      return null;
    }
    const claims = decodeTokenClaims(token);
    const organizations = groupsFrom(token).filter((group) => group.startsWith("ORG-"));
    if (
      claims !== null &&
      (
        !organizations.includes(parsed.organization_id) ||
        !groupsFrom(token).includes("TEAM_MEMBER") ||
        groupsFrom(token).includes("LEADER") ||
        (typeof claims.email === "string" && claims.email !== parsed.email) ||
        (claims.is_demo !== undefined && claims.is_demo !== true)
      )
    ) {
      clearDemoSession();
      return null;
    }
    memoryDemo = { token, meta: parsed };
    return memoryDemo;
  } catch {
    clearDemoSession();
    return null;
  }
}

export function isDemoSession(): boolean {
  return readStoredDemo() !== null;
}

export function getIdToken(): Promise<string | null> {
  const demo = readStoredDemo();
  if (demo) return Promise.resolve(demo.token);
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
    user.getSession((error: Error | null, session: CognitoUserSession | null) => {
      resolve(error || !session?.isValid() ? null : session.getIdToken().getJwtToken());
    });
  });
}

export async function isSignedIn(): Promise<boolean> {
  return (await getIdToken()) !== null;
}

export async function getMemberOrganizations(): Promise<string[]> {
  const demo = readStoredDemo();
  if (demo) return [demo.meta.organization_id];
  return readMemberOrganizations(await getIdToken()).filter((group) => group.startsWith("ORG-"));
}

export async function getRole(): Promise<Role> {
  return groupsFrom(await getIdToken()).includes("LEADER") ? "LEADER" : "TEAM_MEMBER";
}

export async function getSignedInUser(): Promise<SignedInUser | null> {
  const demo = readStoredDemo();
  if (demo) {
    const claims = decodeTokenClaims(demo.token);
    return {
      userId: typeof claims?.sub === "string" ? claims.sub : demo.meta.email,
      email: demo.meta.email,
      name: "Demo Volunteer",
      role: "TEAM_MEMBER",
      organizations: [demo.meta.organization_id],
      isDemo: true,
    };
  }

  const token = await getIdToken();
  if (!token) return null;
  const claims = decodeTokenClaims(token);
  if (!claims) return null;
  const groups = groupsFrom(token);
  const email = typeof claims.email === "string" ? claims.email : "";
  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name : email;
  return {
    userId: typeof claims.sub === "string" ? claims.sub : "",
    email,
    name,
    role: groups.includes("LEADER") ? "LEADER" : "TEAM_MEMBER",
    organizations: groups.filter((group) => group.startsWith("ORG-")),
    isDemo: false,
  };
}

export function getSignedInEmail(): string | null {
  const demo = readStoredDemo();
  if (demo) return demo.meta.email;
  if (!isAuthConfigured) return null;
  return getPool().getCurrentUser()?.getUsername() ?? null;
}

export function signOut(): void {
  clearDemoSession();
  if (isAuthConfigured) getPool().getCurrentUser()?.signOut();
}
