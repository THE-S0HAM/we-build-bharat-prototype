import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  allocateBudget,
  formatInrWithSymbol,
  getBudget,
  getExpenses,
  humanize,
  projectBudget,
  recordExpense,
  setBudget,
  type BudgetAllocationInput,
  type RecordExpenseInput,
} from "../api";
import { ApiErrorState } from "../components/ApiErrorState";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { SkeletonCard } from "../components/Skeleton";
import type { EventScopedPageProps } from "../event/EventScopedView";
import { useApiFailure } from "../session/useApiFailure";
import { useSession } from "../session/sessionContext";
import type { BudgetCategoryLine, BudgetProjection, BudgetSummary, Expense } from "../types";
import "./OperationalPages.css";

type MutationSucceeded = (message: string) => Promise<void>;

interface MutationFormProps {
  readonly eventId: string;
  readonly mutationLocked: boolean;
  readonly acquireMutation: () => boolean;
  readonly releaseMutation: () => void;
  readonly onFailure: (error: unknown) => unknown;
  readonly onSucceeded: MutationSucceeded;
}

interface CategorizedMutationFormProps extends MutationFormProps {
  readonly categories: readonly string[];
}

function parseWholeRupees(value: string, allowZero: boolean): number | null {
  const pattern = allowZero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/;
  if (!pattern.test(value)) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) ? amount : null;
}

