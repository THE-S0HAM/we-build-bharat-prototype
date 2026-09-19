/**
 * SpeakerOps — "Which speakers are not yet confirmed, and what is CommunityOps
 * doing about it?" (design.md §8.2, requirement 6).
 *
 * The page this replaced was a speaker CRM: a four-metric stat wall and one flat
 * table of every speaker, ordered by nothing in particular. It answered "here is
 * the roster", which is not the question a community leader arrives with. Most
 * speakers are being worked by CommunityOps on its own; the leader needs the few
 * that it cannot move.
 *
 * So the list is grouped, and the group is the answer:
 *
 *   | Group                          | Rule                                                        | Operational state (12.9) |
 *   |--------------------------------|-------------------------------------------------------------|--------------------------|
 *   | Needs attention                | awaiting a reply, and the automated follow-ups are spent     | Cannot be automated      |
 *   | In progress with CommunityOps  | any other status CommunityOps still has a move for           | Handled                  |
 *   | Confirmed                      | `CONFIRMED`                                                 | Handled                  |
 *   | Declined/Cancelled             | `DECLINED`, `CANCELLED`                                     | Cannot be automated      |
 *
 * Every rule reads `status` and `followup_count`, both declared on `Speaker` in
 * `src/types.ts`. Nothing on this page is derived from a field the typed model
 * does not have (requirement 16.5).
 *
 * Status colour belongs to `StatusBadge` and to nothing else (requirement 12.5):
 * the group headings, the progress bar and the row cells all carry text labels
 * and counts, and the page maps no status to a colour of its own.
 */

import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { getAuditLog, getSpeakers } from "../api";
import { ApiErrorState } from "../components/ApiErrorState";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { DistributionBar } from "../components/DistributionBar";
import { Drawer } from "../components/Drawer";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { SkeletonList, SkeletonTable } from "../components/Skeleton";
import { StatusBadge, type OperationalState } from "../components/StatusBadge";
import { Timeline, type TimelineEntry } from "../components/Timeline";
import type { EventScopedPageProps } from "../event/EventScopedView";
import { humaniseUnknownValue, readTableEntry } from "../lib/unknownValue";
import { useApiFailure } from "../session/useApiFailure";
import { updateSpeaker, type SpeakerUpdate } from "../speakerUpdate";
import type { AuditEvent, Speaker } from "../types";
import "./SpeakerOps.css";

/**
 * The point at which CommunityOps stops chasing a speaker on its own.
 *
 * `services/workflows/speaker_followup.py` gates every further follow-up on
 * `followup_count >= 2` and raises an approval instead, so a speaker at or above
 * this count is one the agent has run out of automated moves for. This is the
 * backend's own threshold, read here rather than invented: the console would be
 * claiming a policy of its own with any other number.
 */
const AUTO_FOLLOWUP_LIMIT = 2;

type SpeakerGroupId = "attention" | "in-progress" | "confirmed" | "closed";

/**
 * Which group each declared status belongs to before the follow-up rule is
 * applied. A `Record` over the whole union, so a status added to `src/types.ts`
 * without a group here is a compile error; a status the *backend* invents beyond
 * the union is read through `readTableEntry` and lands in Needs attention, which
 * is the only honest answer for something the console cannot interpret.
 */
const GROUP_BY_STATUS: Record<Speaker["status"], SpeakerGroupId> = {
  IDENTIFIED: "in-progress",
  INVITED: "in-progress",
  AWAITING_RESPONSE: "in-progress",
  FOLLOWUP_SENT: "in-progress",
  BACKUP: "in-progress",
  CONFIRMED: "confirmed",
  DECLINED: "closed",
  CANCELLED: "closed",
};

/**
 * Statuses that mean "CommunityOps has asked and is waiting". Only these are
 * subject to the follow-up rule: a speaker who has not been invited cannot have
 * been chased, and a backup is held in reserve rather than pursued.
 */
const AWAITING_REPLY: ReadonlySet<string> = new Set<Speaker["status"]>([
  "INVITED",
  "AWAITING_RESPONSE",
  "FOLLOWUP_SENT",
]);

