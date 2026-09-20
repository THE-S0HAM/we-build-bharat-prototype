/**
 * Federated sign-in is intentionally disabled until the complete OAuth
 * authorization-code flow with PKCE, state validation, callback handling, and
 * configured Cognito identity providers ships as one reviewed capability.
 *
 * Stray Vite variables must never make a working-looking provider control
 * appear. This helper therefore always resolves an empty list.
 */

export interface AuthProviderButton {
  readonly key: string;
  readonly label: string;
  readonly authorizeUrl: string;
}

export interface HostedUiConfig {
  readonly providers?: string;
  readonly domain?: string;
  readonly clientId?: string;
  readonly redirectUri?: string;
}

/** Future-disabled seam retained for the login screen and focused tests. */
export function resolveAuthProviders(_config: HostedUiConfig): AuthProviderButton[] {
  return [];
}

/** This build cannot complete federated sign-in, regardless of environment. */
export function configuredAuthProviders(): AuthProviderButton[] {
  return [];
}