export function Budget({ eventId }: EventScopedPageProps) {
  const report = useApiFailure();
  const { user } = useSession();
  const isLeader = user?.role === "LEADER";
  const [budget, setBudgetSummary] = useState<BudgetSummary | null>(null);
  const [budgetEventId, setBudgetEventId] = useState<string | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expensesEventId, setExpensesEventId] = useState<string | null>(null);
  const [expenseTotal, setExpenseTotal] = useState(0);
  const [budgetLoading, setBudgetLoading] = useState(true);
  const [expensesLoading, setExpensesLoading] = useState(true);
  const [failure, setFailure] = useState<unknown>(null);
  const [expenseFailure, setExpenseFailure] = useState<unknown>(null);
  const [announcement, setAnnouncement] = useState("");
  const [projectionVersion, setProjectionVersion] = useState(0);
  const mutationLock = useRef(false);
  const [mutationLocked, setMutationLocked] = useState(false);

  const acquireMutation = useCallback((): boolean => {
    if (mutationLock.current) return false;
    mutationLock.current = true;
    setMutationLocked(true);
    return true;
  }, []);

  const releaseMutation = useCallback((): void => {
    mutationLock.current = false;
    setMutationLocked(false);
  }, []);

  const loadExpenses = useCallback(async (clear = false): Promise<void> => {
    if (clear) {
      setExpenses([]);
      setExpenseTotal(0);
      setExpensesEventId(null);
    }
    setExpensesLoading(true);
    setExpenseFailure(null);
    try {
      const result = await getExpenses(eventId);
      setExpenses(result.expenses);
      setExpenseTotal(result.total_inr);
      setExpensesEventId(eventId);
    } catch (error: unknown) {
      setExpenseFailure(report(error));
    } finally {
      setExpensesLoading(false);
    }
  }, [eventId, report]);

  const loadAuthoritative = useCallback(async (clear = false): Promise<void> => {
    if (clear) {
      setBudgetSummary(null);
      setBudgetEventId(null);
      setExpenses([]);
      setExpenseTotal(0);
      setExpensesEventId(null);
    }
    setBudgetLoading(true);
    setExpensesLoading(true);
    setFailure(null);
    setExpenseFailure(null);

    const budgetRequest = getBudget(eventId).then(
      (summary) => {
        setBudgetSummary(summary);
        setBudgetEventId(eventId);
      },
      (error: unknown) => setFailure(report(error)),
    ).finally(() => setBudgetLoading(false));

    const expenseRequest = getExpenses(eventId).then(
      (result) => {
        setExpenses(result.expenses);
        setExpenseTotal(result.total_inr);
        setExpensesEventId(eventId);
      },
      (error: unknown) => setExpenseFailure(report(error)),
    ).finally(() => setExpensesLoading(false));

    await Promise.all([budgetRequest, expenseRequest]);
  }, [eventId, report]);

  useEffect(() => {
    setAnnouncement("");
    setProjectionVersion((version) => version + 1);
    void loadAuthoritative(true);
  }, [loadAuthoritative]);

  const mutationSucceeded = useCallback<MutationSucceeded>(async (message) => {
    setProjectionVersion((version) => version + 1);
    await loadAuthoritative(true);
    setAnnouncement(message);
  }, [loadAuthoritative]);

  const budgetIsCurrent = budgetEventId === eventId;
  const expensesAreCurrent = expensesEventId === eventId;
  const expenseColumns: readonly DataTableColumn<Expense>[] = [
    { key: "description", header: "Description", rowHeader: true, cell: (expense) => expense.description },
    { key: "category", header: "Category", cell: (expense) => humanize(expense.category) },
    { key: "amount", header: "Amount", cell: (expense) => formatInrWithSymbol(expense.amount_inr) },
    { key: "status", header: "Status", cell: (expense) => humanize(expense.status) },
  ];

  return <div className="page budget">
    <PageHeader title="Budget" context="Authoritative totals, commitments and projections from the CommunityOps budget service." />
    <p className="ops-announcement" role="status" aria-live="polite">{announcement}</p>
    {(budgetLoading || !budgetIsCurrent) && failure === null && <SkeletonCard lines={5} label="Getting the event budget…" />}
    {failure !== null && <ApiErrorState error={failure} onRetry={() => void loadAuthoritative(true)} />}
    {!budgetLoading && failure === null && budgetIsCurrent && budget !== null && <>
      {!budget.exists && <EmptyState title="No budget set for this event." description={isLeader ? "Set a total budget to start tracking allocations and expenses." : "CommunityOps cannot assess affordability until a community leader sets a total budget."} />}

      {isLeader && <section className="page-section" aria-labelledby="budget-leader-controls">
        <h2 className="page-section__heading" id="budget-leader-controls">Leader budget controls</h2>
        <p className="page-section__description">These controls submit exact whole-rupee values. The refreshed backend response remains authoritative.</p>
        <div className="ops-form-grid">
          <SetTotalForm eventId={eventId} hasBudget={budget.exists} mutationLocked={mutationLocked} acquireMutation={acquireMutation} releaseMutation={releaseMutation} onFailure={report} onSucceeded={mutationSucceeded} />
          {budget.exists && <>
            <AllocationForm eventId={eventId} categories={budget.categories_available} mutationLocked={mutationLocked} acquireMutation={acquireMutation} releaseMutation={releaseMutation} onFailure={report} onSucceeded={mutationSucceeded} />
            <ExpenseForm eventId={eventId} categories={budget.categories_available} mutationLocked={mutationLocked} acquireMutation={acquireMutation} releaseMutation={releaseMutation} onFailure={report} onSucceeded={mutationSucceeded} />
          </>}
        </div>
      </section>}

      {budget.exists && <>
        <dl className="ops-summary" aria-label="Authoritative budget totals">
          <Metric label="Total" value={formatInrWithSymbol(budget.total_budget)} />
          <Metric label="Allocated" value={formatInrWithSymbol(budget.allocated)} />
          <Metric label="Spent" value={formatInrWithSymbol(budget.spent)} />
          <Metric label="Committed" value={formatInrWithSymbol(budget.committed)} />
          <Metric label="Remaining" value={formatInrWithSymbol(budget.remaining)} />
          <Metric label="Utilized" value={`${budget.utilization_percent}%`} />
        </dl>
        <section className="page-section" aria-labelledby="budget-categories">
          <h2 className="page-section__heading" id="budget-categories">Categories and allocations</h2>
          {budget.categories.length === 0 ? <EmptyState title="Nothing allocated yet." description={`${formatInrWithSymbol(budget.unallocated)} remains unallocated.`} /> : <CategoryTable categories={budget.categories} />}
        </section>
        <section className="page-section" aria-labelledby="budget-projection">
          <h2 className="page-section__heading" id="budget-projection">Check a commitment</h2>
          <Projection key={`${eventId}-${projectionVersion}`} eventId={eventId} categories={budget.categories_available} onFailure={report} />
        </section>
        <section className="page-section" aria-labelledby="budget-expenses">
          <h2 className="page-section__heading" id="budget-expenses">Recorded expenses</h2>
          {expensesLoading || !expensesAreCurrent ? <SkeletonCard lines={3} label="Getting recorded expenses…" /> : expenseFailure !== null ? <ApiErrorState error={expenseFailure} onRetry={() => void loadExpenses(true)} /> : expenses.length === 0 ? <EmptyState title="No expenses recorded." description="Nothing has been paid out against this event yet." /> : <>
            <p className="page-section__description">{formatInrWithSymbol(expenseTotal)} total, as reported by the backend.</p>
            <DataTable label="Recorded expenses" columns={expenseColumns} rows={expenses} rowKey={(expense) => expense.expense_id} />
          </>}
        </section>
      </>}
    </>}
  </div>;
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return <div className="ops-metric"><dt>{label}</dt><dd>{value}</dd></div>;
}