function groupOf(speaker: Speaker): SpeakerGroupId {
  const group = readTableEntry(GROUP_BY_STATUS, speaker.status) ?? "attention";

  if (
    group === "in-progress" &&
    AWAITING_REPLY.has(speaker.status) &&
    speaker.followup_count >= AUTO_FOLLOWUP_LIMIT
  ) {
    return "attention";
  }

  return group;
}

interface SpeakerGroupDefinition {
  readonly id: SpeakerGroupId;
  /** Section heading. design.md §8.2 fixes these four names. */
  readonly heading: string;
  /** Why these speakers are here, in one sentence. */
  readonly description: string;
  /** Requirement 12.9 — one of the three states, for every row in the group. */
  readonly operationalState: OperationalState;
  /** Shown instead of a table when the group is empty. */
  readonly emptyLine: string;
}

/** Rendered in this order: the ones that need a person come first. */
const SPEAKER_GROUPS: readonly SpeakerGroupDefinition[] = [
  {
    id: "attention",
    heading: "Needs attention",
    description:
      "CommunityOps has sent every follow-up it can send on its own. These invitations need a person.",
    operationalState: "CANNOT_BE_AUTOMATED",
    emptyLine: "No speaker needs you right now.",
  },
  {
    id: "in-progress",
    heading: "In progress with CommunityOps",
    description:
      "CommunityOps is still working these invitations, and holding any backups in reserve. Nothing for you to do.",
    operationalState: "HANDLED",
    emptyLine: "No invitations in progress.",
  },
  {
    id: "confirmed",
    heading: "Confirmed",
    description: "Confirmed for this event.",
    operationalState: "HANDLED",
    emptyLine: "No speaker has confirmed yet.",
  },
  {
    id: "closed",
    heading: "Declined/Cancelled",
    description: "No longer speaking. The slot is yours to refill.",
    operationalState: "CANNOT_BE_AUTOMATED",
    emptyLine: "No speaker has declined or cancelled.",
  },
];

/** The four group buckets, each in the order the API returned its speakers. */
type GroupedSpeakers = Readonly<Record<SpeakerGroupId, readonly Speaker[]>>;

function groupSpeakers(speakers: readonly Speaker[]): GroupedSpeakers {
  const grouped: Record<SpeakerGroupId, Speaker[]> = {
    attention: [],
    "in-progress": [],
    confirmed: [],
    closed: [],
  };

  for (const speaker of speakers) {
    grouped[groupOf(speaker)].push(speaker);
  }

  return grouped;
}

/**
 * What CommunityOps has done about this speaker, stated as the follow-up count
 * (requirement 6.4). `FOLLOWUP_SENT` and `AWAITING_RESPONSE` are agent progress,
 * not a user to-do, so the count is what makes "Handled" concrete rather than
 * reassuring.
 */
function followupDetail(speaker: Speaker): string | undefined {
  if (speaker.followup_count <= 0) {
    return undefined;
  }

  const plural = speaker.followup_count === 1 ? "follow-up" : "follow-ups";

  return `CommunityOps sent ${speaker.followup_count} ${plural}`;
}

/** Travel and accommodation as words. Two booleans, four readable outcomes. */
function travelSummary(speaker: Speaker): string {
  if (speaker.travel_required && speaker.accommodation_required) {
    return "Travel and accommodation";
  }
  if (speaker.travel_required) {
    return "Travel";
  }
  if (speaker.accommodation_required) {
    return "Accommodation";
  }

  return "Neither required";
}

/** `KEYNOTE` reads as "Keynote". The value is free text on the contract. */
function sessionTypeLabel(speaker: Speaker): string {
  return humaniseUnknownValue(speaker.session_type) ?? "Not set";
}

/**
 * The status vocabulary of the change form.
 *
 * `StatusBadge` owns how a status is *rendered* — its label and its colour — and
 * keeps that table private. A `<select>` needs option text, so these are the
 * editing labels, and they are text only: the page still maps no status to a
 * colour (requirement 12.5). A `Record` over the union keeps the two lists the
 * same length as the contract grows.
 */
