/**
 * Budget.
 *
 * Answers one question: how much can we still commit, and to what?
 *
 * **No arithmetic happens in this file.** Every figure — remaining, unallocated,
 * utilization, per-category remaining — is read from `GET /events/{id}/budget`, which
 * derives them in `budget_service._derive` on every read. A percentage computed here could
 * disagree with the one the approve path enforced, and the moment those two numbers differ
 * the leader has no way to know which is real. The only place this file does division is
 * turning an already-authoritative percentage into a bar width.
 *
 * The projection panel is the same rule applied to a hypothetical: "what if I commit
 * ₹7,000 to EQUIPMENT" is answered by `POST /budget/projection`, which runs the identical
 * arithmetic as the write path and writes nothing. It is not a client-side subtraction
 * dressed up as a preview.
 */

import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  formatInr,
  formatInrWithSymbol,
  getBudget,
  getExpenses,
  humanize,
  projectBudget,
} from "../api";
import {
  Card,
  DetailList,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  Progress,
  Section,
  Stat,
  StatusBadge,
} from "../components/primitives";
import type { BudgetProjection, BudgetSummary, Expense, Role } from "../types";

/** Utilization bands. Thresholds match `_warn_if_budget_tight` in the budget handler. */
function utilizationTone(percent: number): "normal" | "at-risk" | "over" {
  if (percent >= 90) return "over";
  if (percent >= 75) return "at-risk";
  return "normal";
}

