/**
 * The one application shell.
 *
 * Navigation is grouped by operational concern rather than by entity type, because the leader's
 * mental model is "what part of the operation is this" and not "which table does this read". A
 * generic Dashboard / Events / Tasks / Speakers list would make every area look equally important,
 * which is the opposite of what the product is for.
 *
 * The sidebar is navigation only. No charts, no per-item health, no activity feed — those belong on
 * the screens they describe. A count appears beside an item only when something is genuinely
 * waiting, so a badge always means "there is work here" rather than "here is a number".
 */

import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { isMockMode } from "../api";
import type { HealthBand, Role } from "../types";

interface NavEntry {
  to: string;
  label: string;
  icon: string;
  /** Navigation items a team member does not see. The API refuses them independently. */
  leaderOnly?: boolean;
  countKey?: "decisions";
}

interface NavGroup {
  label?: string;
  items: NavEntry[];
}

const NAV: NavGroup[] = [
  {
    items: [{ to: "/app", label: "Command Center", icon: "◎" }],
  },
  {
    label: "Operations",
    items: [
      { to: "/app/speakers", label: "SpeakerOps", icon: "◈" },
      { to: "/app/teams", label: "TeamOps", icon: "◇" },
      { to: "/app/attendees", label: "AttendeeOps", icon: "◉" },
      { to: "/app/incidents", label: "IncidentOps", icon: "△" },
    ],
  },
  {
    label: "Event day",
    items: [{ to: "/app/checkin", label: "Check-In", icon: "▣" }],
  },
  {
    label: "Governance",
    items: [
      { to: "/app/approvals", label: "Approvals", icon: "✓", countKey: "decisions" },
      { to: "/app/budget", label: "Budget", icon: "₹", leaderOnly: true },
      { to: "/app/audit", label: "Audit Log", icon: "≡", leaderOnly: true },
    ],
  },
  {
    label: "Assistant",
    items: [{ to: "/app/agent", label: "Ask CommunityOps", icon: "✦" }],
  },
];

export interface ShellContext {
  eventId: string;
  eventName: string;
  healthBand: HealthBand;
  role: Role;
}

export function AppShell({
  role,
  email,
  isDemo,
  eventName,
  healthBand,
  decisionCount,
  onSignOut,
  events,
  eventId,
  onEventChange,
}: {
  role: Role;
  email: string;
  isDemo: boolean;
  eventName: string;
  healthBand: HealthBand;
  decisionCount: number;
  onSignOut: () => void;
  events: { event_id: string; name: string }[];
  eventId: string;
  onEventChange: (eventId: string) => void;
}) {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  // A route change on mobile must close the drawer nav, or the new page renders behind it.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  const counts = { decisions: decisionCount };

  return (
    <div className="shell">
      <div
        className={`scrim${navOpen ? " show" : ""}`}
        onClick={() => setNavOpen(false)}
        aria-hidden="true"
      />

      <aside className={`sidebar${navOpen ? " open" : ""}`}>
        <div className="sidebar-brand">
          <span className="sidebar-mark" aria-hidden="true">
            C
          </span>
          CommunityOps
        </div>

        <nav className="sidebar-nav" aria-label="Main navigation">
          {NAV.map((group, groupIndex) => {
            const visible = group.items.filter(
              (item) => !item.leaderOnly || role === "LEADER",
            );
            if (visible.length === 0) return null;
            return (
              <div key={group.label ?? `group-${groupIndex}`}>
                {group.label && <div className="nav-group t-section">{group.label}</div>}
                <ul style={{ listStyle: "none" }}>
                  {visible.map((item) => {
                    const count = item.countKey ? counts[item.countKey] : 0;
                    return (
                      <li key={item.to}>
                        <NavLink
                          to={item.to}
                          end={item.to === "/app"}
                          className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
                        >
                          <span className="nav-icon" aria-hidden="true">
                            {item.icon}
                          </span>
                          {item.label}
                          {count > 0 && (
                            <span className="nav-count" aria-label={`${count} waiting`}>
                              {count}
                            </span>
                          )}
                        </NavLink>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <div className="sidebar-user" title={email}>
            {email || "Signed in"}
          </div>
          <div className="t-meta" style={{ marginBottom: "var(--s3)" }}>
            {role === "LEADER" ? "Community lead" : "Team member"}
          </div>
          <button className="btn btn-sm btn-block" onClick={onSignOut} type="button">
            Sign out
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button
            className="sidebar-toggle"
            onClick={() => setNavOpen((v) => !v)}
            type="button"
            aria-label="Toggle navigation"
            aria-expanded={navOpen}
          >
            ☰
          </button>

          {/* Event context. A plain select rather than a custom dropdown: it is keyboard
              accessible and screen-reader correct for free, and this control should be quiet. */}
          {events.length > 1 ? (
            <label className="event-switch" style={{ cursor: "pointer" }}>
              <span className={`health-dot ${healthBand}`} aria-hidden="true" />
              <span className="sr-only">Current event</span>
              <select
                value={eventId}
                onChange={(e) => onEventChange(e.target.value)}
                style={{
                  border: "none",
                  background: "transparent",
                  font: "inherit",
                  color: "inherit",
                  outline: "none",
                  cursor: "pointer",
                  maxWidth: 260,
                }}
              >
                {events.map((event) => (
                  <option key={event.event_id} value={event.event_id}>
                    {event.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="event-switch" style={{ cursor: "default" }}>
              <span className={`health-dot ${healthBand}`} aria-hidden="true" />
              <span className="event-switch-name">{eventName || "No event selected"}</span>
            </div>
          )}

          <div className="topbar-right">
            {isDemo && (
              <span className="demo-chip" title="You are in the CommunityOps demo workspace">
                Demo workspace
              </span>
            )}
            {isMockMode && (
              <span className="demo-chip" role="status">
                Demo data
              </span>
            )}
            <span className="role-chip">
              {role === "LEADER" ? "Community lead" : "Team member"}
            </span>
          </div>
        </header>

        <main className="page">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
