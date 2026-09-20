/**
 * IncidentOps — "What could disrupt the event, and what does CommunityOps
 * propose?" (design.md §8.5, requirement 8).
 *
 * The page this replaced was a stack of incident cards, every card carrying its
 * recommendation in a tinted panel. Two things were wrong with that. Cards in
 * API order put a LOW-severity note above a CRITICAL one, and a page-level
 * recommendation panel asks the leader to read the agent's reasoning before they
 * have decided anything — the opposite of deciding on a prepared proposal.
 *
 * So:
 *
 *   - The list is a severity-ordered table, CRITICAL first, with resolved
 *     incidents collapsed below the active ones (requirement 8.1). Every row
 *     answers severity, affected resource, where it stands and what happens next
 *     (requirement 8.2).
 *   - One contextual visual: the severity distribution over the real counts, with
 *     every number also stated in words beside it (requirements 8.3, 12.10).
 *   - The recommendation lives **inside the drawer** and nowhere else
 *     (requirement 8.5). It is not a headline card, and no row previews it. The
 *     drawer is the product's one progressive-disclosure surface (requirement
 *     12.6), so "View details" here behaves as it does on every other route.
 *   - A pending approval is shown against an incident only when its
 *     `affected_resource_id` matches the incident id, and the page says that the
 *     link was derived that way (requirement 8.6). `approval_id` is not a field
 *     the incidents endpoint accepts or returns, so there is no stored
 *     relationship to render.
 *
 * Colour discipline: severity goes through `RiskIndicator`, which owns the four
 * levels and reserves the red for CRITICAL. `Incident.status` is typed `string`
 * rather than a union, so there is no status→colour domain for it — it renders as
 * text, and the item's one operational state (requirement 12.9) renders through
 * `StatusBadge`. This page maps nothing to a colour of its own.
 *
 * Everything the page decides about an incident — order, the next action, the
 * analysis fields — is in `./incidentModel.ts`.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { addIncidentComment, getIncident, getApprovals, getIncidents, reopenIncident, resolveIncident, updateIncident } from "../api";
import { ApiErrorState } from "../components/ApiErrorState";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { DistributionBar } from "../components/DistributionBar";
import { Drawer } from "../components/Drawer";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { RiskIndicator } from "../components/RiskIndicator";
import { SkeletonTable } from "../components/Skeleton";
import { StatusBadge } from "../components/StatusBadge";
import type { EventScopedPageProps } from "../event/EventScopedView";
import { formatAbsoluteTime, formatRelativeTime } from "../lib/formatTime";
import { APPROVALS_PATH } from "../navConfig";
import { useApiFailure } from "../session/useApiFailure";
import { useSession } from "../session/sessionContext";
import type { Approval, Incident, IncidentComment } from "../types";
import type { GenericIncidentStatus } from "../types";
type IncidentUpdate = Partial<Pick<Incident, "severity">> & {
  status?: GenericIncidentStatus;
};
import {
  affectedResourceLabel,
  derivedApprovalsFor,
  isResolved,
  orderIncidents,
  readIncidentAnalysis,
  severityDistribution,
  severityLabel,
  SEVERITY_ORDER,
  statusOptionLabel,
  statusReading,
  resolvedTimestamp,
  type IncidentImpact,
  type SeverityShare,
} from "./incidentModel";
import "./IncidentCenter.css";
import "./OperationalPages.css";

/** The editable fields, as the change form holds them. */
interface IncidentDraft {
  readonly status: string;
  readonly severity: Incident["severity"];
}

const GENERIC_EDITABLE_STATUSES: readonly GenericIncidentStatus[] = [
  "REPORTED",
  "DETECTED",
  "ACKNOWLEDGED",
  "ANALYZING",
  "RECOMMENDATION_READY",
  "AWAITING_APPROVAL",
  "APPROVED",
  "EXECUTING",
];
function isGenericEditableIncidentStatus(value: string): value is GenericIncidentStatus {
  return GENERIC_EDITABLE_STATUSES.some((status) => status === value);
}

function draftOf(incident: Incident): IncidentDraft {
  return { status: incident.status, severity: incident.severity };
}