export function BudgetPage({ eventId, role }: { eventId: string; role: Role }) {
  const [budget, setBudget] = useState<BudgetSummary | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expenseTotal, setExpenseTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      // Expenses are supporting detail; a failure there should not blank the totals, which
      // are the reason someone opened this page.
      const [summary, expenseList] = await Promise.all([
        getBudget(eventId),
        getExpenses(eventId).catch(() => ({ expenses: [], count: 0, total_inr: 0 })),
      ]);
      setBudget(summary);
      setExpenses(expenseList.expenses);
      setExpenseTotal(expenseList.total_inr);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the budget.");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!budget) return <ErrorState onRetry={() => void load()} />;

  if (!budget.exists) {
    return (
      <div>
        <PageHeader title="Budget" subtitle="No budget has been set for this event yet." />
        <EmptyState
          mark="₹"
          title="No budget set"
          body={
            role === "LEADER"
              ? "Set a total budget to start tracking allocations, commitments and spend. Until then CommunityOps cannot tell you whether a request is affordable."
              : "A community leader has not set a budget for this event yet."
          }
        />
      </div>
    );
  }

  const utilization = budget.utilization_percent;

  return (
    <div>
      <PageHeader
        title="Budget"
        subtitle={
          <>
            {formatInrWithSymbol(budget.remaining)} of {formatInrWithSymbol(budget.total_budget)}{" "}
            still available to commit. Figures are computed by the backend on every read.
          </>
        }
      />

      <div className="stat-grid" style={{ marginBottom: "var(--s5)" }}>
        <Stat
          value={formatInrWithSymbol(budget.remaining)}
          label="Remaining"
          note="total less spent and committed"
          tone={utilization >= 90 ? "blocked" : utilization >= 75 ? "at-risk" : "handled"}
        />
        <Stat value={formatInrWithSymbol(budget.spent)} label="Spent" note="money that has left" />
        <Stat
          value={formatInrWithSymbol(budget.committed)}
          label="Committed"
          note="approved, not yet paid"
          tone={budget.committed > 0 ? "pending" : undefined}
        />
        <Stat
          value={`${utilization}%`}
          label="Utilized"
          note={`${formatInrWithSymbol(budget.unallocated)} unallocated`}
          tone={utilization >= 90 ? "blocked" : utilization >= 75 ? "at-risk" : undefined}
        />
      </div>

      {utilization >= 75 && (
        <div style={{ marginBottom: "var(--s5)" }}>
          <Notice tone={utilization >= 90 ? "error" : "warn"}>
            This event is {utilization}% utilized. {formatInrWithSymbol(budget.remaining)} remains
            against {formatInrWithSymbol(budget.total_budget)}. New commitments will be checked
            against this figure before they can be approved.
          </Notice>
        </div>
      )}

      <Section title="Where it stands">
        <Card>
          <div className="cluster-between" style={{ marginBottom: "var(--s3)" }}>
            <span className="t-body">
              {formatInrWithSymbol(budget.spent)} spent · {formatInrWithSymbol(budget.committed)}{" "}
              committed
            </span>
            <strong>{utilization}% of {formatInrWithSymbol(budget.total_budget)}</strong>
          </div>
          <Progress percent={utilization} tone={utilizationTone(utilization)} />
          <p className="t-meta" style={{ marginTop: "var(--s4)" }}>
            Committed money is reserved against an approved request but has not been paid. It is
            deducted from what is available to commit, so the same rupee cannot be promised twice.
          </p>
        </Card>
      </Section>

      <Section title="By category">
        {budget.categories.length === 0 ? (
          <EmptyState
            mark="—"
            title="Nothing allocated yet"
            body={`The full ${formatInrWithSymbol(budget.total_budget)} is unallocated. Allocating to categories is what lets CommunityOps tell you whether a specific request fits.`}
          />
        ) : (
          <Card padding="flush">
            <ul className="rows">
              {budget.categories.map((line) => {
                const overcommitted = line.remaining < 0;
                return (
                  <li className="row" key={line.category}>
                    <div className="row-main">
                      <div className="row-title">{humanize(line.category)}</div>
                      <div className="row-meta">
                        {formatInrWithSymbol(line.spent)} spent
                        {line.committed > 0
                          ? ` · ${formatInrWithSymbol(line.committed)} committed`
                          : ""}{" "}
                        of {formatInrWithSymbol(line.allocated)} allocated
                        {line.notes ? ` · ${line.notes}` : ""}
                      </div>
                      <div style={{ marginTop: "var(--s2)", maxWidth: 420 }}>
                        <Progress
                          percent={line.utilization_percent}
                          tone={utilizationTone(line.utilization_percent)}
                        />
                      </div>
                    </div>
                    <div className="row-side">
                      <div style={{ textAlign: "right" }}>
                        <div
                          style={{
                            fontWeight: 600,
                            fontVariantNumeric: "tabular-nums",
                            color: overcommitted ? "var(--status-blocked)" : undefined,
                          }}
                        >
                          {formatInrWithSymbol(line.remaining)}
                        </div>
                        <div className="t-meta">headroom</div>
                      </div>
                      {overcommitted && <StatusBadge tone="blocked" label="Over" />}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </Section>

      {role === "LEADER" && budget.categories.length > 0 && (
        <Section title="Can we afford it?">
          <ProjectionPanel
            eventId={eventId}
            categories={budget.categories.map((c) => c.category)}
          />
        </Section>
      )}

      <Section title="Recorded spend">
        {expenses.length === 0 ? (
          <EmptyState
            mark="—"
            title="No expenses recorded"
            body="Nothing has been paid out against this event yet."
          />
        ) : (
          <Card
            padding="flush"
            footer={
              <span className="t-meta">
                {expenses.length} {expenses.length === 1 ? "expense" : "expenses"} ·{" "}
                {formatInrWithSymbol(expenseTotal)} total, as reported by the backend
              </span>
            }
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th>Category</th>
                    <th>Vendor</th>
                    <th style={{ textAlign: "right" }}>Amount</th>
                    <th>Approval</th>
                  </tr>
                </thead>
                <tbody>
                  {expenses.map((expense) => (
                    <tr key={expense.expense_id}>
                      <td>{expense.description}</td>
                      <td>{humanize(expense.category)}</td>
                      <td>{expense.vendor || "—"}</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {formatInrWithSymbol(expense.amount_inr)}
                      </td>
                      <td className="t-mono">{expense.approval_id || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </Section>
    </div>
  );
}

/**
 * Affordability preview.
 *
 * Calls `POST /budget/projection`, which runs the same checks as the commit path and
 * returns the blockers it would raise. When it says a request is not affordable, that is
 * the real answer the approve button would give — not an estimate.
 */
function ProjectionPanel({
  eventId,
  categories,
}: {
  eventId: string;
  categories: string[];
}) {
  const [category, setCategory] = useState(categories[0] ?? "");
  const [amount, setAmount] = useState("");
  const [projection, setProjection] = useState<BudgetProjection | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();

  async function run() {
    const rupees = Number.parseInt(amount, 10);
    if (!Number.isFinite(rupees) || rupees <= 0) {
      setFailure("Enter a whole number of rupees.");
      setProjection(null);
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await projectBudget(eventId, category, rupees);
      setProjection(result.projection);
    } catch (err) {
      setProjection(null);
      setFailure(err instanceof ApiError ? err.message : "Could not check affordability.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <p className="t-body" style={{ marginBottom: "var(--s4)" }}>
        Check a commitment before it becomes a request. Nothing is written.
      </p>

      <form
        className="input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="field grow">
          <label className="field-label" htmlFor="projection-category">
            Category
          </label>
          <select
            id="projection-category"
            className="select"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {humanize(c)}
              </option>
            ))}
          </select>
        </div>
        <div className="field grow">
          <label className="field-label" htmlFor="projection-amount">
            Amount in rupees
          </label>
          <input
            id="projection-amount"
            className="input"
            inputMode="numeric"
            placeholder="7000"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <button className="btn" type="submit" disabled={busy || !category}>
          {busy ? "Checking…" : "Check"}
        </button>
      </form>

      {failure && (
        <div style={{ marginTop: "var(--s4)" }}>
          <Notice tone="error">{failure}</Notice>
        </div>
      )}

      {projection && (
        <div style={{ marginTop: "var(--s4)" }}>
          <Notice tone={projection.affordable ? "ok" : "error"}>
            {projection.impact_summary}
          </Notice>

          {projection.blockers.length > 0 && (
            <ul className="stack-sm" style={{ marginTop: "var(--s3)", paddingLeft: "var(--s5)" }}>
              {projection.blockers.map((blocker) => (
                <li key={blocker} className="t-body" style={{ color: "var(--status-blocked)" }}>
                  {blocker}
                </li>
              ))}
            </ul>
          )}

          <div style={{ marginTop: "var(--s4)" }}>
            <DetailList
              items={[
                {
                  label: "Remaining now",
                  value: formatInrWithSymbol(projection.current_remaining),
                },
                {
                  label: "Remaining after",
                  value: (
                    <strong
                      style={{
                        color: projection.affordable ? undefined : "var(--status-blocked)",
                      }}
                    >
                      {formatInrWithSymbol(projection.projected_remaining)}
                    </strong>
                  ),
                },
                {
                  label: "Committed after",
                  value: formatInrWithSymbol(projection.projected_committed),
                },
                {
                  label: "Utilization after",
                  value: `${projection.projected_utilization_percent}% (from ${projection.current_utilization_percent}%)`,
                },
                { label: "Amount", value: `₹${formatInr(projection.amount_inr)}` },
              ]}
            />
          </div>

          <p className="t-meta" style={{ marginTop: "var(--s3)" }}>
            This preview runs the same arithmetic as the commit path. To actually commit the money,
            the spend has to go through an approval.
          </p>
        </div>
      )}
    </Card>
  );
}
