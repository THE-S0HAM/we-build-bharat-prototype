/**
 * Approvals — "what needs my decision, and what happens if I approve it?"
 * (design.md §8.7, requirement 5).
 *
 * This page is the product's statement about who is in charge. CommunityOps
 * *prepares* an action; a person decides it. Nothing on this page says
 * "CommunityOps decided", every recorded decision is attributed to the user, and
 * the framing line says it in one word: "Faisla aapka."
 *
 * Four things the page is deliberately built *not* to do:
 *
 *   - **It does not show a resolved table.** `approvals_handler._list_approvals`
 *     queries `GSI1` with `sk_begins_with="APPROVAL#PENDING"`, so the endpoint
 *     returns pending items and nothing else — the table this page used to render
 *     under "Resolved" could never populate (A3). It is gone. Outcomes surface
 *     through the session-scoped `RecentlyDecided` strip and the Audit Log, which
 *     really does record `APPROVAL_APPROVED` / `APPROVAL_DECLINED` /
 *     `APPROVAL_EDITED`.
 *   - **It does not render evidence.** `readEvidence` reads the object against an
 *     allowlist; the card renders that result. An unknown key — a `task_token`, a
 *     `workflow_execution_id`, anything added to the item tomorrow — reaches the
 *     page inside a count and never as text (A8, A11).
 *   - **It does not claim the workflow continues.** `_decide_approval` records the
 *     decision and never calls `SendTaskSuccess`/`SendTaskFailure`, so the Step
 *     Functions execution waiting on the task token does not resume. The copy
 *     states the outcome and stops there (A9).
 *   - **It does not fake a structured edit form.** The contract is one free-text
 *     `edited_action` (A4), so Edit is one labelled multi-line field.
 *
 * Why a settled card outlives a queue refresh
 * -------------------------------------------
 * A 409 means somebody else decided this one first: the card is replaced with
 * "This was already decided elsewhere." *and* the queue refetches (requirement
 * 5.6). Those two happen together, so the refreshed queue no longer contains the
 * approval whose replacement the user is reading. The page therefore keeps a
 * snapshot of every approval it has settled in this session and renders it
 * alongside the live queue, in its original position by `requested_at`. Without
 * that, the message the requirement asks for would flash and disappear.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { decideApproval, getApprovals } from "../api";
import { ApprovalCard } from "../approvals/ApprovalCard";
import {
  alreadyDecidedAnnouncement,
  EMPTY_QUEUE_TITLE,
  QUEUE_FRAMING,
  recordedAnnouncement,
  type ApprovalOutcome,
  type DecisionOutcome,
  type DecisionRequest,
} from "../approvals/decision";
import { RecentlyDecided, type SessionDecision } from "../approvals/RecentlyDecided";
import { ApiErrorState } from "../components/ApiErrorState";
import { EmptyState } from "../components/EmptyState";
import { Skeleton, SkeletonRegion } from "../components/Skeleton";
import { PageHeader } from "../components/PageHeader";
import type { EventScopedPageProps } from "../event/EventScopedView";
import { approvedMessage, failurePolicy, resolveCategory } from "../lib/errorCategory";
import { parseTimestamp } from "../lib/formatTime";
import { useApiFailure } from "../session/useApiFailure";
import type { Approval } from "../types";

import "./ApprovalCenter.css";

const PAGE_TITLE = "Approvals";

/** Requirement 5.12's sentence, with one line of support under it. */
const EMPTY_QUEUE_DESCRIPTION =
  "CommunityOps brings anything it cannot decide on its own here.";

const LOADING_LABEL = "Getting the decisions that need you…";

/** Names the queue region for assistive technology, below the page's one `<h1>`. */
const QUEUE_LABEL = "Decisions waiting for you";

/** How many card shapes the loading state holds. Shape only, no data. */
const SKELETON_CARDS = [0, 1];

/** The waiting count, or `null` when the empty state is already saying it. */
function waitingLine(count: number): string | null {
  if (count === 0) return null;

  return count === 1 ? "1 decision is waiting for you." : `${count} decisions are waiting for you.`;
}

