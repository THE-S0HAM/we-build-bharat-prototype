/**
 * Approvals.
 *
 * Answers: what decisions are waiting for me? Each item states what, why, the risk and the action.
 *
 * Two things this screen is careful about:
 *
 * **Authority attribution.** The copy says "CommunityOps prepared this action", never "decided".
 * That is not decoration — the product's claim is that consequential actions stop for a human, and
 * language that implies the agent already chose would undermine the thing being demonstrated.
 *
 * **The budget figure.** After approving, the remaining balance shown comes from the decision
 * response, which carries the recomputed budget. The frontend never subtracts the amount itself: a
 * locally computed figure could differ from what the backend actually committed — if a concurrent
 * change or a category limit altered the outcome, the optimistic number would be quietly wrong, and
 * money is the one place a plausible wrong number is worse than an error.
 */

import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  decideApproval,
  formatInrWithSymbol,
  formatRelative,
  getApprovals,
  humanize,
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
  SeverityBadge,
  StatusBadge,
  Tabs,
} from "../components/primitives";
import type { Approval, BudgetSummary, Role } from "../types";

type Filter = "pending" | "decided";

export function ApprovalsPage({
  eventId,
  role,
  onDecided,
}: {
  eventId: string;
  role: Role;
  onDecided: () => void;
}) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [filter, setFilter] = useState<Filter>("pending");

  const [selected, setSelected] = useState<Approval | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState<string | undefined>();
  const [notes, setNotes] = useState("");
  const [editing, setEditing] = useState(false);
  const [editedAction, setEditedAction] = useState("");

  /** The budget as the backend reported it after the last decision. Displayed, never derived. */
  const [budgetAfter, setBudgetAfter] = useState<BudgetSummary | null>(null);
  const [outcome, setOutcome] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await getApprovals(eventId);
      setApprovals(response.approvals);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load approvals.");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  function openApproval(approval: Approval) {
    setSelected(approval);
    setNotes("");
    setEditing(false);
    setEditedAction(approval.edited_action || approval.requested_action);
    setDecisionError(undefined);
    setOutcome(undefined);
    setBudgetAfter(null);
  }

  async function decide(decision: "APPROVED" | "DECLINED" | "EDITED") {
    if (!selected) return;
    setDeciding(true);
    setDecisionError(undefined);
    try {
      const response = await decideApproval(eventId, selected.approval_id, decision, {
        notes: notes.trim() || undefined,
        edited_action: decision === "EDITED" ? editedAction.trim() : undefined,
      });

      // The authoritative post-decision budget, straight from the response.
      if (response.budget) setBudgetAfter(response.budget);
      setOutcome(response.message);

      // Reload so the list reflects the new status and the shell's count updates.
      await load();
      onDecided();

      setSelected((current) =>
        current ? { ...current, status: response.status } : current,
      );
    } catch (err) {
      // A refused decision is a normal outcome — the budget can legitimately reject a commitment —
      // so it is shown in place rather than closing the drawer.
      setDecisionError(
        err instanceof ApiError
          ? err.message
          : "The decision could not be recorded. Please try again.",
      );
    } finally {
      setDeciding(false);
    }
  }

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  const pending = approvals.filter((a) => a.status === "PENDING");
  const decided = approvals.filter((a) => a.status !== "PENDING");
  const shown = filter === "pending" ? pending : decided;

  const financialExposure = pending.reduce((sum, a) => sum + (a.amount_inr ?? 0), 0);

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle={
          role === "LEADER"
            ? "Actions CommunityOps has prepared and cannot perform on its own. Each one waits for your decision."
            : "Requests you have raised. Decisions are made by community leaders."
        }
      />

      {role !== "LEADER" && (
        <div style={{ marginBottom: "var(--s4)" }}>
          <Notice tone="info">
            You can raise requests but not decide them. This is the boundary the product is built
            around, not a limitation of your account.
          </Notice>
        </div>
      )}

      {pending.length > 0 && financialExposure > 0 && (
        <div style={{ marginBottom: "var(--s4)" }}>
          <Notice tone="warn">
            {pending.length} {pending.length === 1 ? "decision is" : "decisions are"} waiting,
            committing {formatInrWithSymbol(financialExposure)} in total if all are approved.
          </Notice>
        </div>
      )}

      <Tabs<Filter>
        tabs={[
          { id: "pending", label: "Waiting on you", count: pending.length },
          { id: "decided", label: "Decided", count: decided.length },
        ]}
        active={filter}
        onChange={setFilter}
      />

      {shown.length === 0 ? (
        <EmptyState
          title={filter === "pending" ? "Nothing is waiting on you" : "No decisions yet"}
          body={
            filter === "pending"
              ? "CommunityOps has not prepared anything that needs a decision. It will appear here when it does."
              : "Decided approvals are kept here with their outcome and reasoning."
          }
        />
      ) : (
        <Card padding="flush">
          <ul className="rows">
            {shown.map((approval) => (
              <li key={approval.approval_id}>
                <button className="row" type="button" onClick={() => openApproval(approval)}>
                  <SeverityBadge severity={approval.risk_level} />
                  <div className="row-main">
                    <div className="row-title">{approval.title}</div>
                    <div className="row-meta">
                      {humanize(approval.requested_action)}
                      {approval.budget_category ? ` · ${approval.budget_category}` : ""} ·{" "}
                      {formatRelative(approval.requested_at)}
                    </div>
                  </div>
                  <div className="row-side">
                    {approval.amount_inr ? (
                      <strong>{formatInrWithSymbol(approval.amount_inr)}</strong>
                    ) : null}
                    <StatusBadge status={approval.status} />
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
        title={selected?.title ?? ""}
        subtitle={selected ? humanize(selected.requested_action) : undefined}
        footer={
          selected && selected.status === "PENDING" && role === "LEADER" ? (
            editing ? (
              <>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={deciding || !editedAction.trim()}
                  onClick={() => void decide("EDITED")}
                >
                  {deciding ? "Recording…" : "Save and approve as edited"}
                </button>
                <button className="btn" type="button" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={deciding}
                  onClick={() => void decide("APPROVED")}
                >
                  {deciding ? "Recording…" : "Approve"}
                </button>
                <button className="btn" type="button" disabled={deciding} onClick={() => setEditing(true)}>
                  Edit
                </button>
                <button
                  className="btn btn-danger"
                  type="button"
                  disabled={deciding}
                  onClick={() => void decide("DECLINED")}
                >
                  Decline
                </button>
              </>
            )
          ) : undefined
        }
      >
        {selected && (
          <div className="stack">
            {/* Outcome first once a decision has been made: it is the most important thing on the
                panel, and it carries the authoritative budget figure. */}
            {outcome && (
              <Notice tone="ok">
                <strong>Decision recorded.</strong> {outcome} CommunityOps will continue from here.
              </Notice>
            )}

            {budgetAfter && (
              <Card title="Budget after your decision" padding="tight">
                <DetailList
                  items={[
                    { label: "Remaining", value: formatInrWithSymbol(budgetAfter.remaining) },
                    { label: "Committed", value: formatInrWithSymbol(budgetAfter.committed) },
                    { label: "Spent", value: formatInrWithSymbol(budgetAfter.spent) },
                    { label: "Utilization", value: `${budgetAfter.utilization_percent}%` },
                  ]}
                />
                <p className="t-meta" style={{ marginTop: "var(--s3)" }}>
                  These figures come from the backend&rsquo;s own recalculation, not from
                  subtracting in the browser.
                </p>
              </Card>
            )}

            {decisionError && <Notice tone="error">{decisionError}</Notice>}

            <div className="cluster">
              <SeverityBadge severity={selected.risk_level} />
              <StatusBadge status={selected.status} />
              {selected.amount_inr ? (
                <strong style={{ fontSize: 17 }}>
                  {formatInrWithSymbol(selected.amount_inr)}
                </strong>
              ) : null}
            </div>

            {/* WHAT */}
            <div>
              <div className="t-label">What</div>
              <p className="t-body">{selected.description || selected.title}</p>
            </div>

            {/* WHY */}
            {selected.reason && (
              <div>
                <div className="t-label">Why this needs you</div>
                <p className="t-body">{selected.reason}</p>
              </div>
            )}

            {selected.agent_recommendation && (
              <Card title="What CommunityOps advises" padding="tight">
                <p className="t-body">{selected.agent_recommendation}</p>
              </Card>
            )}

            {selected.budget_impact && (
              <div>
                <div className="t-label">Budget impact</div>
                <p className="t-body">{selected.budget_impact}</p>
              </div>
            )}

            {editing && (
              <div className="field">
                <label className="field-label" htmlFor="edited-action">
                  Edited action
                </label>
                <textarea
                  id="edited-action"
                  className="textarea"
                  value={editedAction}
                  onChange={(e) => setEditedAction(e.target.value)}
                />
                <div className="field-hint">
                  Approving as edited records your wording as the action to carry out.
                </div>
              </div>
            )}

            {selected.status === "PENDING" && role === "LEADER" && !editing && (
              <div className="field">
                <label className="field-label" htmlFor="decision-notes">
                  Notes (optional)
                </label>
                <textarea
                  id="decision-notes"
                  className="textarea"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Recorded on the audit trail with your decision."
                />
              </div>
            )}

            <DetailList
              items={[
                { label: "Requested by", value: selected.requested_by_name || selected.agent_name },
                { label: "Requested", value: formatRelative(selected.requested_at) },
                { label: "Action", value: humanize(selected.requested_action) },
                { label: "Category", value: selected.budget_category },
                {
                  label: "Affects",
                  value: selected.affected_resource_id
                    ? `${selected.affected_resource_type} ${selected.affected_resource_id}`
                    : "",
                },
                { label: "Decided by", value: selected.decided_by },
                { label: "Decision notes", value: selected.decision_notes },
                { label: "Edited to", value: selected.edited_action },
              ]}
            />

            {/* Evidence, not reasoning. The figures the request rests on, so a leader can check it. */}
            {Object.keys(selected.evidence ?? {}).length > 0 && (
              <details>
                <summary className="t-meta" style={{ cursor: "pointer" }}>
                  Evidence CommunityOps used
                </summary>
                <div style={{ marginTop: "var(--s3)" }}>
                  <DetailList
                    items={Object.entries(selected.evidence).map(([key, value]) => ({
                      label: humanize(key),
                      value: typeof value === "boolean" ? (value ? "Yes" : "No") : String(value),
                    }))}
                  />
                </div>
              </details>
            )}

            {selected.status === "PENDING" && (
              <p className="t-meta">
                CommunityOps prepared this action and has not performed it. Approving records your
                decision and lets the operation continue.
              </p>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
