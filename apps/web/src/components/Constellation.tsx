/**
 * The Command Center event visual.
 *
 * Events as nodes around a centre. Node size encodes operational scale (task count) and the ring
 * encodes health band, so size and colour each carry one fact rather than being decoration.
 *
 * Deliberately not an architecture diagram or an AI flow graph. It exists to answer "where is the
 * attention" at a glance for a leader running more than one event; with a single event it degrades to
 * one node and a summary line, which is the honest rendering of that situation rather than a chart
 * padded out to look busy.
 *
 * Positions are deterministic from index, so a re-render never reshuffles the layout — a visual that
 * moves when nothing changed reads as instability.
 */

import type { EventSummary } from "../types";

const HEALTH_COLOR: Record<string, string> = {
  GREEN: "var(--health-green)",
  YELLOW: "var(--health-yellow)",
  ORANGE: "var(--health-orange)",
  RED: "var(--health-red)",
};

const VIEW_W = 640;
const VIEW_H = 200;

export function Constellation({
  events,
  activeEventId,
  onSelect,
}: {
  events: EventSummary[];
  activeEventId?: string;
  onSelect?: (eventId: string) => void;
}) {
  if (events.length === 0) return null;

  const cx = VIEW_W / 2;
  const cy = VIEW_H / 2;

  // Scale node radius by task volume, bounded so one large event does not dwarf the rest into
  // invisibility and a brand-new event is still clickable.
  const maxTasks = Math.max(1, ...events.map((e) => e.total_tasks ?? 0));
  const radiusFor = (event: EventSummary) => {
    const tasks = event.total_tasks ?? 0;
    return 13 + Math.round((tasks / maxTasks) * 13);
  };

  // A single event sits at the centre; several spread on an ellipse. The ellipse is wider than tall
  // because the container is, and a circle would waste the horizontal space.
  const positions = events.map((_, index) => {
    if (events.length === 1) return { x: cx, y: cy };
    const angle = (index / events.length) * Math.PI * 2 - Math.PI / 2;
    return {
      x: cx + Math.cos(angle) * (VIEW_W * 0.3),
      y: cy + Math.sin(angle) * (VIEW_H * 0.28),
    };
  });

  return (
    <div className="constellation">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={`Operational overview of ${events.length} event${events.length === 1 ? "" : "s"}`}
      >
        {/* Connecting lines only when there is more than one node — a line to nothing is noise. */}
        {events.length > 1 &&
          positions.map((pos, index) => (
            <line
              key={`link-${index}`}
              x1={cx}
              y1={cy}
              x2={pos.x}
              y2={pos.y}
              stroke="var(--border)"
              strokeWidth={1}
            />
          ))}

        {events.length > 1 && (
          <circle cx={cx} cy={cy} r={4} fill="var(--border-strong)" />
        )}

        {events.map((event, index) => {
          const pos = positions[index]!;
          const r = radiusFor(event);
          const color = HEALTH_COLOR[event.health_band] ?? "var(--text-subtle)";
          const isActive = event.event_id === activeEventId;
          // Only count what a leader would act on. Completed work is not attention.
          const attention =
            (event.pending_approvals ?? 0) +
            (event.open_incidents ?? 0) +
            (event.overdue_tasks ?? 0);

          return (
            <g
              key={event.event_id}
              className="constellation-node"
              onClick={() => onSelect?.(event.event_id)}
              role={onSelect ? "button" : undefined}
              tabIndex={onSelect ? 0 : undefined}
              aria-label={`${event.name}: health ${event.health_band}, ${attention} items needing attention`}
              onKeyDown={(e) => {
                if (onSelect && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onSelect(event.event_id);
                }
              }}
            >
              {/* A soft halo marks the event currently in context. */}
              {isActive && (
                <circle cx={pos.x} cy={pos.y} r={r + 7} fill={color} opacity={0.1} />
              )}
              <circle
                cx={pos.x}
                cy={pos.y}
                r={r}
                fill="var(--surface)"
                stroke={color}
                strokeWidth={isActive ? 3 : 2}
              />
              <text
                x={pos.x}
                y={pos.y + 4}
                textAnchor="middle"
                fontSize={12}
                fontWeight={600}
                fill={color}
              >
                {attention > 0 ? attention : "✓"}
              </text>
              <text
                className="constellation-label"
                x={pos.x}
                y={pos.y + r + 16}
                textAnchor="middle"
              >
                {/* Truncated rather than wrapped: SVG text does not wrap, and an overflowing
                    label would collide with its neighbours. */}
                {event.name.length > 26 ? `${event.name.slice(0, 24)}…` : event.name}
              </text>
            </g>
          );
        })}
      </svg>

      {/* The legend is the accessible reading of the chart, not an extra. */}
      <div className="cluster" style={{ marginTop: "var(--s3)", gap: "var(--s4)" }}>
        <span className="t-meta">
          Ring colour is event health · number is items needing attention · size is operational scale
        </span>
      </div>
    </div>
  );
}
