import { describe, expect, it } from "vitest";

import { configuredAuthProviders, resolveAuthProviders } from "./authProviders";

describe("federated sign-in remains disabled", () => {
  it("resolves no provider even when every stray hosted-UI variable is present", () => {
    expect(
      resolveAuthProviders({
        providers: "google,apple",
        domain: "communityops.auth.ap-south-1.amazoncognito.com",
        clientId: "public-client",
        redirectUri: "https://console.example.test/login",
      }),
    ).toEqual([]);
  });

  it("never resolves providers from this build's environment", () => {
    expect(configuredAuthProviders()).toEqual([]);
  });
});
