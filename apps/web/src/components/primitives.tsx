/**
 * Shared primitives.
 *
 * One definition each, because "Approve" meaning the same thing in two places must look the same in
 * both. Every visual decision lives in `index.css` against design tokens; these components only
 * choose which class applies.
 */

import type { ReactNode } from "react";
import { useEffect, useId, useRef } from "react";

import { toneFor } from "../status";
import type { HealthBand, Severity, StatusTone } from "../types";

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function StatusBadge({
  status,
  tone,
  label,
}: {
  status?: string;
  tone?: StatusTone;
  label?: string;
}) {
  const resolved = tone ?? toneFor(status);
  // Underscores become spaces so a raw enum value never reaches the screen.
  const text = label ?? (status || resolved).replace(/_/g, " ").toLowerCase();
  return (
    <span className={`badge badge-${resolved}`}>
      {text.charAt(0).toUpperCase() + text.slice(1)}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: Severity | string }) {
  const value = (severity || "LOW").toUpperCase();
  return <span className={`badge badge-${value.toLowerCase()}`}>{value}</span>;
}

/**
 * Event health. The dot is decorative — the band name is always present, because colour alone is
 * not an accessible signal.
 */
export function HealthPill({ band, score }: { band: HealthBand; score?: number }) {
  return (
    <span className="cluster" style={{ gap: 6 }}>
      <span className={`health-dot ${band}`} aria-hidden="true" />
      <span className="t-meta" style={{ fontWeight: 600, color: "var(--text)" }}>
        {band}
        {score !== undefined ? ` · ${score}/100` : ""}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <h1 className="t-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  action,
  children,
  footer,
  padding = "normal",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  padding?: "normal" | "tight" | "flush";
}) {
  const bodyClass =
    padding === "flush" ? "card-body flush" : padding === "tight" ? "card-body tight" : "card-body";
  return (
    <section className="card">
      {title && (
        <div className="card-head">
          <span className="t-card">{title}</span>
          {action}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  );
}

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h2 className="t-section">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Stat({
  value,
  label,
  note,
  tone,
}: {
  value: ReactNode;
  label: string;
  note?: string;
  tone?: StatusTone;
}) {
  const color = tone ? `var(--status-${tone})` : "var(--text)";
  return (
    <div className="stat">
      <div className="stat-value" style={{ color }}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

export function Progress({
  percent,
  tone,
}: {
  percent: number;
  tone?: "normal" | "at-risk" | "over";
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const toneClass = tone && tone !== "normal" ? ` ${tone}` : "";
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={`progress-fill${toneClass}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function Skeleton({ variant = "line", width }: { variant?: "line" | "title" | "card"; width?: string }) {
  const cls =
    variant === "card" ? "skeleton skeleton-card" : variant === "title" ? "skeleton skeleton-title" : "skeleton skeleton-line";
  return <div className={cls} style={width ? { width } : undefined} aria-hidden="true" />;
}

/** A page-level loading state. `aria-busy` so assistive tech announces the wait. */
export function LoadingState({ label = "Getting the latest operation state…" }: { label?: string }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      <Skeleton variant="title" />
      <div className="stat-grid" style={{ marginBottom: "var(--s5)" }}>
        <Skeleton variant="card" />
        <Skeleton variant="card" />
        <Skeleton variant="card" />
        <Skeleton variant="card" />
      </div>
      <Skeleton variant="card" />
    </div>
  );
}

export function EmptyState({
  mark = "✓",
  title,
  body,
  action,
}: {
  mark?: string;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state">
      <div className="state-mark" aria-hidden="true">
        {mark}
      </div>
      <div className="state-title">{title}</div>
      {body && <p className="state-body">{body}</p>}
      {action}
    </div>
  );
}

/**
 * An error state.
 *
 * The message shown is whatever the API sent, which is written for a user — the backend maps its
 * error categories to readable sentences. Raw Lambda, DynamoDB and AWS detail never reach here
 * because the backend does not emit it.
 */
export function ErrorState({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="state error" role="alert">
      <div className="state-mark" aria-hidden="true">
        !
      </div>
      <div className="state-title">CommunityOps couldn&rsquo;t load this view</div>
      <p className="state-body">{message || "Something went wrong reading operational state."}</p>
      {onRetry && (
        <button className="btn" onClick={onRetry} type="button">
          Try again
        </button>
      )}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "error" | "ok";
  children: ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : undefined}>
      <div>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

/**
 * A right-hand slide-over, full-screen on mobile.
 *
 * Handles the three things an overlay has to get right to be usable by keyboard: Escape closes it,
 * focus moves into it on open, and focus is trapped while it is open. Without the trap, tabbing
 * walks invisibly through the page behind — which is disorienting for a sighted keyboard user and
 * incomprehensible with a screen reader.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Where focus was before opening, so it can be restored on close.
  const restoreRef = useRef<HTMLElement | null>(null);

  /**
   * The close handler, held in a ref.
   *
   * Callers pass an inline arrow, so `onClose` is a new function on every render. With it in the
   * effect's dependency list the effect tore down and re-ran after each render, and its setup moves
   * focus to the panel — so typing into a field inside the drawer lost focus after the first
   * character, every time. The ref keeps the handler current while letting the effect depend only on
   * `open`.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    // The page behind must not scroll while a full-screen overlay is up.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="drawer-head">
          <div className="drawer-head-text">
            <h2 className="t-card" id={titleId}>
              {title}
            </h2>
            {subtitle && <div className="t-meta" style={{ marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button className="drawer-close" onClick={onClose} type="button" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string; count?: number }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className="tab"
          role="tab"
          type="button"
          aria-selected={tab.id === active}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && tab.count > 0 ? ` (${tab.count})` : ""}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Definition list
// ---------------------------------------------------------------------------

export function DetailList({ items }: { items: { label: string; value: ReactNode }[] }) {
  const shown = items.filter((i) => i.value !== undefined && i.value !== null && i.value !== "");
  if (shown.length === 0) return null;
  return (
    <dl className="dl">
      {shown.map((item) => (
        <div key={item.label} style={{ display: "contents" }}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
