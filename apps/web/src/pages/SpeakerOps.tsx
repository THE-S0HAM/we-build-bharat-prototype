/**
 * SpeakerOps.
 *
 * Answers: which speakers need attention? The list shows name, topic, status and follow-up count
 * only — everything else is in the drawer. A speaker table with contact details, travel, cost and
 * session time in every row is a CRM, and a leader scanning for problems has to read past all of it.
 *
 * Drafting a follow-up happens inline because it is low-risk and immediately useful. Sending is
 * approval-gated, so the UI says so rather than offering a Send button the API would refuse.
 */

import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  draftSpeakerFollowup,
  formatInrWithSymbol,
  getSpeakers,
} from "../api";
import {
  Card,
  DetailList,
  Drawer,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  Stat,
  StatusBadge,
  Tabs,
} from "../components/primitives";
import type { Role, Speaker, SpeakerListResponse } from "../types";

/** The outreach lifecycle, in order. Used to render progression rather than a bare status. */
const LIFECYCLE = ["IDENTIFIED", "INVITED", "AWAITING_RESPONSE", "FOLLOWUP_SENT", "CONFIRMED"];
const LIFECYCLE_LABEL: Record<string, string> = {
  IDENTIFIED: "Identified",
  INVITED: "Invited",
  AWAITING_RESPONSE: "Awaiting",
  FOLLOWUP_SENT: "Follow-up",
  CONFIRMED: "Confirmed",
};

type Filter = "attention" | "all";

