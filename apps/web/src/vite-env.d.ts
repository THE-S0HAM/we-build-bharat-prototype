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

  /**
   * The user pool's hosted UI domain, needed to start a federated
   * authorization-code redirect. Unset today: no `UserPoolDomain` exists
   * (design.md A1), so no provider button renders.
   */
  readonly VITE_COGNITO_DOMAIN?: string;

  /**
   * Allowlist of federated providers the sign-in screen may offer, comma- or
   * space-separated (requirements 1.10, 1.11). Empty or absent — the case today
   * — means the provider block and its divider are absent from the DOM; see
   * `src/lib/authProviders.ts`.
   */
  readonly VITE_AUTH_PROVIDERS?: string;

  /**
   * The demo identity's Cognito username (requirements 2.1, 2.10). Needed
   * together with `VITE_DEMO_PASSWORD`: with either absent, the "Try Demo
   * Account" action is absent from the DOM; see `src/lib/demoAccess.ts`.
   *
   * Unset today: no `ORG-demo` group, no demo identity and no seeded demo
   * organization exist (design.md A18).
   */
  readonly VITE_DEMO_USERNAME?: string;

  /**
   * The demo identity's permanent password (requirements 2.1, 2.10).
   *
   * Anything in the bundle is public, so this value is only ever a credential for
   * an identity whose entire reachable dataset is synthetic (design.md A18). The
   * repository carries commented placeholders in `.env.example` and never a real
   * value — CI scans the repository for secrets.
   */
  readonly VITE_DEMO_PASSWORD?: string;
}
