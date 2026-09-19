/**
 * The console's frame and route table (design.md §5.5, §15.1).
 *
 * Four things happen here and nothing else: the session is provided, the event
 * context is provided behind it, routes are declared, and the shell is composed
 * from `AppShell`, `Sidebar` and `Topbar`. The session gate that used to be
 * inlined in this file now lives in `src/session/` behind `RequireSession`, so
 * "is there a session?" is answered in one place and asked by the router rather
 * than by this component.
 *
 * `const EVENT_ID = "EVT-devcon-2026"` used to live here too (design.md A16). It
 * is gone: the active event comes from `EventProvider`, which resolves it from
 * `GET /events`, and the route table hands it to the event-scoped pages.
 */

import type { ReactNode } from "react";
import { Outlet, Route, Routes } from "react-router-dom";
import { CAPABILITIES } from "./capabilities";
import { AppShell } from "./components/AppShell";
import { DemoWorkspaceChip } from "./components/DemoWorkspaceChip";
import { EventSwitcher } from "./components/EventSwitcher";
import { Sidebar } from "./components/Sidebar";
import { Skeleton, SkeletonRegion } from "./components/Skeleton";
import { Topbar } from "./components/Topbar";
import { useEventContext } from "./event/eventContext";
import { EventProvider } from "./event/EventProvider";
import { NoEventsState } from "./event/NoEventsState";
import { Login } from "./pages/Login";
import { NotFound } from "./pages/NotFound";
import { protectedRoutes } from "./routes";
import { LOGIN_ROUTE } from "./session/intendedRoute";
import { RedirectWhenAuthenticated, RequireSession } from "./session/routeGuards";
import { SessionProvider } from "./session/SessionProvider";
import { useSession } from "./session/sessionContext";

/** What a session restore announces. One sentence, no implementation detail. */
const RESTORING_SESSION = "Restoring session…";

interface ConsoleFrameProps {
  /**
   * The top bar's event switcher. Omitted while the session is unresolved, where
   * there is no event context above the frame yet and a switcher would have
   * nothing true to show.
   */
  eventSwitcher?: ReactNode;

  /** The "Demo workspace" chip, which renders itself only for a demo session. */
  demoWorkspaceChip?: ReactNode;

  /**
   * The organization has no event, so every event-scoped navigation entry is
   * disabled rather than removed (requirement 3.10).
   */
  eventScopedNavDisabled?: boolean;

  children: ReactNode;
}

/**
 * The shell, identical on every protected route (requirement 12.4).
 *
 * The same frame renders while the session is unresolved and after it resolves —
 * only the content region and the top bar's context group change — so nothing in
 * the navigation moves when the session lands.
 *
 * The `Sidebar` account block is deliberately absent: it displays the `name` and
 * `email` claims and the *active organization* (requirement 3.6), and the active
 * organization is derived from the token's groups by task 2.2. An account block
 * with a guessed organization would be invented identity, so there is none until
 * that lands.
 */
function ConsoleFrame({
  eventSwitcher,
  demoWorkspaceChip,
  eventScopedNavDisabled = false,
  children,
}: ConsoleFrameProps) {
  const { signOut } = useSession();

  return (
    <AppShell
      navigation={
        <Sidebar capabilities={CAPABILITIES} eventScopedDisabled={eventScopedNavDisabled} />
      }
      topbar={
        <Topbar
          eventSwitcher={eventSwitcher}
          demoWorkspaceChip={demoWorkspaceChip}
          onSignOut={signOut}
        />
      }
    >
      {children}
    </AppShell>
  );
}

