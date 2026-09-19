/**
 * Application root: routing, session, and the shared event context.
 *
 * The router renders unconditionally. Previously the session gate returned `<Login/>` *before*
 * `<Routes>`, which made every public path unreachable — that is why there was no landing page. Now
 * `/` and `/login` are public and everything under `/app` sits behind a guard.
 *
 * The guard is a convenience, not the control. Authorization is the API's: it resolves team scope from
 * DynamoDB and refuses out-of-scope requests whatever this component believed. A member removed from
 * a team keeps a valid token until it expires, so screens treat 403 as a normal outcome.
 */

import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import { ApiError, DEFAULT_EVENT_ID, getCommandCenter, getEvents, isMockMode, startDemoSession } from "./api";
import { getSignedInUser, isAuthConfigured, signOut } from "./auth";
import { AppShell } from "./components/AppShell";
import { ErrorState, LoadingState } from "./components/primitives";
import { AgentConsole } from "./pages/AgentConsole";
import { ApprovalsPage } from "./pages/Approvals";
import { AttendeeOpsPage } from "./pages/AttendeeOps";
import { AuditLogPage } from "./pages/AuditLog";
import { BudgetPage } from "./pages/Budget";
import { CheckinConsole } from "./pages/CheckinConsole";
import { CommandCenter } from "./pages/CommandCenter";
import { IncidentOpsPage } from "./pages/IncidentOps";
import { Landing } from "./pages/Landing";
import { Login } from "./pages/Login";
import { SpeakerOpsPage } from "./pages/SpeakerOps";
import { TeamOpsPage } from "./pages/TeamOps";
import type { HealthBand, Role } from "./types";

type SessionState = "checking" | "signed-in" | "signed-out";

interface Session {
  email: string;
  name: string;
  role: Role;
  isDemo: boolean;
}

/** Fun Mode is a per-user preference with no operational effect, so it lives client-side. */
const FUN_MODE_KEY = "communityops.funMode";

function readFunMode(): boolean {
  try {
    return localStorage.getItem(FUN_MODE_KEY) === "true";
  } catch {
    return false;
  }
}

