import { useEffect, useState } from "react";
import { NavLink, Route, Routes, Navigate } from "react-router-dom";
import { isMockMode } from "./api";
import { getSignedInEmail, isAuthConfigured, isSignedIn, signOut } from "./auth";
import { CommandCenter } from "./pages/CommandCenter";
import { CheckinConsole } from "./pages/CheckinConsole";
import { ApprovalCenter } from "./pages/ApprovalCenter";
import { SpeakerOps } from "./pages/SpeakerOps";
import { TaskBoard } from "./pages/TaskBoard";
import { IncidentCenter } from "./pages/IncidentCenter";
import { AuditLog } from "./pages/AuditLog";
import { Login } from "./pages/Login";

const EVENT_ID = "EVT-devcon-2026";

type SessionState = "checking" | "signed-in" | "signed-out";

export function App() {
  // Mock mode is for local UI work with no backend, so it needs no session.
  const [session, setSession] = useState<SessionState>(
    isMockMode || !isAuthConfigured ? "signed-in" : "checking",
  );

  useEffect(() => {
    if (isMockMode || !isAuthConfigured) return;
    let active = true;
    isSignedIn().then((ok) => {
      if (active) setSession(ok ? "signed-in" : "signed-out");
    });
    return () => {
      active = false;
    };
  }, []);

  if (session === "checking") {
    return (
      <div className="login-shell">
        <p role="status">Restoring session…</p>
      </div>
    );
  }

  if (session === "signed-out") {
    return <Login onSignedIn={() => setSession("signed-in")} />;
  }

  const email = getSignedInEmail();

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          CommunityOps
          <span>AI Operations Agent</span>
        </div>
        <ul className="sidebar-nav">
          <li>
            <NavLink to="/" end>
              ⌘ Command Center
            </NavLink>
          </li>
          <li>
            <NavLink to="/checkin">☑ Check-In</NavLink>
          </li>
          <li>
            <NavLink to="/approvals">✋ Approvals</NavLink>
          </li>
          <li>
            <NavLink to="/speakers">🎤 Speakers</NavLink>
          </li>
          <li>
            <NavLink to="/tasks">📋 Tasks</NavLink>
          </li>
          <li>
            <NavLink to="/incidents">⚠ Incidents</NavLink>
          </li>
          <li>
            <NavLink to="/audit">📜 Audit Log</NavLink>
          </li>
        </ul>

        {isMockMode && (
          <div
            className="mock-mode-badge"
            role="status"
            aria-label="Demo mode active — showing simulated data, not live operational data"
          >
            ⚡ Demo Mode
          </div>
        )}

        {!isMockMode && isAuthConfigured && (
          <div className="sidebar-account">
            {email && <span className="sidebar-account-email">{email}</span>}
            <button
              className="btn btn-sm"
              onClick={() => {
                signOut();
                setSession("signed-out");
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </aside>

      <main className="main-content">
        <Routes>
          <Route path="/" element={<CommandCenter />} />
          <Route path="/checkin" element={<CheckinConsole eventId={EVENT_ID} />} />
          <Route path="/approvals" element={<ApprovalCenter eventId={EVENT_ID} />} />
          <Route path="/speakers" element={<SpeakerOps eventId={EVENT_ID} />} />
          <Route path="/tasks" element={<TaskBoard eventId={EVENT_ID} />} />
          <Route path="/incidents" element={<IncidentCenter eventId={EVENT_ID} />} />
          <Route path="/audit" element={<AuditLog eventId={EVENT_ID} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