/**
 * The frame for a route that has event context above it (requirements 3.10,
 * 3.11).
 *
 * This is the one place the event context reaches the frame, and it fills the
 * top bar's two context slots: the `EventSwitcher`, which is the sole writer of
 * event context from the UI, and the "Demo workspace" chip, which decides for
 * itself whether the session is a demo one.
 *
 * ## Zero events is a state of the console, not of a page
 *
 * When `GET /events` answers with nothing, two things happen together and both
 * belong here rather than in six pages (requirement 3.10):
 *
 *   - the content region carries the no-events state, which is why
 *     `EventScopedView` renders nothing for `empty` — one sentence for the whole
 *     console instead of the same sentence on every event-scoped route;
 *   - every event-scoped navigation entry is disabled, so the reason a route
 *     cannot be opened is visible in the same frame as the explanation.
 *
 * It replaces the routed view for every protected route, including the
 * org-level Command Center: with no event there is no operation to summarise,
 * and a greeting above an empty visual would be a page pretending to work.
 */
function EventAwareFrame({ children }: { children: ReactNode }) {
  const { status } = useEventContext();
  const noEvents = status === "empty";

  return (
    <ConsoleFrame
      eventSwitcher={<EventSwitcher />}
      demoWorkspaceChip={<DemoWorkspaceChip />}
      eventScopedNavDisabled={noEvents}
    >
      {noEvents ? <NoEventsState /> : children}
    </ConsoleFrame>
  );
}

/**
 * The content region while the session is unresolved (requirement 1.4).
 *
 * Shape-preserving placeholders in a single announced region: a page title, its
 * context line, and the first block of content. No spinner, and no login form.
 */
function SessionSkeleton() {
  return (
    <SkeletonRegion label={RESTORING_SESSION}>
      <Skeleton shape="heading" width="half" />
      <Skeleton shape="line" width="narrow" />
      <Skeleton shape="block" />
    </SkeletonRegion>
  );
}

/**
 * The layout every protected route renders inside.
 *
 * `RequireSession` swaps the content region rather than the frame, so a page
 * never mounts — and never fires a request — before a token is known to be
 * available.
 *
 * `EventProvider` sits inside that gate and outside the frame, which is the only
 * placement that satisfies both halves of the event context: inside, so
 * `GET /events` is never issued without a session (requirement 3.7); outside the
 * frame, so the `Topbar` switcher and the page in the content region read the
 * same active event rather than two copies of it (requirement 3.11).
 */
function ProtectedLayout() {
  return (
    <RequireSession
      skeleton={
        <ConsoleFrame>
          <SessionSkeleton />
        </ConsoleFrame>
      }
    >
      <EventProvider>
        <EventAwareFrame>
          <Outlet />
        </EventAwareFrame>
      </EventProvider>
    </RequireSession>
  );
}

/**
 * The sign-in screen. Sign-in itself does not navigate: it re-reads the session,
 * and `RedirectWhenAuthenticated` sends the visitor to the route they originally
 * asked for (requirements 1.1, 1.5).
 */
function LoginRoute() {
  const { refresh } = useSession();

  return (
    <Login
      onSignedIn={() => {
        void refresh();
      }}
    />
  );
}

/**
 * The unresolved state for `/login`. A signed-in visitor who opens this address
 * is about to be redirected away, so the login form must not render first.
 *
 * It borrows the sign-in screen's own layout classes — `Login.css`, imported by
 * `Login` above — so the message sits exactly where the form will, and the
 * screen does not jump when the session resolves.
 */
function LoginPending() {
  return (
    <main className="login">
      <p className="login__restoring" role="status">
        {RESTORING_SESSION}
      </p>
    </main>
  );
}

export function App() {
  return (
    <SessionProvider>
      <Routes>
        <Route
          path={LOGIN_ROUTE}
          element={
            <RedirectWhenAuthenticated pending={<LoginPending />}>
              <LoginRoute />
            </RedirectWhenAuthenticated>
          }
        />

        <Route element={<ProtectedLayout />}>
          {protectedRoutes(CAPABILITIES)}

          {/* Every unmatched address, including a capability-gated one whose flag
              is off, resolves here — inside the shell (requirement 11.1). */}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </SessionProvider>
  );
}
