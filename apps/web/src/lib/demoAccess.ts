/**
 * Demo access configuration for the sign-in screen (requirements 2.1, 2.2, 2.10;
 * design.md A18).
 *
 * ## Why this module exists
 *
 * "Try Demo Account" must put a visitor in a populated workspace without handing
 * them a real operator's credentials. The answer design.md A18 settles on is a
 * *real* Cognito SRP sign-in as a preconfigured demo identity scoped to a
 * dedicated demo organization — no second auth path, no client-side session
 * forgery, no bypass of API Gateway or `tenancy.py`. So the only thing the
 * frontend needs is the pair of credentials, and the only decision this module
 * makes is whether that pair is present.
 *
 * It is the same shape as `src/lib/authProviders.ts` and for the same reason: a
 * pure resolver over configuration, a dev-only `console.warn` for a
 * half-configured build, and nothing on screen. An action that cannot work is
 * **absent from the DOM**, not disabled and not decorative (requirement 2.2).
 *
 * ## The credential is public, and that is the whole risk
 *
 * Anything delivered to a browser bundle is readable by anyone, so this module
 * hands out a credential that anyone can read. design.md A18 accepts that
 * *only* because the identity belongs to one Cognito group whose entire
 * reachable dataset is synthetic: the demo organization must hold no real
 * personal data, the password must be used nowhere else, and the backend still
 * authorizes every request against the token's own groups.
 *
 * Two rules follow, and both are load-bearing:
 *
 *   - **No credential is ever committed.** `.env.example` carries commented
 *     placeholders only; CI runs a secret scan over the repository.
 *   - **No credential is ever rendered, logged or persisted by this console.**
 *     The password is read from configuration, passed to the SRP call, and never
 *     placed in the DOM, in a URL, in `localStorage` or in a console message —
 *     including the warning below, which names the missing variable and nothing
 *     else.
 *
 * ## What this module does not decide
 *
 * It grants nothing. A demo session is authorized by exactly the same rule as
 * any other: `services/shared/tenancy.py` derives access from `cognito:groups`
 * and fails closed. There is no demo role, no demo flag on a request and no
 * client-side privilege anywhere in this file (requirement 2.7).
 */

/** Prefix for the console channel. Matches `authProviders`' own reporting. */
const LOG_TAG = "[demoAccess]";

/** Raw configuration, exactly as honest as an environment variable is. */
export interface DemoAccessConfig {
  /** `VITE_DEMO_USERNAME` — the demo identity's Cognito username. */
  readonly username?: string;
  /** `VITE_DEMO_PASSWORD` — its permanent password. */
  readonly password?: string;
}

/**
 * A demo identity that can actually be signed in as, because both halves of the
 * credential are present. Only `resolveDemoAccess` produces one, so a renderable
 * "Try Demo Account" action cannot exist without something real to authenticate
 * with — the same structural guarantee `AuthProviderButton` gives the provider
 * buttons.
 */
export interface DemoCredentials {
  readonly username: string;
  readonly password: string;
}

/**
 * Configuration problems go to the browser console for whoever is deploying
 * this console, and never to the screen (requirement 13.7): a visitor cannot act
 * on a missing environment variable, and the sign-in form is complete without a
 * demo action.
 */
function reportConfigurationGap(detail: string): void {
  if (import.meta.env.DEV) {
    console.warn(`${LOG_TAG} ${detail}`);
  }
}

/**
 * The demo credential for a configuration, or `null` when there is not one.
 *
 * Both values are required (requirement 2.1). A build with one of them is
 * reported as a gap rather than half-honoured: a username without a password
 * cannot authenticate, so rendering the action would draw a button that fails
 * every time it is pressed.
 *
 * Whitespace-only counts as absent, because an unset variable in a CI template
 * very often arrives as `""` or `" "`. The username is trimmed — surrounding
 * whitespace is never part of an address — and the password never is, since
 * trailing whitespace can be part of it.
 */
export function resolveDemoAccess(config: DemoAccessConfig): DemoCredentials | null {
  const username = (config.username ?? "").trim();
  const password = config.password ?? "";

  if (username === "" || password.trim() === "") {
    if (username !== "" || password.trim() !== "") {
      reportConfigurationGap(
        "Demo access needs both VITE_DEMO_USERNAME and VITE_DEMO_PASSWORD. " +
          "Only one is set, so no 'Try Demo Account' action is rendered: an action that " +
          "cannot authenticate is worse than no action (requirement 2.2, design.md A18).",
      );
    }

    return null;
  }

  return { username, password };
}

/**
 * The demo credential for this build's configuration.
 *
 * Read at call time rather than at module load, so the answer reflects the
 * configuration the screen is actually rendering under — and so a test can stub
 * the environment without re-importing the module.
 *
 * `null` today, and expected to stay `null` until the A18 infrastructure exists:
 * there is no `ORG-demo` Cognito group, no demo identity and no seeded demo
 * organization, so there is nothing for these variables to name.
 */
export function configuredDemoAccess(): DemoCredentials | null {
  return resolveDemoAccess({
    username: import.meta.env.VITE_DEMO_USERNAME,
    password: import.meta.env.VITE_DEMO_PASSWORD,
  });
}

/**
 * Whether the signed-in identity is the configured demo identity
 * (requirement 2.8).
 *
 * This is the honest form of "is this a demo session": a comparison between who
 * is signed in and who the build configured as the demo user. It invents no
 * client-side privilege, adds no claim to the token and reads nothing the token
 * does not already say.
 *
 * Two properties make it the right check rather than an in-memory "the demo
 * button was pressed" flag:
 *
 *   - it survives a reload, so the chip does not vanish on refresh while the
 *     same demo session is still active;
 *   - it clears itself on sign-out and on signing in as someone else, so a real
 *     operator is never labelled a demo workspace.
 *
 * Case-insensitive, because Cognito usernames are matched case-insensitively
 * when the pool is configured with email as the sign-in alias. `null` — no
 * session, or no configured demo identity — is never a demo session.
 */
export function isDemoIdentity(
  username: string | null,
  credentials: DemoCredentials | null = configuredDemoAccess(),
): boolean {
  if (credentials === null || username === null) {
    return false;
  }

  return username.trim().toLowerCase() === credentials.username.toLowerCase();
}