/** Only what the user actually changed, so an untouched field is never sent. */
function changesIn(incident: Incident, draft: IncidentDraft): IncidentUpdate {
  const changes: IncidentUpdate = {};

  if (draft.status !== incident.status && isGenericEditableIncidentStatus(draft.status)) changes.status = draft.status;
  if (draft.severity !== incident.severity) changes.severity = draft.severity;

  return changes;
}

/** Reads a `<select>` value back into the severity union it came from. */
function asSeverity(value: string): Incident["severity"] | null {
  return SEVERITY_ORDER.find((severity) => severity === value) ?? null;
}

/** Where a change is in its lifecycle (requirement 13.11). */
type SaveState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
  | { readonly kind: "failed"; readonly failure: unknown };

export function IncidentCenter({ eventId }: EventScopedPageProps) {
  const report = useApiFailure();
  const { user } = useSession();
  const isLeader = user?.role === "LEADER";

  const [incidents, setIncidents] = useState<readonly Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<unknown>(null);

  /**
   * Pending approvals for the event, for the derived linkage only. Region-scoped:
   * its own failure state, so the incident list stays usable when just this
   * request failed (requirement 13.8).
   */
  const [approvals, setApprovals] = useState<readonly Approval[]>([]);
  const [approvalFailure, setApprovalFailure] = useState<unknown>(null);

  const [openIncidentId, setOpenIncidentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<IncidentDraft | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [comments, setComments] = useState<IncidentComment[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailFailure, setDetailFailure] = useState<unknown>(null);
  const [commentBody, setCommentBody] = useState("");
  const [createTaskFromComment, setCreateTaskFromComment] = useState(false);
  const [commentTaskTeam, setCommentTaskTeam] = useState("");
  const [commentTaskTitle, setCommentTaskTitle] = useState("");
  const [commentSaving, setCommentSaving] = useState(false);
  const [commentFailure, setCommentFailure] = useState<unknown>(null);
  const [transitionFeedback, setTransitionFeedback] = useState("");
  const [lifecycleSaving, setLifecycleSaving] = useState(false);
  const lifecycleMutationLock = useRef(false);
  const [resolutionSummary, setResolutionSummary] = useState("");
  const [rootCause, setRootCause] = useState("");
  const [actionsTaken, setActionsTaken] = useState("");
  const [resolvedOpen, setResolvedOpen] = useState(false);

  const statusFieldId = useId();
  const severityFieldId = useId();
  const resolvedRegionId = useId();

  const load = useCallback(() => {
    setLoading(true);
    setFailure(null);

    getIncidents(eventId).then(
      (response) => {
        setIncidents(response.incidents);
        setLoading(false);
      },
      (error: unknown) => {
        setFailure(report(error));
        setLoading(false);
      },
    );
  }, [eventId, report]);

  useEffect(load, [load]);

  const loadApprovals = useCallback(() => {
    setApprovalFailure(null);

    getApprovals(eventId).then(
      (response) => {
        setApprovals(response.approvals);
      },
      (error: unknown) => {
        setApprovals([]);
        setApprovalFailure(report(error));
      },
    );
  }, [eventId, report]);

  useEffect(loadApprovals, [loadApprovals]);

  const { active, resolved } = useMemo(() => orderIncidents(incidents), [incidents]);
  const distribution = useMemo(() => severityDistribution(incidents), [incidents]);

  const openIncident = useMemo(
    () => incidents.find((incident) => incident.incident_id === openIncidentId) ?? null,
    [incidents, openIncidentId],
  );

  const openDetails = useCallback((incident: Incident) => {
    setOpenIncidentId(incident.incident_id);
    setDraft(draftOf(incident));
    setSave({ kind: "idle" });
    setComments([]);
    setDetailLoading(true);
    setDetailFailure(null);
    setTransitionFeedback("");
    getIncident(eventId, incident.incident_id).then(
      (detail) => {
        setIncidents((current) => current.map((item) => item.incident_id === incident.incident_id ? detail.incident : item));
        setComments(detail.comments);
        setDraft(draftOf(detail.incident));
        setDetailLoading(false);
      },
      (error: unknown) => { setDetailFailure(report(error)); setDetailLoading(false); },
    );
  }, [eventId, report]);

  const closeDetails = useCallback(() => {
    setOpenIncidentId(null);
    setDraft(null);
    setSave({ kind: "idle" });
    setComments([]);
    setCommentBody("");
    setTransitionFeedback("");
  }, []);

  /** Any edit puts the form back in an editable state, clearing the last result. */
  const editDraft = useCallback((change: Partial<IncidentDraft>) => {
    setDraft((current) => (current === null ? current : { ...current, ...change }));
    setSave((current) => (current.kind === "saving" ? current : { kind: "idle" }));
  }, []);

  const pendingChanges = useMemo<IncidentUpdate>(
    () => (openIncident === null || draft === null ? {} : changesIn(openIncident, draft)),
    [openIncident, draft],
  );
  const hasChanges = Object.keys(pendingChanges).length > 0;

  const submitChanges = useCallback(() => {
    if (openIncident === null || !hasChanges) {
      return;
    }

    const incidentId = openIncident.incident_id;
    setSave({ kind: "saving" });

    updateIncident(eventId, incidentId, pendingChanges).then(
      () => {
        // The endpoint answers with an acknowledgement, not the record, so the row
        // is updated from the change that was accepted — never from a value this
        // page guessed at (requirement 8.8).
        setIncidents((current) =>
          current.map((incident) =>
            incident.incident_id === incidentId ? { ...incident, ...pendingChanges } : incident,
          ),
        );
        setSave({ kind: "saved" });
      },
      (error: unknown) => {
        const reported = report(error, { refresh: load });
        setSave(reported === null ? { kind: "idle" } : { kind: "failed", failure: reported });
      },
    );
  }, [eventId, hasChanges, load, openIncident, pendingChanges, report]);

  const submitComment = useCallback(() => {
    if (openIncident === null || commentSaving || commentBody.trim() === "") return;
    setCommentSaving(true); setCommentFailure(null);
    addIncidentComment(eventId, openIncident.incident_id, {
      body: commentBody.trim(),
      ...(createTaskFromComment ? { create_task: true, task_team_id: commentTaskTeam.trim(), task_title: commentTaskTitle.trim() } : {}),
    }).then(
      () => getIncident(eventId, openIncident.incident_id),
    ).then(
      (detail) => { setComments(detail.comments); setCommentBody(""); setCreateTaskFromComment(false); setCommentTaskTitle(""); setCommentTaskTeam(""); setCommentSaving(false); },
      (error: unknown) => { setCommentFailure(report(error)); setCommentSaving(false); },
    );
  }, [commentBody, commentSaving, commentTaskTeam, commentTaskTitle, createTaskFromComment, eventId, openIncident, report]);

  const refreshAfterLifecycleMutation = useCallback(async (incidentId: string): Promise<void> => {
    const [detail, refreshed] = await Promise.all([
      getIncident(eventId, incidentId),
      getIncidents(eventId),
    ]);

    setIncidents(
      refreshed.incidents.map((item) =>
        item.incident_id === incidentId ? detail.incident : item,
      ),
    );
    setComments(detail.comments);
    setDraft(draftOf(detail.incident));
    setDetailFailure(null);
  }, [eventId]);

  const resolveOpenIncident = useCallback(async () => {
    if (
      openIncident === null ||
      resolutionSummary.trim() === "" ||
      lifecycleMutationLock.current
    ) return;

    const incidentId = openIncident.incident_id;
    lifecycleMutationLock.current = true;
    setLifecycleSaving(true);
    setDetailFailure(null);
    setTransitionFeedback("");

    try {
      const result = await resolveIncident(eventId, incidentId, {
        resolution_summary: resolutionSummary.trim(),
        ...(rootCause.trim() ? { root_cause: rootCause.trim() } : {}),
        ...(actionsTaken.trim() ? { actions_taken: actionsTaken.split("\n").map((line) => line.trim()).filter(Boolean) } : {}),
      });
      await refreshAfterLifecycleMutation(incidentId);
      setTransitionFeedback(result.message);
    } catch (error: unknown) {
      setDetailFailure(report(error) ?? error);
    } finally {
      lifecycleMutationLock.current = false;
      setLifecycleSaving(false);
    }
  }, [actionsTaken, eventId, openIncident, refreshAfterLifecycleMutation, report, resolutionSummary, rootCause]);

  const reopenOpenIncident = useCallback(async () => {
    if (openIncident === null || lifecycleMutationLock.current) return;

    const incidentId = openIncident.incident_id;
    lifecycleMutationLock.current = true;
    setLifecycleSaving(true);
    setDetailFailure(null);
    setTransitionFeedback("");

    try {
      const result = await reopenIncident(eventId, incidentId);
      await refreshAfterLifecycleMutation(incidentId);
      setTransitionFeedback(result.message);
    } catch (error: unknown) {
      setDetailFailure(report(error) ?? error);
    } finally {
      lifecycleMutationLock.current = false;
      setLifecycleSaving(false);
    }
  }, [eventId, openIncident, refreshAfterLifecycleMutation, report]);

  const columns = useMemo<readonly DataTableColumn<Incident>[]>(
    () => [
      {
        key: "incident",
        header: "Incident",
        rowHeader: true,
        cell: (incident) => (
          <span className="cell-stack">
            <span className="cell-stack__primary">{incident.title}</span>
            <span className="cell-stack__meta">
              Detected {formatRelativeTime(incident.detected_at)}
            </span>
          </span>
        ),
      },
      {
        key: "severity",
        header: "Severity",
        // RiskIndicator always renders the level as text, so severity survives
        // without colour (requirement 15.10).
        cell: (incident) => <RiskIndicator level={incident.severity} />,
      },
      {
        key: "affected",
        header: "Affected resource",
        priority: "secondary",
        cell: (incident) => affectedResourceLabel(incident) ?? "Not recorded",
      },
      {
        key: "status",
        header: "Incident status",
        // Text, not a badge: `Incident.status` is typed `string` in
        // `src/types.ts`, so `StatusBadge` has no domain for it and this page is
        // not allowed to invent a colour mapping (requirement 12.5).
        cell: (incident) => (
          <span className="incident-status">{statusReading(incident).label}</span>
        ),
      },
      {
        key: "next",
        header: "Next action",
        cell: (incident) => {
          const reading = statusReading(incident);

          return (
            <span className="incident-next">
              <StatusBadge domain="operational" status={reading.operationalState} />
              <span className="incident-next__action">{reading.nextAction}</span>
            </span>
          );
        },
      },
    ],
    [],
  );

  const rowAction = useMemo(
    () => ({
      label: "View details",
      onSelect: openDetails,
      accessibleLabel: (incident: Incident) => `View details for ${incident.title}`,
    }),
    [openDetails],
  );

  const analysis = openIncident === null ? null : readIncidentAnalysis(openIncident);
  const openReading = openIncident === null ? null : statusReading(openIncident);
  const openResolvedAt = openIncident === null ? null : resolvedTimestamp(openIncident);
  const derivedApprovals =
    openIncident === null ? [] : derivedApprovalsFor(openIncident, approvals);

  return (
    <div className="page incident-ops">
      <PageHeader
        title="IncidentOps"
        context={
          loading || failure !== null
            ? "What could disrupt this event."
            : `${active.length} active ${active.length === 1 ? "incident" : "incidents"}. CommunityOps has a proposal ready for each one it can act on.`
        }
      />

      {failure !== null && <ApiErrorState error={failure} onRetry={load} />}

      {failure === null && loading && (
        <SkeletonTable rows={4} columns={5} label="Getting the latest incident state…" />
      )}

      {failure === null && !loading && incidents.length === 0 && (
        <EmptyState title="No incidents for this event." />
      )}

      {failure === null && !loading && incidents.length > 0 && (
        <>
          <SeverityDistribution
            segments={distribution}
            total={incidents.length}
            resolvedCount={resolved.length}
          />

          <section className="page-section incident-section" aria-labelledby="incident-active-heading">
            <h2 className="page-section__heading" id="incident-active-heading">
              Active
              <span className="page-section__count">{active.length}</span>
            </h2>
            <p className="page-section__description">
              Most severe first. Open one to see what CommunityOps proposes.
            </p>

            {active.length === 0 ? (
              <p className="page-section__empty">
                Nothing active. Every incident for this event is resolved.
              </p>
            ) : (
              <DataTable
                label="Active incidents"
                columns={columns}
                rows={active}
                rowKey={(incident) => incident.incident_id}
                rowAction={rowAction}
              />
            )}
          </section>

          {resolved.length > 0 && (
            <section className="page-section incident-section" aria-labelledby="incident-resolved-heading">
              <div className="page-section__header">
                <h2 className="page-section__heading" id="incident-resolved-heading">
                  Resolved
                  <span className="page-section__count">{resolved.length}</span>
                </h2>

                {/* Collapsed below the active list (requirement 8.1). This is a
                    section toggle over rows the distribution already counts, not
                    a second detail surface: a record's own detail is only ever
                    the shared `Drawer` (requirement 12.6). */}
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-expanded={resolvedOpen}
                  aria-controls={resolvedRegionId}
                  onClick={() => {
                    setResolvedOpen((open) => !open);
                  }}
                >
                  {resolvedOpen ? "Hide resolved" : `Show ${resolved.length} resolved`}
                </button>
              </div>

              <div id={resolvedRegionId}>
                {resolvedOpen ? (
                  <DataTable
                    label="Resolved incidents"
                    columns={columns}
                    rows={resolved}
                    rowKey={(incident) => incident.incident_id}
                    rowAction={rowAction}
                  />
                ) : (
                  <p className="page-section__description">
                    {resolved.length === 1
                      ? "1 resolved incident is kept out of the way."
                      : `${resolved.length} resolved incidents are kept out of the way.`}
                  </p>
                )}
              </div>
            </section>
          )}
        </>
      )}

      {openIncident !== null && analysis !== null && openReading !== null && draft !== null && (
        <Drawer
          open
          onClose={closeDetails}
          title={openIncident.title}
          description={openIncident.incident_id}
        >
          <p className="drawer-description">{openIncident.description}</p>

          <dl className="detail-list">
            <div className="detail-list__row">
              <dt>Severity</dt>
              <dd>
                <RiskIndicator level={openIncident.severity} />
              </dd>
            </div>
            <div className="detail-list__row">
              <dt>Incident status</dt>
              <dd>
                <span className="incident-status">{openReading.label}</span>
              </dd>
            </div>
            <div className="detail-list__row">
              <dt>CommunityOps</dt>
              <dd>
                <StatusBadge
                  domain="operational"
                  status={openReading.operationalState}
                  detail={openReading.nextAction}
                />
              </dd>
            </div>
            <div className="detail-list__row">
              <dt>Affected resource</dt>
              <dd>{affectedResourceLabel(openIncident) ?? "Not recorded"}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Detected</dt>
              <dd>{formatAbsoluteTime(openIncident.detected_at)}</dd>
            </div>
            {openResolvedAt !== null && (
              <div className="detail-list__row">
                <dt>Resolved</dt>
                <dd>{formatAbsoluteTime(openResolvedAt)}</dd>
              </div>
            )}
          </dl>

          {/* The proposal, reachable only from here (requirement 8.5). */}
          <section className="drawer-section" aria-labelledby="incident-proposal-heading">
            <h3 className="drawer-heading" id="incident-proposal-heading">
              What CommunityOps proposes
            </h3>

            {openIncident.recommendation.trim() === "" ? (
              <p className="incident-proposal__empty">
                CommunityOps has not proposed a response yet.
              </p>
            ) : (
              <>
                <p className="incident-proposal__body">{openIncident.recommendation}</p>
                <p className="incident-proposal__state">
                  Proposal state: <strong>{openReading.label}</strong>. {openReading.nextAction}
                </p>
              </>
            )}

            <h4 className="drawer-subheading">Backup options</h4>
            {openIncident.backup_options.length === 0 ? (
              <p className="incident-proposal__empty">No backup options recorded.</p>
            ) : (
              <ul className="incident-list" aria-label="Backup options">
                {openIncident.backup_options.map((option) => (
                  <li className="incident-list__item" key={option}>
                    {option}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="drawer-section" aria-labelledby="incident-impact-heading">
            <h3 className="drawer-heading" id="incident-impact-heading">
              Impact analysis
            </h3>
            <ImpactAnalysis impact={analysis.impact} />

            <h4 className="drawer-subheading">Dependencies</h4>
            {analysis.dependencies.length === 0 ? (
              <p className="incident-analysis__empty">
                No other resources are recorded as affected.
              </p>
            ) : (
              <ul className="incident-list" aria-label="Dependencies">
                {analysis.dependencies.map((dependency) => (
                  <li className="incident-list__item" key={dependency}>
                    {dependency}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {analysis.resolutionSummary !== null && (
            <section className="drawer-section" aria-labelledby="incident-resolution-heading">
              <h3 className="drawer-heading" id="incident-resolution-heading">
                How it was resolved
              </h3>
              <p className="incident-analysis__body">{analysis.resolutionSummary}</p>
            </section>
          )}

          <section className="drawer-section" aria-labelledby="incident-discussion-heading">
            <h3 className="drawer-heading" id="incident-discussion-heading">Discussion</h3>
            {detailLoading && <p role="status">Getting comments…</p>}
            {detailFailure !== null && <ApiErrorState error={detailFailure} context="action" />}
            {!detailLoading && detailFailure === null && comments.length === 0 && <p className="incident-analysis__empty">No comments yet.</p>}
            {comments.length > 0 && <ul className="ops-list">{comments.map((comment) => <li className="ops-list__item" key={comment.comment_id}><p className="ops-list__title">{comment.author_type === "agent" ? "CommunityOps" : comment.author_name || "Team member"}</p><p>{comment.body}</p><p className="ops-list__meta">{comment.created_at}{comment.created_task_id ? ` · created task ${comment.created_task_id}` : ""}</p></li>)}</ul>}
            <form className="ops-form" onSubmit={(event) => { event.preventDefault(); submitComment(); }}>
              <label className="form-label" htmlFor="incident-comment">Add a comment</label>
              <textarea className="input" id="incident-comment" rows={3} value={commentBody} onChange={(event) => setCommentBody(event.target.value)} disabled={commentSaving} />
              <label className="form-check"><input type="checkbox" checked={createTaskFromComment} onChange={(event) => setCreateTaskFromComment(event.target.checked)} /> Create a linked task from this comment</label>
              {createTaskFromComment && <><label className="form-label" htmlFor="comment-task-team">Task team ID</label><input className="input" id="comment-task-team" value={commentTaskTeam} onChange={(event) => setCommentTaskTeam(event.target.value)} /><label className="form-label" htmlFor="comment-task-title">Task title</label><input className="input" id="comment-task-title" value={commentTaskTitle} onChange={(event) => setCommentTaskTitle(event.target.value)} /></>}
              <button className="btn" type="submit" disabled={commentSaving || !commentBody.trim() || (createTaskFromComment && (!commentTaskTeam.trim() || !commentTaskTitle.trim()))}>{commentSaving ? "Adding…" : "Add comment"}</button>
              {commentFailure !== null && <ApiErrorState error={commentFailure} context="action" />}
            </form>
          </section>

          {isLeader && <section className="drawer-section" aria-labelledby="incident-transition-heading">
            <h3 className="drawer-heading" id="incident-transition-heading">Resolution</h3>
            {isResolved(openIncident) ? (
              <button className="btn" type="button" onClick={reopenOpenIncident} disabled={lifecycleSaving}>
                {lifecycleSaving ? "Reopening…" : "Reopen incident"}
              </button>
            ) : (
              <form className="ops-form" onSubmit={(event) => { event.preventDefault(); resolveOpenIncident(); }}>
                <fieldset className="form-fields" disabled={lifecycleSaving}>
                  <label className="form-label" htmlFor="resolution-summary">Resolution summary</label>
                  <textarea className="input" id="resolution-summary" rows={3} required value={resolutionSummary} onChange={(event) => setResolutionSummary(event.target.value)} />
                  <label className="form-label" htmlFor="root-cause">Root cause</label>
                  <textarea className="input" id="root-cause" rows={2} value={rootCause} onChange={(event) => setRootCause(event.target.value)} />
                  <label className="form-label" htmlFor="actions-taken">Actions taken, one per line</label>
                  <textarea className="input" id="actions-taken" rows={3} value={actionsTaken} onChange={(event) => setActionsTaken(event.target.value)} />
                  <button className="btn btn-primary" type="submit" disabled={!resolutionSummary.trim()}>{lifecycleSaving ? "Resolving…" : "Resolve incident"}</button>
                </fieldset>
              </form>
            )}
            {transitionFeedback && <p className="form-result" role="status">{transitionFeedback}</p>}
          </section>}

          <DerivedApprovals
            approvals={derivedApprovals}
            failure={approvalFailure}
            onRetry={loadApprovals}
          />

          {isGenericEditableIncidentStatus(openIncident.status) && (
          <form
            className="drawer-section"
            aria-labelledby="incident-form-heading"
            onSubmit={(formEvent) => {
              formEvent.preventDefault();
              submitChanges();
            }}
          >
            <h3 className="drawer-heading" id="incident-form-heading">
              Record a change
            </h3>

            {/* One `disabled` on the group locks every related control while the
                change is in flight (requirement 13.11). */}
            <fieldset className="form-fields" disabled={save.kind === "saving" || lifecycleSaving}>
              <legend className="form-legend">
                Where this incident stands, and how severe it is. CommunityOps&apos; own analysis
                stays as it recorded it.
              </legend>

              <div className="form-field">
                <label className="form-label" htmlFor={statusFieldId}>
                  Incident status
                </label>
                <select
                  className="input"
                  id={statusFieldId}
                  value={draft.status}
                  onChange={(changeEvent) => {
                    editDraft({ status: changeEvent.target.value });
                  }}
                >
                  {GENERIC_EDITABLE_STATUSES.filter((status) => isLeader || status === "ACKNOWLEDGED" || status === "ANALYZING").map((status) => (
                    <option key={status} value={status}>
                      {statusOptionLabel(status)}
                    </option>
                  ))}
                </select>
              </div>

              {isLeader && <div className="form-field">
                <label className="form-label" htmlFor={severityFieldId}>
                  Severity
                </label>
                <select
                  className="input"
                  id={severityFieldId}
                  value={draft.severity}
                  onChange={(changeEvent) => {
                    const severity = asSeverity(changeEvent.target.value);
                    if (severity !== null) {
                      editDraft({ severity });
                    }
                  }}
                >
                  {SEVERITY_ORDER.map((severity) => (
                    <option key={severity} value={severity}>
                      {severityLabel(severity)}
                    </option>
                  ))}
                </select>
              </div>}
            </fieldset>

            {/* The action row is replaced by the result in place, and the result is
                announced politely (requirements 13.11, 15.7). */}
            <div className="form-actions" role="status">
              {save.kind === "saved" ? (
                <p className="form-result">
                  Change saved. This incident&apos;s row is up to date.
                </p>
              ) : (
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={save.kind === "saving" || lifecycleSaving || !hasChanges}
                >
                  {save.kind === "saving" ? "Saving…" : "Save change"}
                </button>
              )}
            </div>

            {save.kind === "failed" && <ApiErrorState error={save.failure} context="action" />}
          </form>
          )}
        </Drawer>
      )}
    </div>
  );
}

/**
 * The page's one contextual visual (requirements 8.3, 12.10): how the event's
 * incidents are distributed across the four severity levels, from the real
 * counts.
 *
 * The strip, the legend and the text alternative are the shared
 * `DistributionBar`, the same component SpeakerOps and TeamOps draw theirs with.
 * This function supplies only the real counts, the four severity words and the
 * sentence that states the whole thing; it owns no geometry and no chrome. The
 * four fills live in `IncidentCenter.css`, keyed off `data-segment`, and their
 * escalation mirrors design.md §6.4 — neutral, then attention, then the red only
 * at CRITICAL.
 */
function SeverityDistribution({
  segments,
  total,
  resolvedCount,
}: {
  segments: readonly SeverityShare[];
  total: number;
  resolvedCount: number;
}) {
  const counted = segments
    .map((segment) => `${segment.count} ${segment.label.toLowerCase()}`)
    .join(", ");
  const resolvedSentence =
    resolvedCount === 0
      ? "None are resolved yet."
      : resolvedCount === 1
        ? "1 of them is resolved."
        : `${resolvedCount} of them are resolved.`;

  return (
    <DistributionBar
      heading="Severity distribution"
      headingId="incident-severity-heading"
      segments={segments.map((segment) => ({
        id: segment.severity,
        label: segment.label,
        count: segment.count,
      }))}
      sentence={`${total} ${total === 1 ? "incident" : "incidents"}: ${counted}. ${resolvedSentence}`}
    />
  );
}

/**
 * `impact_analysis` as something a person can read.
 *
 * The workflow writes this field with `json.dumps`, so it is often a JSON object.
 * Raw JSON is never rendered (A11): recognised keys become labelled rows, and
 * everything else CommunityOps recorded is counted so the reader knows the
 * console is not showing all of it. `./incidentModel.ts` does the reading.
 */
function ImpactAnalysis({ impact }: { impact: IncidentImpact }) {
  if (impact.kind === "absent") {
    return <p className="incident-analysis__empty">CommunityOps has not recorded an impact analysis.</p>;
  }

  if (impact.kind === "prose") {
    return <p className="incident-analysis__body">{impact.text}</p>;
  }

  return (
    <>
      {impact.rows.length === 0 ? (
        <p className="incident-analysis__empty">
          CommunityOps recorded an impact analysis in a form this console does not display.
        </p>
      ) : (
        <dl className="detail-list">
          {impact.rows.map((row) => (
            <div className="detail-list__row" key={row.key}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {impact.undisplayedCount > 0 && impact.rows.length > 0 && (
        <p className="incident-analysis__counted">
          {impact.undisplayedCount === 1
            ? "1 further detail was recorded that this console does not display."
            : `${impact.undisplayedCount} further details were recorded that this console does not display.`}
        </p>
      )}
    </>
  );
}

/**
 * The derived approval linkage (requirement 8.6).
 *
 * `approval_id` is not an allowed field on `PUT /events/{id}/incidents/{id}` and
 * the incidents response carries no approval reference, so nothing links these
 * two records in the data. The match is made here, on
 * `affected_resource_id`, and the copy says so: presenting a computed match as a
 * recorded relationship would be the console claiming a fact the backend has not
 * established.
 */
function DerivedApprovals({
  approvals,
  failure,
  onRetry,
}: {
  approvals: readonly Approval[];
  failure: unknown;
  onRetry: () => void;
}) {
  return (
    <section className="drawer-section" aria-labelledby="incident-derived-heading">
      <h3 className="drawer-heading" id="incident-derived-heading">
        Related approval
      </h3>

      {failure !== null && <ApiErrorState error={failure} onRetry={onRetry} />}

      {failure === null && approvals.length === 0 && (
        <p className="incident-derived__empty">
          No pending approval names this incident as its affected resource.
        </p>
      )}

      {failure === null && approvals.length > 0 && (
        <>
          <p className="incident-derived__note">
            Derived: incidents carry no stored approval reference, so this match was made by
            comparing each pending approval&apos;s affected resource with this incident&apos;s
            identifier.
          </p>

          <ul className="incident-derived__list">
            {approvals.map((approval) => (
              <li className="incident-derived__item" key={approval.approval_id}>
                <span className="incident-derived__title">{approval.title}</span>
                <span className="incident-derived__states">
                  <StatusBadge domain="approval" status={approval.status} />
                  <RiskIndicator level={approval.risk_level} />
                </span>
                <span className="incident-derived__agent">
                  Raised by CommunityOps as {approval.agent_name}
                </span>
              </li>
            ))}
          </ul>

          <Link className="incident-derived__link" to={APPROVALS_PATH}>
            Go to Approvals
          </Link>
        </>
      )}
    </section>
  );
}