function CategoryTable({ categories }: { readonly categories: BudgetCategoryLine[] }) {
  const columns: readonly DataTableColumn<BudgetCategoryLine>[] = [
    { key: "category", header: "Category", rowHeader: true, cell: (line) => humanize(line.category) },
    { key: "allocated", header: "Allocated", cell: (line) => formatInrWithSymbol(line.allocated) },
    { key: "spent", header: "Spent", cell: (line) => formatInrWithSymbol(line.spent) },
    { key: "committed", header: "Committed", cell: (line) => formatInrWithSymbol(line.committed) },
    { key: "remaining", header: "Remaining", cell: (line) => formatInrWithSymbol(line.remaining) },
  ];
  return <DataTable label="Budget categories" columns={columns} rows={categories} rowKey={(line) => line.category} />;
}

function SetTotalForm({ eventId, hasBudget, mutationLocked, acquireMutation, releaseMutation, onFailure, onSucceeded }: MutationFormProps & { readonly hasBudget: boolean }) {
  const inputId = useId();
  const errorId = useId();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [validation, setValidation] = useState("");

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const parsed = parseWholeRupees(amount, true);
    if (parsed === null) {
      setValidation("Enter zero or a positive whole number of rupees within the safe integer range.");
      return;
    }
    if (!acquireMutation()) return;
    setValidation("");
    setFailure(null);
    setBusy(true);
    try {
      const result = await setBudget(eventId, { total_budget: parsed });
      setAmount("");
      await onSucceeded(result.message);
    } catch (error: unknown) {
      setFailure(onFailure(error));
    } finally {
      setBusy(false);
      releaseMutation();
    }
  }

  return <form className="card ops-form" onSubmit={(event) => void submit(event)}>
    <h3>{hasBudget ? "Adjust total budget" : "Set total budget"}</h3>
    <div className="form-field">
      <label className="form-label" htmlFor={inputId}>Total budget in whole rupees</label>
      <input className="input" id={inputId} inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} aria-invalid={Boolean(validation)} aria-describedby={validation ? errorId : undefined} />
      {validation && <p className="form-result" id={errorId} role="alert">{validation}</p>}
    </div>
    <button className="btn btn-primary" type="submit" disabled={busy || mutationLocked}>{busy ? "Saving…" : hasBudget ? "Adjust total budget" : "Set total budget"}</button>
    {failure !== null && <ApiErrorState error={failure} context="action" />}
  </form>;
}

function AllocationForm({ eventId, categories, mutationLocked, acquireMutation, releaseMutation, onFailure, onSucceeded }: CategorizedMutationFormProps) {
  const categoryId = useId(); const amountId = useId(); const notesId = useId(); const errorId = useId();
  const [category, setCategory] = useState(categories[0] ?? "");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [validation, setValidation] = useState("");

  useEffect(() => {
    if (!categories.includes(category)) setCategory(categories[0] ?? "");
  }, [categories, category]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const parsed = parseWholeRupees(amount, true);
    if (parsed === null) {
      setValidation("Enter zero or a positive whole number of rupees within the safe integer range.");
      return;
    }
    if (!acquireMutation()) return;
    setValidation("");
    setFailure(null);
    setBusy(true);
    const input: BudgetAllocationInput = { category, amount_inr: parsed, ...(notes.trim() ? { notes: notes.trim() } : {}) };
    try {
      const result = await allocateBudget(eventId, input);
      setAmount("");
      setNotes("");
      await onSucceeded(result.message);
    } catch (error: unknown) {
      setFailure(onFailure(error));
    } finally {
      setBusy(false);
      releaseMutation();
    }
  }

  return <form className="card ops-form" onSubmit={(event) => void submit(event)}>
    <h3>Allocate a category</h3>
    <div className="form-field"><label className="form-label" htmlFor={categoryId}>Allocation category</label><select className="input" id={categoryId} value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></div>
    <div className="form-field"><label className="form-label" htmlFor={amountId}>Allocation amount in whole rupees</label><input className="input" id={amountId} inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} aria-invalid={Boolean(validation)} aria-describedby={validation ? errorId : undefined} />{validation && <p className="form-result" id={errorId} role="alert">{validation}</p>}</div>
    <div className="form-field"><label className="form-label" htmlFor={notesId}>Allocation notes (optional)</label><textarea className="input" id={notesId} value={notes} onChange={(event) => setNotes(event.target.value)} /></div>
    <button className="btn btn-primary" type="submit" disabled={busy || mutationLocked || !category}>{busy ? "Allocating…" : "Allocate budget"}</button>
    {failure !== null && <ApiErrorState error={failure} context="action" />}
  </form>;
}