const STATUS_OPTION_LABELS: Record<Speaker["status"], string> = {
  IDENTIFIED: "Identified",
  INVITED: "Invited",
  AWAITING_RESPONSE: "Awaiting response",
  FOLLOWUP_SENT: "Follow-up sent",
  CONFIRMED: "Confirmed",
  DECLINED: "Declined",
  CANCELLED: "Cancelled",
  BACKUP: "Backup",
};

const STATUS_OPTIONS = Object.keys(STATUS_OPTION_LABELS) as readonly Speaker["status"][];

/** Reads a `<select>` value back into the union it came from. */
function asSpeakerStatus(value: string): Speaker["status"] | null {
  return STATUS_OPTIONS.find((status) => status === value) ?? null;
}

/** The editable fields, as the form holds them while the user is typing. */
interface SpeakerDraft {
  readonly status: Speaker["status"];
  readonly travel_required: boolean;
  readonly accommodation_required: boolean;
  readonly is_backup: boolean;
}

function draftOf(speaker: Speaker): SpeakerDraft {
  return {
    status: speaker.status,
    travel_required: speaker.travel_required,
    accommodation_required: speaker.accommodation_required,
    is_backup: speaker.is_backup,
  };
}

/** Only what the user actually changed, so an untouched field is never sent. */
function changesIn(speaker: Speaker, draft: SpeakerDraft): SpeakerUpdate {
  const changes: SpeakerUpdate = {};

  if (draft.status !== speaker.status) changes.status = draft.status;
  if (draft.travel_required !== speaker.travel_required) {
    changes.travel_required = draft.travel_required;
  }
  if (draft.accommodation_required !== speaker.accommodation_required) {
    changes.accommodation_required = draft.accommodation_required;
  }
  if (draft.is_backup !== speaker.is_backup) changes.is_backup = draft.is_backup;

  return changes;
}

/** Where a change is in its lifecycle (requirement 13.11). */
type SaveState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
  | { readonly kind: "failed"; readonly failure: unknown };

/** Audit `actor_type` as `Timeline`'s three attributions. */
function actorKindOf(entry: AuditEvent): "agent" | "person" | "system" {
  if (entry.actor_type === "agent") return "agent";
  if (entry.actor_type === "user") return "person";

  return "system";
}

/**
 * One audit record as a readable sentence, built from the modelled fields only
 * (requirement 10.2's field list; `details` is never read).
 */
function activityEntry(entry: AuditEvent): TimelineEntry {
  const action = humaniseUnknownValue(entry.action) ?? "Recorded an action";
  const outcome = humaniseUnknownValue(entry.outcome);
  const tool = entry.tool_used === undefined ? null : humaniseUnknownValue(entry.tool_used);

  return {
    id: entry.audit_id,
    timestamp: entry.timestamp,
    actor: { kind: actorKindOf(entry), name: entry.actor_id },
    action,
    detail: tool === null ? undefined : `Using ${tool}`,
    status: outcome === null ? undefined : <span className="speaker-activity__outcome">{outcome}</span>,
  };
}

