/**
 * Cognito authentication for the CommunityOps console.
 *
 * The deployed API Gateway uses a Cognito user-pool authorizer, so every
 * request needs a valid ID token. Organization membership is carried in the
 * token's `cognito:groups` claim and enforced server-side, which is why the
 * console cannot simply assert an organization client-side.
 *
 * SRP is used for sign-in, so the password is never sent to Cognito in clear
 * text. Tokens are held by the Cognito SDK (localStorage) and refreshed
 * automatically via the refresh token.
 */

import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";

const USER_POOL_ID = import.meta.env.VITE_COGNITO_USER_POOL_ID || "";
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID || "";

export const isAuthConfigured = Boolean(USER_POOL_ID && CLIENT_ID);

let pool: CognitoUserPool | null = null;

function getPool(): CognitoUserPool {
  if (!isAuthConfigured) {
    throw new Error(
      "Authentication is not configured. Set VITE_COGNITO_USER_POOL_ID and VITE_COGNITO_CLIENT_ID.",
    );
  }
  if (!pool) {
    pool = new CognitoUserPool({ UserPoolId: USER_POOL_ID, ClientId: CLIENT_ID });
  }
  return pool;
}

export class AuthError extends Error {}

export function signIn(email: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: email, Pool: getPool() });
    const details = new AuthenticationDetails({ Username: email, Password: password });

    user.authenticateUser(details, {
      onSuccess: () => resolve(),
      onFailure: (err: Error) => reject(new AuthError(err.message || "Sign-in failed")),
      newPasswordRequired: () =>
        reject(
          new AuthError(
            "This account requires a permanent password. Ask an administrator to set one.",
          ),
        ),
    });
  });
}

/**
 * Return a valid ID token, refreshing it if needed, or null when not signed in.
 */
export function getIdToken(): Promise<string | null> {
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

/** Organizations the signed-in user may access, from the `cognito:groups` claim. */
export async function getMemberOrganizations(): Promise<string[]> {
  const token = await getIdToken();
  if (!token) return [];
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
    const groups = payload["cognito:groups"];
    if (Array.isArray(groups)) return groups.map(String);
    if (typeof groups === "string" && groups) return groups.split(",").map((g) => g.trim());
    return [];
  } catch {
    return [];
  }
}

export function signOut(): void {
  if (!isAuthConfigured) return;
  getPool().getCurrentUser()?.signOut();
}

export function getSignedInEmail(): string | null {
  if (!isAuthConfigured) return null;
  return getPool().getCurrentUser()?.getUsername() ?? null;
}