function Lifecycle({ status }: { status: string }) {
  // A declined or cancelled speaker is off the track entirely; showing them mid-progression would
  // imply the process is still running.
  if (["DECLINED", "CANCELLED"].includes(status)) {
    return <StatusBadge status={status} />;
  }
  const current = LIFECYCLE.indexOf(status);
  return (
    <div className="lifecycle">
      {LIFECYCLE.map((step, index) => {
        const state = index < current ? "done" : index === current ? "current" : "";
        return (
          <div key={step} style={{ display: "flex", alignItems: "center" }}>
            {index > 0 && <span className="lifecycle-line" aria-hidden="true" />}
            <span className={`lifecycle-step ${state}`}>
              <span className="lifecycle-dot" aria-hidden="true" />
              {LIFECYCLE_LABEL[step]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function SpeakerOpsPage({ eventId, role }: { eventId: string; role: Role }) {
  const [data, setData] = useState<SpeakerListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [filter, setFilter] = useState<Filter>("attention");
  const [selected, setSelected] = useState<Speaker | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<string | undefined>();
  const [draftError, setDraftError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setData(await getSpeakers(eventId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load speakers.");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDraft(speaker: Speaker) {
    setDrafting(true);
    setDraftError(undefined);
    try {
      const result = await draftSpeakerFollowup(eventId, speaker.speaker_id);
      setDraft(result.draft);
      await load();
    } catch (err) {
      setDraftError(
        err instanceof ApiError ? err.message : "The follow-up could not be drafted.",
      );
    } finally {
      setDrafting(false);
    }
  }

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!data) return <ErrorState onRetry={() => void load()} />;

  // "Needs attention" is anything unsettled: silent past the threshold, or invited without a
  // confirmed slot. A confirmed speaker with everything submitted is not on this list.
  const needsAttention = data.speakers.filter(
    (s) => s.needs_followup || (!s.availability_confirmed && !["CONFIRMED", "DECLINED", "CANCELLED"].includes(s.status)),
  );
  const shown = filter === "attention" ? needsAttention : data.speakers;

  return (
    <div>
      <PageHeader
        title="SpeakerOps"
        subtitle="Speaker outreach and readiness. Follow-ups are drafted automatically; sending one needs your approval."
      />

      <div className="stat-grid" style={{ marginBottom: "var(--s5)" }}>
        <Stat value={data.confirmed} label="Confirmed" />
        <Stat
          value={data.unresponsive_over_72h}
          label="Silent over 72h"
          tone={data.unresponsive_over_72h > 0 ? "at-risk" : undefined}
        />
        <Stat value={data.pending} label="Still unsettled" />
        <Stat
          value={formatInrWithSymbol(
            data.estimated_travel_cost_inr + data.estimated_accommodation_cost_inr,
          )}
          label="Travel + accommodation"
          note={`${data.needing_accommodation} need accommodation`}
        />
      </div>

      <Tabs<Filter>
        tabs={[
          { id: "attention", label: "Needs attention", count: needsAttention.length },
          { id: "all", label: "All speakers", count: data.speakers.length },
        ]}
        active={filter}
        onChange={setFilter}
      />

      {shown.length === 0 ? (
        <EmptyState
          title="Every speaker is settled"
          body="No one is waiting on a reply and nothing is unconfirmed. CommunityOps will flag a speaker that goes quiet for more than 72 hours."
        />
      ) : (
        <Card padding="flush">
          <ul className="rows">
            {shown.map((speaker) => (
              <li key={speaker.speaker_id}>
                <button
                  className="row"
                  type="button"
                  onClick={() => {
                    setSelected(speaker);
                    setDraft(speaker.followup_draft);
                    setDraftError(undefined);
                  }}
                >
                  <div className="row-main">
                    <div className="row-title">{speaker.name}</div>
                    <div className="row-meta">{speaker.topic || "Topic not set"}</div>
                  </div>
                  <div className="row-side">
                    {speaker.needs_followup && speaker.silent_hours ? (
                      <span className="badge badge-at-risk">
                        Silent {speaker.silent_hours}h
                      </span>
                    ) : null}
                    {speaker.followup_count > 0 && (
                      <span className="t-meta">
                        {speaker.followup_count} follow-up{speaker.followup_count === 1 ? "" : "s"}
                      </span>
                    )}
                    <StatusBadge status={speaker.status} />
                    <span className="row-chevron" aria-hidden="true">
                      ›
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ""}
        subtitle={selected?.topic}
        footer={
          selected && selected.needs_followup && role === "LEADER" ? (
            <button
              className="btn btn-primary"
              type="button"
              disabled={drafting}
              onClick={() => void handleDraft(selected)}
            >
              {drafting ? "Drafting…" : draft ? "Redraft follow-up" : "Draft follow-up"}
            </button>
          ) : undefined
        }
      >
        {selected && (
          <div className="stack">
            <Lifecycle status={selected.status} />

            {selected.needs_followup && (
              <Notice tone="warn">
                No reply for {selected.silent_hours}h. The threshold is 72 hours.
              </Notice>
            )}

            {draftError && <Notice tone="error">{draftError}</Notice>}

            {draft && (
              <Card title="Drafted follow-up" padding="tight">
                <p className="t-body" style={{ whiteSpace: "pre-wrap" }}>
                  {draft}
                </p>
                <div style={{ marginTop: "var(--s4)" }}>
                  <Notice tone="info">
                    <strong>Not sent.</strong> Messages leaving the organization need your approval
                    — ask CommunityOps to request one, or send it yourself from your mail client.
                  </Notice>
                </div>
              </Card>
            )}

            <DetailList
              items={[
                { label: "Status", value: <StatusBadge status={selected.status} /> },
                { label: "Session", value: selected.session_type },
                { label: "Slot", value: selected.session_time },
                { label: "Email", value: selected.email },
                { label: "Follow-ups sent", value: String(selected.followup_count) },
                {
                  label: "Availability",
                  value: selected.availability_confirmed ? "Confirmed" : "Not confirmed",
                },
                {
                  label: "Slides",
                  value: selected.slides_submitted ? "Submitted" : "Not submitted",
                },
                {
                  label: "Travel",
                  value: selected.travel_required
                    ? `From ${selected.travel_origin || "unspecified"} · ${formatInrWithSymbol(selected.estimated_travel_cost)}`
                    : "Not required",
                },
                {
                  label: "Accommodation",
                  value: selected.accommodation_required
                    ? `${selected.accommodation_nights || 0} night(s) · ${formatInrWithSymbol(selected.estimated_accommodation_cost)}`
                    : "Not required",
                },
                { label: "Requirements", value: selected.special_requirements },
                { label: "Notes", value: selected.availability_notes },
              ]}
            />

            {selected.accommodation_required && (
              <Notice tone="info">
                Booking accommodation is a financial commitment, so it appears in Approvals rather
                than being arranged automatically.
              </Notice>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