/**
 * Oldest first (requirement 5.1): the longest-waiting decision is the most
 * overdue, so it leads.
 *
 * An unparseable timestamp sorts last rather than jumping the queue, and equal
 * timestamps fall back to the identifier so the order is stable across renders
 * — seeded approvals can share a `requested_at` to the millisecond.
 */
function oldestFirst(left: Approval, right: Approval): number {
  const leftTime = parseTimestamp(left.requested_at)?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightTime = parseTimestamp(right.requested_at)?.getTime() ?? Number.POSITIVE_INFINITY;

  return leftTime === rightTime
    ? left.approval_id.localeCompare(right.approval_id)
    : leftTime - rightTime;
}

export function ApprovalCenter({ eventId }: EventScopedPageProps) {
  const report = useApiFailure();

  const [queue, setQueue] = useState<readonly Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<unknown>(null);

  /** What this session did to a queued approval, keyed by `approval_id`. */
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, ApprovalOutcome>>>({});

  /** Settled approvals, kept so a queue refresh cannot remove what is on screen. */
  const [settled, setSettled] = useState<Readonly<Record<string, Approval>>>({});

  /** The session-scoped strip (requirement 5.11), newest first. */
  const [decided, setDecided] = useState<readonly SessionDecision[]>([]);

  /** Read by the live region, so a decision is announced and not only drawn. */
  const [announcement, setAnnouncement] = useState("");

  /**
   * Which fetch is current. A retry or a post-409 refresh can overlap the load
   * that is still in flight, and the older response must not overwrite the newer
   * queue.
   */
  const currentFetch = useRef(0);

  const fetchQueue = useCallback(
    (onFailure: ((error: unknown) => void) | null) => {
      const fetchId = currentFetch.current + 1;
      currentFetch.current = fetchId;

      getApprovals(eventId).then(
        (response) => {
          if (fetchId !== currentFetch.current) return;

          // The endpoint returns `APPROVAL#PENDING` items only (A3). This filter
          // is a guard rather than a feature, and it is the one place the page
          // reads `status`: a decided item arriving here would otherwise render
          // as a live decision surface.
          setQueue(response.approvals.filter((approval) => approval.status === "PENDING"));
          setLoading(false);
        },
        (error: unknown) => {
          if (fetchId !== currentFetch.current) return;

          setLoading(false);
          onFailure?.(error);
        },
      );
    },
    [eventId],
  );

  /**
   * Re-fetch the queue around a decision that turned out to be stale
   * (requirement 5.6). Its own failure is not reported: the user did not ask for
   * this fetch, and replacing the card they are reading with an error about a
   * background refresh would lose the message the 409 exists to deliver.
   */
  const refreshQueue = useCallback(() => {
    fetchQueue(null);
  }, [fetchQueue]);

  /**
   * Load the queue. No `refresh` is passed here on purpose: `refresh` is for the
   * list *around* a failure, and handing it the fetch that just failed would be
   * a retry loop rather than a refresh. A failed load offers "Try again".
   */
  const load = useCallback(() => {
    setLoading(true);
    setFailure(null);
    fetchQueue((error: unknown) => {
      setFailure(report(error));
    });
  }, [fetchQueue, report]);

  useEffect(() => {
    load();
  }, [load]);

  /** Record that this approval is no longer a decision surface. */
  const settle = useCallback((approval: Approval, outcome: ApprovalOutcome) => {
    setOutcomes((previous) => ({ ...previous, [approval.approval_id]: outcome }));
    setSettled((previous) => ({ ...previous, [approval.approval_id]: approval }));
  }, []);

  const decide = useCallback(
    async (approval: Approval, request: DecisionRequest): Promise<DecisionOutcome> => {
      try {
        await decideApproval(
          eventId,
          approval.approval_id,
          request.decision,
          request.notes,
          request.editedAction,
        );
      } catch (error: unknown) {
        const policy = failurePolicy(error);

        // The session ended. `report` clears it, the route guard takes the
        // visitor to sign-in, and nothing is rendered about it (requirement 1.8).
        if (policy.endsSession) {
          report(error);
          return { kind: "settled" };
        }

        // `refreshesList` is the categories where what is on screen is stale: the
        // 409 that means somebody else decided this first, and the 404 that means
        // the approval is gone. Reporting with `refresh` re-fetches the queue, and
        // the card stops being a decision surface either way (requirement 5.6).
        if (policy.refreshesList) {
          const reported = report(error, { refresh: refreshQueue });
          const category = resolveCategory(error);

          settle(approval, { kind: "unavailable", error: reported });
          setAnnouncement(
            category === "CONFLICT" || category === "DUPLICATE"
              ? alreadyDecidedAnnouncement(approval.title)
              : `${approval.title}: ${approvedMessage(policy, "action")}`,
          );

          return { kind: "settled" };
        }

        // Still decidable. The action row unlocks and explains itself; the
        // approval keeps its place in the queue.
        return { kind: "retryable", error: report(error) };
      }

      settle(approval, { kind: "decided", decision: request.decision });

      setDecided((previous) => [
        {
          approvalId: approval.approval_id,
          title: approval.title,
          decision: request.decision,
          requestedAction: approval.requested_action,
          decidedAt: new Date().toISOString(),
        },
        ...previous.filter((entry) => entry.approvalId !== approval.approval_id),
      ]);

      setAnnouncement(recordedAnnouncement(approval.title, request.decision));

      return { kind: "settled" };
    },
    [eventId, refreshQueue, report, settle],
  );

  /**
   * The queue as rendered: what the endpoint returned, plus every approval this
   * session settled that the endpoint no longer returns, in `requested_at` order
   * so a settled card keeps the position it had when it was decided.
   */
  const cards = useMemo(() => {
    const byId = new Map<string, Approval>();

    for (const approval of queue) {
      byId.set(approval.approval_id, approval);
    }
    for (const [approvalId, approval] of Object.entries(settled)) {
      if (!byId.has(approvalId)) byId.set(approvalId, approval);
    }

    return [...byId.values()].sort(oldestFirst);
  }, [queue, settled]);

  const pendingCount = cards.filter((approval) => outcomes[approval.approval_id] === undefined).length;
  const context = loading || failure !== null ? QUEUE_FRAMING : [QUEUE_FRAMING, waitingLine(pendingCount)].filter((part) => part !== null).join(" ");

  return (
    <div className="page approvals">
      {/* One `<h1>` for the page, and "Faisla aapka." exactly once, as the
          queue's framing line (requirements 15.1, 5.13). */}
      <PageHeader title={PAGE_TITLE} context={context} />

      {/* Results are announced, not only drawn (requirement 15.8). The region is
          in the DOM from first render so a later decision is reported rather than
          arriving with the element that carries it. */}
      <p className="approvals__announcement" role="status" aria-live="polite">
        {announcement}
      </p>

      <RecentlyDecided decisions={decided} />

      {failure !== null && <ApiErrorState error={failure} onRetry={load} />}

      {loading && (
        <SkeletonRegion label={LOADING_LABEL}>
          <div className="approvals__skeleton">
            {SKELETON_CARDS.map((key) => (
              <div className="card approvals__skeleton-card" key={key}>
                <Skeleton shape="heading" width="half" />
                <Skeleton shape="line" />
                <Skeleton shape="line" width="wide" />
                <Skeleton shape="pill" width="tiny" />
              </div>
            ))}
          </div>
        </SkeletonRegion>
      )}

      {!loading && failure === null && cards.length === 0 && (
        <EmptyState title={EMPTY_QUEUE_TITLE} description={EMPTY_QUEUE_DESCRIPTION} />
      )}

      {cards.length > 0 && (
        <section className="approvals__queue" aria-label={QUEUE_LABEL}>
          {cards.map((approval) => (
            <ApprovalCard
              key={approval.approval_id}
              approval={approval}
              outcome={outcomes[approval.approval_id] ?? null}
              onDecide={(request) => decide(approval, request)}
            />
          ))}
        </section>
      )}
    </div>
  );
}
