/// <reference types="vite/client" />

/**
 * Configuration values the console reads from the bundle (requirement 16.1).
 *
 * Declared so `import.meta.env` access is typed rather than `any`. Vite's own
 * `ImportMetaEnv` keeps its string index signature, so the values not yet listed
 * here still resolve; every entry added below becomes `string | undefined`,
 * which is what an environment variable honestly is — absent is a valid state.
 */
interface ImportMetaEnv {
  /**
   * Capability flag for AttendeeOps. `"true"` and nothing else turns it on; see
   * `src/capabilities.ts` (design.md A6, requirement 11.1).
   */
  readonly VITE_CAPABILITY_ATTENDEE_OPS?: string;

  /** Cognito user pool, read by `src/auth.ts` for the SRP sign-in path. */
  readonly VITE_COGNITO_USER_POOL_ID?: string;

  /**
   * Public SPA client of that user pool. No client secret exists, which is what
   * makes it safe in a bundle (requirement 16.1).
   */
  readonly VITE_COGNITO_CLIENT_ID?: string;

  /** Backend API origin. Empty means live requests are unavailable. */
  readonly VITE_API_URL?: string;

  /** Fallback tenant used only when a token names no organization. */
  readonly VITE_ORG_ID?: string;

  /** Explicit local fixture mode. This is the only session bypass. */
  readonly VITE_USE_MOCK?: string;

  /**
   * Reserved for a future complete federated OAuth implementation. Provider
   * variables never render controls in this build.
   */
  readonly VITE_COGNITO_DOMAIN?: string;

  /**
   * Allowlist of federated providers the sign-in screen may offer, comma- or
   * space-separated (requirements 1.10, 1.11). Empty or absent — the case today
   * — means the provider block and its divider are absent from the DOM; see
   * `src/lib/authProviders.ts`.
   */
  readonly VITE_AUTH_PROVIDERS?: string;

}
