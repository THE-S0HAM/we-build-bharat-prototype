/**
 * Checks on the federated-provider allowlist (requirements 1.10, 1.11).
 *
 * Pure input to pure output: `resolveAuthProviders` takes configuration as an
 * argument, so every case below is exercised without an environment, a DOM or a
 * Cognito pool. The configuration warnings are developer output, so the tests
 * that provoke one silence it rather than letting it print.
 */

import { describe, expect, it, vi } from "vitest";

import {
  hostedUiAuthorizeUrl,
  parseProviderAllowlist,
  resolveAuthProviders,
} from "./authProviders";
import type { AuthProviderButton, HostedUiConfig, ResolvedHostedUi } from "./authProviders";

/** A hosted UI that is fully configured, which no deployment is today (A1). */
const HOSTED_UI: ResolvedHostedUi = {
  domain: "communityops.auth.ap-south-1.amazoncognito.com",
  clientId: "1example23client45id",
  redirectUri: "https://console.communityops.dev/login",
};

function configured(providers: string | undefined): HostedUiConfig {
  return {
    providers,
    domain: HOSTED_UI.domain,
    clientId: HOSTED_UI.clientId,
    redirectUri: HOSTED_UI.redirectUri,
  };
}

/** Developer warnings are expected in the degraded cases; keep them quiet. */
function silenceWarnings() {
  return vi.spyOn(console, "warn").mockImplementation(() => undefined);
}

/** Narrows a single-provider result without a non-null assertion. */
function onlyProvider(providers: readonly AuthProviderButton[]): AuthProviderButton {
  const [provider, ...rest] = providers;

  if (provider === undefined || rest.length > 0) {
    throw new Error(`Expected exactly one provider, received ${providers.length}`);
  }

  return provider;
}

describe("parseProviderAllowlist", () => {
  it("reads nothing out of an absent, empty or separator-only value", () => {
    expect(parseProviderAllowlist(undefined)).toEqual([]);
    expect(parseProviderAllowlist("")).toEqual([]);
    expect(parseProviderAllowlist("   ")).toEqual([]);
    expect(parseProviderAllowlist(",,")).toEqual([]);
  });

  it("reads keys in order, case-insensitively, and collapses repeats", () => {
    expect(parseProviderAllowlist("Google, apple , GOOGLE")).toEqual(["google", "apple"]);
  });
});

describe("resolveAuthProviders", () => {
  it("returns no providers when the allowlist is absent or empty (requirement 1.11)", () => {
    expect(resolveAuthProviders(configured(undefined))).toEqual([]);
    expect(resolveAuthProviders(configured(""))).toEqual([]);
  });

  it("returns no providers when the hosted UI is not configured (design.md A1)", () => {
    const warn = silenceWarnings();

    // The state of the product today: a provider could be named, but there is no
    // hosted UI domain to redirect to, so nothing is offered.
    expect(
      resolveAuthProviders({
        providers: "google",
        clientId: HOSTED_UI.clientId,
        redirectUri: HOSTED_UI.redirectUri,
      }),
    ).toEqual([]);

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns one button per named provider, each with a real destination", () => {
    const providers = resolveAuthProviders(configured("google,apple"));

    expect(providers.map((provider) => provider.key)).toEqual(["google", "apple"]);
    expect(providers.map((provider) => provider.label)).toEqual([
      "Continue with Google",
      "Continue with Apple",
    ]);

    for (const provider of providers) {
      expect(provider.authorizeUrl).toMatch(/^https:\/\//);
    }
  });

  it("drops a named provider it has no button for", () => {
    const warn = silenceWarnings();

    const providers = resolveAuthProviders(configured("google,orkut"));

    expect(providers.map((provider) => provider.key)).toEqual(["google"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("hostedUiAuthorizeUrl", () => {
  it("requests an authorization code for the named provider over https", () => {
    const url = new URL(onlyProvider(resolveAuthProviders(configured("google"))).authorizeUrl);

    expect(url.protocol).toBe("https:");
    expect(url.host).toBe(HOSTED_UI.domain);
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(HOSTED_UI.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(HOSTED_UI.redirectUri);
    expect(url.searchParams.get("identity_provider")).toBe("Google");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });

  it("accepts a domain written as a URL and still addresses the host", () => {
    const url = new URL(
      hostedUiAuthorizeUrl(
        { key: "google", label: "Continue with Google", identityProvider: "Google" },
        { ...HOSTED_UI, domain: `https://${HOSTED_UI.domain}/` },
      ),
    );

    expect(url.origin).toBe(`https://${HOSTED_UI.domain}`);
    expect(url.pathname).toBe("/oauth2/authorize");
  });

  it("carries no secret of any kind", () => {
    const { authorizeUrl } = onlyProvider(resolveAuthProviders(configured("google")));

    expect(authorizeUrl).not.toMatch(/client_secret|secret|password/i);
  });
});
