/**
 * Federated sign-in providers for the sign-in screen (requirements 1.10, 1.11).
 *
 * ## Why this module exists
 *
 * The product brief asks for "Continue with Google / Amazon / Apple" on the
 * sign-in screen. `template.yaml` declares `SupportedIdentityProviders:
 * [COGNITO]`, no `UserPoolDomain`, no OAuth flows, scopes or callback URLs, and
 * no `AWS::Cognito::UserPoolIdentityProvider` — federated sign-in cannot work
 * today (design.md A1). The answer is not to draw the buttons anyway: a provider
 * button exists only when the configuration needed to *start* its redirect is
 * present, and otherwise the provider block and its divider are absent from the
 * DOM entirely (requirement 1.11). Nothing is rendered disabled, and nothing is
 * rendered decoratively.
 *
 * ## The structural guarantee
 *
 * `resolveAuthProviders` returns buttons that already carry their authorization
 * URL, so a renderable provider cannot exist without a real place to send the
 * visitor. "Never render a button that looks like it works but does not" is
 * therefore a property of the type rather than a rule a future edit has to
 * remember.
 *
 * ## What is deliberately not here
 *
 * The return leg of the authorization-code flow — the callback route, the
 * `state` check, the PKCE verifier and the code-for-tokens exchange — is not
 * implemented. It cannot be written against a hosted UI that does not exist and
 * cannot be verified without one, so it lands with the A1 infrastructure and the
 * callback route in `src/routes.ts`. Until then `VITE_COGNITO_DOMAIN` is unset,
 * no provider resolves, and no visitor can reach this path.
 *
 * No provider secret is involved on this side. The authorization request carries
 * the public client id only; provider client secrets live in Secrets Manager and
 * are referenced by the template (design.md A1), never by the bundle.
 */

import { LOGIN_ROUTE } from "../session/intendedRoute";

/** A federated provider the console knows how to name and address. */
export interface AuthProvider {
  /** Allowlist key, lower-case, as written in `VITE_AUTH_PROVIDERS`. */
  readonly key: string;
  /** Button copy. */
  readonly label: string;
  /** The `identity_provider` value Cognito's authorize endpoint expects. */
  readonly identityProvider: string;
}

/**
 * A provider that is ready to render, because it has somewhere real to go.
 * Only `resolveAuthProviders` produces these.
 */
export interface AuthProviderButton extends AuthProvider {
  readonly authorizeUrl: string;
}

/**
 * The providers the console can render. A button needs a human name, so an
 * entry here is what makes a provider nameable — adding one is a line in this
 * table plus the matching `AWS::Cognito::UserPoolIdentityProvider` and secret
 * in the template. An allowlist entry with no table row is ignored rather than
 * rendered as its raw configuration value.
 */
const SUPPORTED_PROVIDERS: readonly AuthProvider[] = [
  { key: "google", label: "Continue with Google", identityProvider: "Google" },
  { key: "amazon", label: "Continue with Amazon", identityProvider: "LoginWithAmazon" },
  { key: "apple", label: "Continue with Apple", identityProvider: "SignInWithApple" },
];

/**
 * The claims the console needs from a federated identity: `openid` for the ID
 * token, `email` and `profile` for the `email` and `name` claims the shell
 * renders. Organization membership arrives in `cognito:groups`, which the user
 * pool adds on its own.
 */
const HOSTED_UI_SCOPES = ["openid", "email", "profile"] as const;

/** Raw configuration, exactly as honest as an environment variable is. */
export interface HostedUiConfig {
  /** `VITE_AUTH_PROVIDERS` — comma- or space-separated allowlist. */
  readonly providers?: string;
  /** `VITE_COGNITO_DOMAIN` — the user pool's hosted UI domain. */
  readonly domain?: string;
  /** `VITE_COGNITO_CLIENT_ID` — the public SPA client. */
  readonly clientId?: string;
  /** Absolute callback URL, which must match a registered callback URL. */
  readonly redirectUri?: string;
}

/** The same configuration once every value needed for a redirect is present. */
export interface ResolvedHostedUi {
  readonly domain: string;
  readonly clientId: string;
  readonly redirectUri: string;
}

/**
 * Configuration problems go to the browser console for the developer and never
 * to the screen (requirement 13.7): a visitor cannot act on a missing
 * environment variable, and the sign-in form is complete without providers.
 */
function reportConfigurationGap(detail: string): void {
  if (import.meta.env.DEV) {
    console.warn(`[authProviders] ${detail}`);
  }
}

