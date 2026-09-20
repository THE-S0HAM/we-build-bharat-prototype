import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { formatInrWithSymbol, getBudget, getExpenses, humanize, projectBudget } from "../api";
import { ApiErrorState } from "../components/ApiErrorState";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { SkeletonCard } from "../components/Skeleton";
import type { EventScopedPageProps } from "../event/EventScopedView";
import { useApiFailure } from "../session/useApiFailure";
import type { BudgetCategoryLine, BudgetProjection, BudgetSummary, Expense } from "../types";
import "./OperationalPages.css";

export function Budget({ eventId }: EventScopedPageProps) {
  const report = useApiFailure();
  const [budget, setBudget] = useState<BudgetSummary | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expenseTotal, setExpenseTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<unknown>(null);
  const [expenseFailure, setExpenseFailure] = useState<unknown>(null);
  const load = useCallback(() => {
    setLoading(true); setFailure(null); setExpenseFailure(null);
    getBudget(eventId).then((summary) => {
      setBudget(summary); setLoading(false);
      getExpenses(eventId).then((result) => { setExpenses(result.expenses); setExpenseTotal(result.total_inr); }, (error: unknown) => setExpenseFailure(report(error)));
    }, (error: unknown) => { setFailure(report(error)); setLoading(false); });
  }, [eventId, report]);
  useEffect(load, [load]);
  const expenseColumns: readonly DataTableColumn<Expense>[] = [
    { key: "description", header: "Description", rowHeader: true, cell: (expense) => expense.description },
    { key: "category", header: "Category", cell: (expense) => humanize(expense.category) },
    { key: "amount", header: "Amount", cell: (expense) => formatInrWithSymbol(expense.amount_inr) },
    { key: "status", header: "Status", cell: (expense) => humanize(expense.status) },
  ];
  return <div className="page budget">
    <PageHeader title="Budget" context="Authoritative totals, commitments and projections from the CommunityOps budget service." />
    {loading && <SkeletonCard lines={5} label="Getting the event budget…" />}
    {failure !== null && <ApiErrorState error={failure} onRetry={load} />}
    {!loading && failure === null && budget !== null && !budget.exists && <EmptyState title="No budget set for this event." description="CommunityOps cannot assess affordability until a community leader sets a total budget." />}
    {!loading && failure === null && budget?.exists && <>
      <dl className="ops-summary" aria-label="Authoritative budget totals">
        <Metric label="Total" value={formatInrWithSymbol(budget.total_budget)} />
        <Metric label="Allocated" value={formatInrWithSymbol(budget.allocated)} />
        <Metric label="Spent" value={formatInrWithSymbol(budget.spent)} />
        <Metric label="Committed" value={formatInrWithSymbol(budget.committed)} />
        <Metric label="Remaining" value={formatInrWithSymbol(budget.remaining)} />
        <Metric label="Utilized" value={`${budget.utilization_percent}%`} />
      </dl>
      <section className="page-section" aria-labelledby="budget-categories"><h2 className="page-section__heading" id="budget-categories">Categories and allocations</h2>{budget.categories.length === 0 ? <EmptyState title="Nothing allocated yet." description={`${formatInrWithSymbol(budget.unallocated)} remains unallocated.`} /> : <CategoryTable categories={budget.categories} />}</section>
      <section className="page-section" aria-labelledby="budget-projection"><h2 className="page-section__heading" id="budget-projection">Check a commitment</h2><Projection eventId={eventId} categories={budget.categories_available} onFailure={report} /></section>
      <section className="page-section" aria-labelledby="budget-expenses"><h2 className="page-section__heading" id="budget-expenses">Recorded expenses</h2>{expenseFailure !== null ? <ApiErrorState error={expenseFailure} onRetry={load} /> : expenses.length === 0 ? <EmptyState title="No expenses recorded." description="Nothing has been paid out against this event yet." /> : <><p className="page-section__description">{formatInrWithSymbol(expenseTotal)} total, as reported by the backend.</p><DataTable label="Recorded expenses" columns={expenseColumns} rows={expenses} rowKey={(expense) => expense.expense_id} /></>}</section>
    </>}
  </div>;
}
function Metric({ label, value }: { label: string; value: string }) { return <div className="ops-metric"><dt>{label}</dt><dd>{value}</dd></div>; }
function CategoryTable({ categories }: { categories: BudgetCategoryLine[] }) { const columns: readonly DataTableColumn<BudgetCategoryLine>[] = [
  { key: "category", header: "Category", rowHeader: true, cell: (line) => humanize(line.category) },
  { key: "allocated", header: "Allocated", cell: (line) => formatInrWithSymbol(line.allocated) },
  { key: "spent", header: "Spent", cell: (line) => formatInrWithSymbol(line.spent) },
  { key: "committed", header: "Committed", cell: (line) => formatInrWithSymbol(line.committed) },
  { key: "remaining", header: "Remaining", cell: (line) => formatInrWithSymbol(line.remaining) },
]; return <DataTable label="Budget categories" columns={columns} rows={categories} rowKey={(line) => line.category} />; }
function Projection({ eventId, categories, onFailure }: { eventId: string; categories: string[]; onFailure: (error: unknown) => unknown }) {
  const categoryId = useId(); const amountId = useId();
  const [category, setCategory] = useState(categories[0] ?? ""); const [amount, setAmount] = useState(""); const [projection, setProjection] = useState<BudgetProjection | null>(null); const [busy, setBusy] = useState(false); const [failure, setFailure] = useState<unknown>(null); const [validation, setValidation] = useState("");
  function submit(event: FormEvent) { event.preventDefault(); const text = amount.trim(); if (!/^[1-9]\d*$/.test(text)) { setValidation("Enter a positive whole number of rupees."); setProjection(null); return; } setValidation(""); setBusy(true); setFailure(null); projectBudget(eventId, category, Number(text)).then((result) => { setProjection(result.projection); setBusy(false); }, (error: unknown) => { setFailure(onFailure(error)); setBusy(false); }); }
  return <form className="card ops-form" onSubmit={submit}><p className="page-section__description">This preview writes nothing and uses the same backend rules as a real commitment.</p><div className="ops-form__row"><div className="form-field"><label className="form-label" htmlFor={categoryId}>Category</label><select className="input" id={categoryId} value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></div><div className="form-field"><label className="form-label" htmlFor={amountId}>Amount in whole rupees</label><input className="input" id={amountId} inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} aria-invalid={Boolean(validation)} /></div><button className="btn btn-primary" type="submit" disabled={busy || !category}>{busy ? "Checking…" : "Check"}</button></div>{validation && <p className="form-result" role="alert">{validation}</p>}{failure !== null && <ApiErrorState error={failure} context="action" />}{projection && <div className={projection.affordable ? "ops-result" : "ops-result ops-result--attention"} role="status"><strong>{projection.affordable ? "Affordable" : "Not affordable"}</strong><p>{projection.impact_summary}</p><p>Remaining now: {formatInrWithSymbol(projection.current_remaining)}. Remaining after: {formatInrWithSymbol(projection.projected_remaining)}.</p>{projection.blockers.length > 0 && <ul>{projection.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}</div>}</form>;
}