export function SpeakerOps({ eventId }: EventScopedPageProps) {
  const report = useApiFailure();

  const [speakers, setSpeakers] = useState<readonly Speaker[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<unknown>(null);

  const [openSpeakerId, setOpenSpeakerId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SpeakerDraft | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  /** Event-wide audit, fetched once the first drawer opens and shared after that. */
  const [activity, setActivity] = useState<readonly AuditEvent[] | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityFailure, setActivityFailure] = useState<unknown>(null);

  const statusFieldId = useId();

  const load = useCallback(() => {
    setLoading(true);
    setFailure(null);

    getSpeakers(eventId).then(
      (response) => {
        setSpeakers(response.speakers);
        setLoading(false);
      },
      (error: unknown) => {
        setFailure(report(error));
        setLoading(false);
      },
    );
  }, [eventId, report]);

  useEffect(load, [load]);

  const loadActivity = useCallback(() => {
    setActivityLoading(true);
    setActivityFailure(null);

    getAuditLog(eventId).then(
      (response) => {
        setActivity(response.audit_events);
        setActivityLoading(false);
      },
      (error: unknown) => {
        // Region-scoped: the speaker list and the change form stay usable when
        // only the activity request failed (requirement 13.8).
        setActivityFailure(report(error));
        setActivityLoading(false);
      },
    );
  }, [eventId, report]);

  const openSpeaker = useMemo(
    () => speakers.find((speaker) => speaker.speaker_id === openSpeakerId) ?? null,
    [speakers, openSpeakerId],
  );

  const grouped = useMemo(() => groupSpeakers(speakers), [speakers]);

  const openDetails = useCallback(
    (speaker: Speaker) => {
      setOpenSpeakerId(speaker.speaker_id);
      setDraft(draftOf(speaker));
      setSave({ kind: "idle" });

      // The audit log is event-wide, so one response serves every speaker. It is
      // fetched on the first drawer open rather than with the page: the page
      // itself never shows it.
      if (activity === null && !activityLoading) {
        loadActivity();
      }
    },
    [activity, activityLoading, loadActivity],
  );

  const closeDetails = useCallback(() => {
    setOpenSpeakerId(null);
    setDraft(null);
    setSave({ kind: "idle" });
  }, []);

  /** Any edit puts the form back in an editable state, clearing the last result. */
  const editDraft = useCallback((change: Partial<SpeakerDraft>) => {
    setDraft((current) => (current === null ? current : { ...current, ...change }));
    setSave((current) => (current.kind === "saving" ? current : { kind: "idle" }));
  }, []);

  const pendingChanges = useMemo<SpeakerUpdate>(
    () => (openSpeaker === null || draft === null ? {} : changesIn(openSpeaker, draft)),
    [openSpeaker, draft],
  );
  const hasChanges = Object.keys(pendingChanges).length > 0;

  const submitChanges = useCallback(() => {
    if (openSpeaker === null || !hasChanges) {
      return;
    }

    const speakerId = openSpeaker.speaker_id;
    setSave({ kind: "saving" });

    updateSpeaker(eventId, speakerId, pendingChanges).then(
      () => {
        // The endpoint answers with an acknowledgement, not the record, so the
        // row is updated from the change that was accepted — never from a value
        // this page guessed at (requirement 6.5).
        setSpeakers((current) =>
          current.map((speaker) =>
            speaker.speaker_id === speakerId ? { ...speaker, ...pendingChanges } : speaker,
          ),
        );
        setSave({ kind: "saved" });
      },
      (error: unknown) => {
        const reported = report(error, { refresh: load });
        setSave(reported === null ? { kind: "idle" } : { kind: "failed", failure: reported });
      },
    );
  }, [eventId, hasChanges, load, openSpeaker, pendingChanges, report]);

  const columns = useMemo<readonly DataTableColumn<Speaker>[]>(
    () => [
      {
        key: "speaker",
        header: "Speaker",
        rowHeader: true,
        cell: (speaker) => (
          <span className="cell-stack">
            <span className="cell-stack__primary">{speaker.name}</span>
            <span className="cell-stack__meta">{speaker.email}</span>
          </span>
        ),
      },
      { key: "topic", header: "Topic", cell: (speaker) => speaker.topic },
      {
        key: "session",
        header: "Session",
        priority: "secondary",
        cell: sessionTypeLabel,
      },
      {
        key: "status",
        header: "Speaker status",
        cell: (speaker) => <StatusBadge domain="speaker" status={speaker.status} />,
      },
      {
        key: "logistics",
        header: "Logistics",
        priority: "secondary",
        cell: travelSummary,
      },
    ],
    [],
  );

  const confirmedCount = grouped.confirmed.length;
  const attentionCount = grouped.attention.length;

  return (
    <div className="page speaker-ops">
      <PageHeader
        title="SpeakerOps"
        context={
          loading || failure !== null
            ? "Speaker confirmations for this event."
            : `${attentionCount} of ${speakers.length} speakers need you. CommunityOps is handling the rest.`
        }
      />

      {failure !== null && <ApiErrorState error={failure} onRetry={load} />}

      {failure === null && loading && (
        <SkeletonTable rows={5} columns={5} label="Getting the latest speaker state…" />
      )}

      {failure === null && !loading && speakers.length === 0 && (
        <EmptyState title="No speakers yet for this event." />
      )}

      {failure === null && !loading && speakers.length > 0 && (
        <>
          <ConfirmationProgress grouped={grouped} total={speakers.length} confirmed={confirmedCount} />

          {SPEAKER_GROUPS.map((group) => {
            const members = grouped[group.id];

            return (
              <section className="page-section" key={group.id} aria-labelledby={`group-${group.id}`}>
                <div className="page-section__header">
                  <h2 className="page-section__heading" id={`group-${group.id}`}>
                    {group.heading}
                    <span className="page-section__count">{members.length}</span>
                  </h2>
                  <StatusBadge domain="operational" status={group.operationalState} />
                </div>
                <p className="page-section__description">{group.description}</p>

                {members.length === 0 ? (
                  <p className="page-section__empty">{group.emptyLine}</p>
                ) : (
                  <DataTable
                    label={group.heading}
                    columns={columns}
                    rows={members}
                    rowKey={(speaker) => speaker.speaker_id}
                    rowAction={{
                      label: "View details",
                      onSelect: openDetails,
                      accessibleLabel: (speaker) => `View details for ${speaker.name}`,
                    }}
                  />
                )}
              </section>
            );
          })}
        </>
      )}

      {openSpeaker !== null && draft !== null && (
        <Drawer
          open
          onClose={closeDetails}
          title={openSpeaker.name}
          description={openSpeaker.email}
        >
          <dl className="detail-list">
            <div className="detail-list__row">
              <dt>Status</dt>
              <dd>
                <StatusBadge
                  domain="speaker"
                  status={openSpeaker.status}
                  detail={followupDetail(openSpeaker)}
                />
              </dd>
            </div>
            <div className="detail-list__row">
              <dt>CommunityOps</dt>
              <dd>
                <StatusBadge
                  domain="operational"
                  status={SPEAKER_GROUPS.find((group) => group.id === groupOf(openSpeaker))?.operationalState ?? "CANNOT_BE_AUTOMATED"}
                />
              </dd>
            </div>
            <div className="detail-list__row">
              <dt>Topic</dt>
              <dd>{openSpeaker.topic}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Session type</dt>
              <dd>{sessionTypeLabel(openSpeaker)}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Follow-ups</dt>
              <dd>
                {openSpeaker.followup_count === 0
                  ? "None sent"
                  : `${openSpeaker.followup_count} sent by CommunityOps`}
              </dd>
            </div>
            <div className="detail-list__row">
              <dt>Travel</dt>
              <dd>{openSpeaker.travel_required ? "Required" : "Not required"}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Accommodation</dt>
              <dd>{openSpeaker.accommodation_required ? "Required" : "Not required"}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Backup</dt>
              <dd>
                {openSpeaker.is_backup
                  ? "Held in reserve as a backup speaker."
                  : "Not a backup speaker."}
              </dd>
            </div>
          </dl>

          <section className="drawer-section" aria-labelledby="speaker-activity-heading">
            <h3 className="drawer-heading" id="speaker-activity-heading">
              What CommunityOps has done
            </h3>

            {activityFailure !== null && (
              <ApiErrorState error={activityFailure} onRetry={loadActivity} />
            )}

            {activityFailure === null && activityLoading && (
              <SkeletonList items={3} leading="dot" label="Getting this speaker's activity…" />
            )}

            {activityFailure === null && !activityLoading && activity !== null && (
              <SpeakerActivity entries={activity} speakerId={openSpeaker.speaker_id} />
            )}
          </section>

          <form
            className="drawer-section"
            aria-labelledby="speaker-form-heading"
            onSubmit={(formEvent) => {
              formEvent.preventDefault();
              submitChanges();
            }}
          >
            <h3 className="drawer-heading" id="speaker-form-heading">
              Record a change
            </h3>

            {/* One `disabled` on the group locks every related control while the
                change is in flight (requirement 13.11). */}
            <fieldset className="form-fields" disabled={save.kind === "saving"}>
              <legend className="form-legend">
                Only the fields CommunityOps can hand to the speaker record.
              </legend>

              <div className="form-field">
                <label className="form-label" htmlFor={statusFieldId}>
                  Speaker status
                </label>
                <select
                  className="input"
                  id={statusFieldId}
                  value={draft.status}
                  onChange={(changeEvent) => {
                    const status = asSpeakerStatus(changeEvent.target.value);
                    if (status !== null) {
                      editDraft({ status });
                    }
                  }}
                >
                  {STATUS_OPTIONS.map((status) => (
                    <option key={status} value={status}>
                      {STATUS_OPTION_LABELS[status]}
                    </option>
                  ))}
                </select>
              </div>

              <label className="form-check">
                <input
                  type="checkbox"
                  checked={draft.travel_required}
                  onChange={(changeEvent) => {
                    editDraft({ travel_required: changeEvent.target.checked });
                  }}
                />
                Travel required
              </label>

              <label className="form-check">
                <input
                  type="checkbox"
                  checked={draft.accommodation_required}
                  onChange={(changeEvent) => {
                    editDraft({ accommodation_required: changeEvent.target.checked });
                  }}
                />
                Accommodation required
              </label>

              <label className="form-check">
                <input
                  type="checkbox"
                  checked={draft.is_backup}
                  onChange={(changeEvent) => {
                    editDraft({ is_backup: changeEvent.target.checked });
                  }}
                />
                Held in reserve as a backup speaker
              </label>
            </fieldset>

            {/* The action row is replaced by the result in place, and the result
                is announced politely (requirements 13.11, 15.7). */}
            <div className="form-actions" role="status">
              {save.kind === "saved" ? (
                <p className="form-result">
                  Change saved. This speaker&apos;s row is up to date.
                </p>
              ) : (
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={save.kind === "saving" || !hasChanges}
                >
                  {save.kind === "saving" ? "Saving…" : "Save change"}
                </button>
              )}
            </div>

            {save.kind === "failed" && <ApiErrorState error={save.failure} context="action" />}
          </form>
        </Drawer>
      )}
    </div>
  );
}

/**
 * The page's one contextual visual (requirements 6.2, 12.10): how much of the
 * roster is confirmed, segmented by the four real group counts.
 *
 * The bar, the legend and the text alternative are the shared `DistributionBar`,
 * the same component TeamOps and IncidentOps draw theirs with. This function
 * supplies only real counts, this page's four words and the sentence that states
 * the whole thing; it owns no geometry and no chrome. The four fills live in
 * `SpeakerOps.css`, keyed off `data-segment`, and none of them is a status colour
 * — that belongs to `StatusBadge` alone (requirement 12.5).
 */
function ConfirmationProgress({
  grouped,
  total,
  confirmed,
}: {
  grouped: GroupedSpeakers;
  total: number;
  confirmed: number;
}) {
  const segments = SPEAKER_GROUPS.map((group) => ({
    id: group.id,
    label: group.heading,
    count: grouped[group.id].length,
  }));

  const sentence = `${confirmed} of ${total} speakers confirmed: ${segments
    .map((segment) => `${segment.count} ${segment.label.toLowerCase()}`)
    .join(", ")}.`;

  return (
    <DistributionBar
      heading="Confirmation progress"
      headingId="speaker-progress-heading"
      segments={segments}
      sentence={sentence}
    />
  );
}

/**
 * What CommunityOps has done about one speaker, from the event's audit log
 * (requirements 6.3, 12.6).
 *
 * Filtered to the speaker's own resource id and to agent actors: the section
 * states the agent's work, and a person's own edits are the Audit Log's subject
 * rather than this drawer's.
 */
function SpeakerActivity({
  entries,
  speakerId,
}: {
  entries: readonly AuditEvent[];
  speakerId: string;
}) {
  const forSpeaker = useMemo(
    () =>
      entries.filter(
        (entry) =>
          entry.resource_type === "Speaker" &&
          entry.resource_id === speakerId &&
          entry.actor_type === "agent",
      ),
    [entries, speakerId],
  );

  return (
    <Timeline
      entries={forSpeaker.map(activityEntry)}
      label="What CommunityOps has done for this speaker"
      emptyContent={<p className="speaker-activity__empty">CommunityOps has not acted on this speaker yet.</p>}
    />
  );
}