function ExpenseForm({ eventId, categories, mutationLocked, acquireMutation, releaseMutation, onFailure, onSucceeded }: CategorizedMutationFormProps) {
  const categoryId = useId(); const amountId = useId(); const descriptionId = useId(); const vendorId = useId(); const approvalId = useId(); const errorId = useId();
  const [category, setCategory] = useState(categories[0] ?? "");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [vendor, setVendor] = useState("");
  const [approval, setApproval] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [validation, setValidation] = useState("");

  useEffect(() => {
    if (!categories.includes(category)) setCategory(categories[0] ?? "");
  }, [categories, category]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const parsed = parseWholeRupees(amount, false);
    if (parsed === null) {
      setValidation("Enter a positive whole number of rupees within the safe integer range.");
      return;
    }
    if (!description.trim()) {
      setValidation("Enter an expense description.");
      return;
    }
    if (!acquireMutation()) return;
    setValidation("");
    setFailure(null);
    setBusy(true);
    const input: RecordExpenseInput = {
      category,
      amount_inr: parsed,
      description: description.trim(),
      ...(vendor.trim() ? { vendor: vendor.trim() } : {}),
      ...(approval.trim() ? { approval_id: approval.trim() } : {}),
    };
    try {
      const result = await recordExpense(eventId, input);
      setAmount("");
      setDescription("");
      setVendor("");
      setApproval("");
      await onSucceeded(result.message);
    } catch (error: unknown) {
      setFailure(onFailure(error));
    } finally {
      setBusy(false);
      releaseMutation();
    }
  }

  return <form className="card ops-form" onSubmit={(event) => void submit(event)}>
    <h3>Record an expense</h3>
    <div className="form-field"><label className="form-label" htmlFor={categoryId}>Expense category</label><select className="input" id={categoryId} value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></div>
    <div className="form-field"><label className="form-label" htmlFor={amountId}>Expense amount in whole rupees</label><input className="input" id={amountId} inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} aria-invalid={Boolean(validation)} aria-describedby={validation ? errorId : undefined} />{validation && <p className="form-result" id={errorId} role="alert">{validation}</p>}</div>
    <div className="form-field"><label className="form-label" htmlFor={descriptionId}>Expense description</label><textarea className="input" id={descriptionId} value={description} onChange={(event) => setDescription(event.target.value)} /></div>
    <div className="form-field"><label className="form-label" htmlFor={vendorId}>Vendor (optional)</label><input className="input" id={vendorId} value={vendor} onChange={(event) => setVendor(event.target.value)} /></div>
    <div className="form-field"><label className="form-label" htmlFor={approvalId}>Approval ID (optional)</label><input className="input" id={approvalId} value={approval} onChange={(event) => setApproval(event.target.value)} /></div>
    <button className="btn btn-primary" type="submit" disabled={busy || mutationLocked || !category}>{busy ? "Recording…" : "Record expense"}</button>
    {failure !== null && <ApiErrorState error={failure} context="action" />}
  </form>;
}

function Projection({ eventId, categories, onFailure }: { readonly eventId: string; readonly categories: readonly string[]; readonly onFailure: (error: unknown) => unknown }) {
  const categoryId = useId(); const amountId = useId(); const errorId = useId();
  const [category, setCategory] = useState(categories[0] ?? "");
  const [amount, setAmount] = useState("");
  const [projection, setProjection] = useState<BudgetProjection | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [validation, setValidation] = useState("");

  function submit(event: FormEvent): void {
    event.preventDefault();
    const parsed = parseWholeRupees(amount, false);
    if (parsed === null) {
      setValidation("Enter a positive whole number of rupees within the safe integer range.");
      setProjection(null);
      return;
    }
    setValidation("");
    setBusy(true);
    setFailure(null);
    projectBudget(eventId, category, parsed).then(
      (result) => { setProjection(result.projection); setBusy(false); },
      (error: unknown) => { setFailure(onFailure(error)); setBusy(false); },
    );
  }

  return <form className="card ops-form" onSubmit={submit}>
    <p className="page-section__description">This preview writes nothing and uses the same backend rules as a real commitment.</p>
    <div className="ops-form__row">
      <div className="form-field"><label className="form-label" htmlFor={categoryId}>Category</label><select className="input" id={categoryId} value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></div>
      <div className="form-field"><label className="form-label" htmlFor={amountId}>Amount in whole rupees</label><input className="input" id={amountId} inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} aria-invalid={Boolean(validation)} aria-describedby={validation ? errorId : undefined} /></div>
      <button className="btn btn-primary" type="submit" disabled={busy || !category}>{busy ? "Checking…" : "Check"}</button>
    </div>
    {validation && <p className="form-result" id={errorId} role="alert">{validation}</p>}
    {failure !== null && <ApiErrorState error={failure} context="action" />}
    {projection && <div className={projection.affordable ? "ops-result" : "ops-result ops-result--attention"} role="status"><strong>{projection.affordable ? "Affordable" : "Not affordable"}</strong><p>{projection.impact_summary}</p><p>Remaining now: {formatInrWithSymbol(projection.current_remaining)}. Remaining after: {formatInrWithSymbol(projection.projected_remaining)}.</p>{projection.blockers.length > 0 && <ul>{projection.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}</div>}
  </form>;
}
