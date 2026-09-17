import { NavLink, Route, Routes, Navigate } from "react-router-dom";
import { CommandCenter } from "./pages/CommandCenter";
import { CheckinConsole } from "./pages/CheckinConsole";
import { ApprovalCenter } from "./pages/ApprovalCenter";
import { SpeakerOps } from "./pages/SpeakerOps";
import { TaskBoard } from "./pages/TaskBoard";
import { IncidentCenter } from "./pages/IncidentCenter";
import { AuditLog } from "./pages/AuditLog";

const EVENT_ID = "EVT-devcon-2026";

export function App() {
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          OrbitOps
          <span>CommunityOps Agent</span>
        </div>
        <ul className="sidebar-nav">
          <li><NavLink to="/" end>⌘ Command Center</NavLink></li>
          <li><NavLink to="/checkin">☑ Check-In</NavLink></li>
          <li><NavLink to="/approvals">✋ Approvals</NavLink></li>
          <li><NavLink to="/speakers">🎤 Speakers</NavLink></li>
          <li><NavLink to="/tasks">📋 Tasks</NavLink></li>
          <li><NavLink to="/incidents">⚠ Incidents</NavLink></li>
          <li><NavLink to="/audit">📜 Audit Log</NavLink></li>
        </ul>
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