export function App() {
  // Mock mode is for local UI work with no backend, so it needs no session.
  const [sessionState, setSessionState] = useState<SessionState>(
    isMockMode || !isAuthConfigured ? "signed-in" : "checking",
  );
  const [session, setSession] = useState<Session | null>(null);

  const [eventId, setEventId] = useState(DEFAULT_EVENT_ID);
  const [events, setEvents] = useState<{ event_id: string; name: string }[]>([]);
  const [eventName, setEventName] = useState("");
  const [healthBand, setHealthBand] = useState<HealthBand>("GREEN");
  const [decisionCount, setDecisionCount] = useState(0);

  const [demoBusy, setDemoBusy] = useState(false);
  const [demoUnavailable, setDemoUnavailable] = useState<string | undefined>();
  const [shellError, setShellError] = useState<string | undefined>();
  const [funMode, setFunMode] = useState(readFunMode);

  const location = useLocation();

  const loadSession = useCallback(async () => {
    if (isMockMode || !isAuthConfigured) {
      setSession({ email: "local@communityops.local", name: "Local", role: "LEADER", isDemo: false });
      setSessionState("signed-in");
      return;
    }
    const user = await getSignedInUser();
    if (user) {
      setSession({ email: user.email, name: user.name, role: user.role, isDemo: user.isDemo });
      setSessionState("signed-in");
    } else {
      setSession(null);
      setSessionState("signed-out");
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  /**
   * Load the shell's context: which events exist and what needs attention.
   *
   * One call to the command centre supplies the decision count and health band, so the shell does not
   * need its own aggregation and cannot disagree with the Command Center page about how many decisions
   * are waiting.
   */
  const loadShellContext = useCallback(async () => {
    if (sessionState !== "signed-in") return;
    setShellError(undefined);
    try {
      const [eventList, commandCenter] = await Promise.all([
        getEvents().catch(() => ({ events: [], count: 0 })),
        getCommandCenter(),
      ]);

      const usable = eventList.events.map((e) => ({ event_id: e.event_id, name: e.name }));
      setEvents(usable);

      // Prefer the event already in context; otherwise take the first the backend reports, so a
      // deployment with a different seeded event still lands somewhere real.
      const active =
        commandCenter.events.find((e) => e.event_id === eventId) ?? commandCenter.events[0];
      if (active) {
        if (active.event_id !== eventId) setEventId(active.event_id);
        setEventName(active.name);
        setHealthBand(active.health_band);
      }
      setDecisionCount(commandCenter.summary.pending_approvals);
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthenticated) {
        setSessionState("signed-out");
        return;
      }
      setShellError(
        err instanceof ApiError ? err.message : "Could not load your workspace.",
      );
    }
  }, [sessionState, eventId]);

  useEffect(() => {
    void loadShellContext();
  }, [loadShellContext]);

  const handleTryDemo = useCallback(async () => {
    setDemoBusy(true);
    setDemoUnavailable(undefined);
    try {
      await startDemoSession();
      await loadSession();
    } catch (err) {
      // A 404 means this deployment has no demo credentials configured. Recorded so the login page
      // hides the action rather than offering a button that keeps failing.
      if (err instanceof ApiError && err.status === 404) {
        setDemoUnavailable(
          "Demo access is not configured on this deployment. Sign in with an account instead.",
        );
      } else {
        setDemoUnavailable(
          err instanceof ApiError ? err.message : "The demo could not be opened. Please try again.",
        );
      }
    } finally {
      setDemoBusy(false);
    }
  }, [loadSession]);

  const handleSignOut = useCallback(() => {
    signOut();
    setSession(null);
    setSessionState("signed-out");
  }, []);

  const toggleFunMode = useCallback(() => {
    setFunMode((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(FUN_MODE_KEY, String(next));
      } catch {
        /* preference is best-effort */
      }
      return next;
    });
  }, []);

  if (sessionState === "checking") {
    return (
      <div className="auth-shell">
        <p role="status">Restoring your session…</p>
      </div>
    );
  }

  const signedIn = sessionState === "signed-in" && session !== null;
  const role: Role = session?.role ?? "TEAM_MEMBER";

  return (
    <Routes>
      {/* Public */}
      <Route
        path="/"
        element={
          signedIn ? (
            <Navigate to="/app" replace />
          ) : (
            <Landing onTryDemo={handleTryDemo} demoBusy={demoBusy} />
          )
        }
      />
      <Route
        path="/login"
        element={
          signedIn ? (
            <Navigate to="/app" replace />
          ) : (
            <Login
              onSignedIn={() => void loadSession()}
              onTryDemo={handleTryDemo}
              demoBusy={demoBusy}
              demoUnavailableReason={demoUnavailable}
            />
          )
        }
      />

      {/* Guarded */}
      <Route
        path="/app"
        element={
          signedIn ? (
            <AppShell
              role={role}
              email={session?.email ?? ""}
              isDemo={session?.isDemo ?? false}
              eventName={eventName}
              healthBand={healthBand}
              decisionCount={decisionCount}
              onSignOut={handleSignOut}
              events={events}
              eventId={eventId}
              onEventChange={setEventId}
            />
          ) : (
            // Preserve where they were heading so sign-in returns them there.
            <Navigate to="/login" replace state={{ from: location.pathname }} />
          )
        }
      >
        <Route
          index
          element={
            shellError ? (
              <ErrorState message={shellError} onRetry={() => void loadShellContext()} />
            ) : !eventName && events.length === 0 ? (
              <LoadingState />
            ) : (
              <CommandCenter
                eventId={eventId}
                role={role}
                funMode={funMode}
                onToggleFunMode={toggleFunMode}
              />
            )
          }
        />
        <Route path="speakers" element={<SpeakerOpsPage eventId={eventId} role={role} />} />
        <Route path="teams" element={<TeamOpsPage eventId={eventId} role={role} />} />
        <Route path="attendees" element={<AttendeeOpsPage eventId={eventId} />} />
        <Route
          path="incidents"
          element={
            <IncidentOpsPage
              eventId={eventId}
              role={role}
              onChanged={() => void loadShellContext()}
            />
          }
        />
        <Route path="checkin" element={<CheckinConsole eventId={eventId} />} />
        <Route
          path="approvals"
          element={
            <ApprovalsPage
              eventId={eventId}
              role={role}
              onDecided={() => void loadShellContext()}
            />
          }
        />
        <Route path="budget" element={<BudgetPage eventId={eventId} role={role} />} />
        <Route path="audit" element={<AuditLogPage eventId={eventId} role={role} />} />
        <Route
          path="agent"
          element={
            <AgentConsole
              eventId={eventId}
              role={role}
              funMode={funMode}
              onToggleFunMode={toggleFunMode}
            />
          }
        />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Route>

      <Route path="*" element={<Navigate to={signedIn ? "/app" : "/"} replace />} />
    </Routes>
  );
}