/**
 * Read the allowlist as the list of provider keys it names.
 *
 * Separators are commas and whitespace, keys are lower-cased, blanks are
 * dropped and repeats collapse — so `"Google, google"`, `"google,,"` and
 * `" google "` all name exactly one provider, and `""` names none.
 */
export function parseProviderAllowlist(raw: string | undefined): string[] {
  const keys = (raw ?? "")
    .split(/[,\s]+/)
    .map((key) => key.trim().toLowerCase())
    .filter((key) => key !== "");

  return [...new Set(keys)];
}

/** Accepts a bare domain or one written as a URL; yields the bare host. */
function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function resolveHostedUi(config: HostedUiConfig): ResolvedHostedUi | null {
  const domain = normalizeDomain(config.domain ?? "");
  const clientId = (config.clientId ?? "").trim();
  const redirectUri = (config.redirectUri ?? "").trim();

  if (domain === "" || clientId === "" || redirectUri === "") {
    return null;
  }

  return { domain, clientId, redirectUri };
}

/**
 * The Cognito hosted-UI authorization request for one provider
 * (requirement 1.10).
 *
 * `response_type=code` is the authorization-code flow: the browser never
 * receives a token in a URL fragment. The request is always https, carries the
 * public client id only, and names the provider so the hosted UI goes straight
 * to it instead of showing its own account picker.
 */
export function hostedUiAuthorizeUrl(
  provider: AuthProvider,
  hostedUi: ResolvedHostedUi,
): string {
  // Normalized here as well as in `resolveHostedUi`, because the value comes
  // from configuration and a domain is as likely to be written
  // `https://…auth.region.amazoncognito.com/` as bare. Idempotent either way.
  const url = new URL(`https://${normalizeDomain(hostedUi.domain)}/oauth2/authorize`);

  url.search = new URLSearchParams({
    client_id: hostedUi.clientId,
    response_type: "code",
    scope: HOSTED_UI_SCOPES.join(" "),
    redirect_uri: hostedUi.redirectUri,
    identity_provider: provider.identityProvider,
  }).toString();

  return url.toString();
}

/**
 * The provider buttons the sign-in screen may render, in the order the
 * allowlist names them.
 *
 * Empty is the normal answer and the answer today (design.md A1). It is
 * returned when the allowlist is empty or absent (requirement 1.11), when the
 * hosted UI needed to honour it is not configured, and for any named provider
 * this console cannot address. In every one of those cases the caller renders no
 * provider block and no divider.
 */
export function resolveAuthProviders(config: HostedUiConfig): AuthProviderButton[] {
  const requested = parseProviderAllowlist(config.providers);

  if (requested.length === 0) {
    return [];
  }

  const hostedUi = resolveHostedUi(config);

  if (hostedUi === null) {
    reportConfigurationGap(
      "VITE_AUTH_PROVIDERS names a provider, but the hosted UI is not configured " +
        "(VITE_COGNITO_DOMAIN, VITE_COGNITO_CLIENT_ID). No provider button is rendered: " +
        "a button with nowhere to go is worse than no button.",
    );
    return [];
  }

  const buttons: AuthProviderButton[] = [];

  for (const key of requested) {
    const provider = SUPPORTED_PROVIDERS.find((candidate) => candidate.key === key);

    if (provider === undefined) {
      reportConfigurationGap(
        `VITE_AUTH_PROVIDERS names "${key}", which this console has no button for. ` +
          `Supported: ${SUPPORTED_PROVIDERS.map((entry) => entry.key).join(", ")}.`,
      );
      continue;
    }

    buttons.push({ ...provider, authorizeUrl: hostedUiAuthorizeUrl(provider, hostedUi) });
  }

  return buttons;
}

/**
 * Where Cognito sends the visitor back to. The sign-in route is the callback,
 * so the address is stable and can be registered as a callback URL as-is.
 */
function loginCallbackUrl(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  return new URL(LOGIN_ROUTE, window.location.origin).toString();
}

/**
 * The provider buttons for this build's configuration.
 *
 * Read at call time rather than at module load, so the answer reflects the
 * configuration the screen is actually rendering under.
 */
export function configuredAuthProviders(): AuthProviderButton[] {
  return resolveAuthProviders({
    providers: import.meta.env.VITE_AUTH_PROVIDERS,
    domain: import.meta.env.VITE_COGNITO_DOMAIN,
    clientId: import.meta.env.VITE_COGNITO_CLIENT_ID,
    redirectUri: loginCallbackUrl(),
  });
}
