/**
 * `ApprovalActions` — the three decisions a person can take on one prepared
 * action, and the guarantees that go with taking them.
 *
 * Approve / Edit / Decline, in those words (requirement 12.8). The component owns
 * the interaction and nothing else: the request itself belongs to the page, which
 * holds the event, the queue and the session-level failure handling. What this
 * component guarantees is the part a page should not have to re-implement per
 * card:
 *
 *   - **One request per user action** (requirement 5.3, property 15). A submit in
 *     flight is held by a ref as well as by state, so a second activation in the
 *     same tick — a double click, an Enter and a click together — returns without
 *     issuing anything. Every control is `disabled` until the response resolves,
 *     so there is no second request to race the first (requirement 13.11).
 *   - **Decline requires a note, and says where the note goes** (requirement
 *     5.4). An empty note is refused in the browser, before any request, with the
 *     message associated to the field through `aria-describedby` (requirement
 *     15.7).
 *   - **Edit is one field, at the real contract fidelity** (requirement 5.5, A4).
 *     `_decide_approval` takes a single free-text `edited_action`, so this is one
 *     labelled multi-line field pre-filled with `requested_action`, with the
 *     original immediately above it for comparison. A per-field form would be a
 *     fiction — the backend has no field-level schema for an action.
 *
 * A failure that leaves the approval decidable — a timeout, a 500 — unlocks the
 * controls and explains itself here. A failure that settles the card, above all
 * the 409 "already decided elsewhere", is the page's to render: the card stops
 * being a decision surface at that point (requirement 5.6).
 */

import { useId, useRef, useState } from "react";

import { ApiErrorState } from "../components/ApiErrorState";
import {
  APPROVE_LABEL,
  AUDIT_TRAIL_NOTICE,
  DECLINE_LABEL,
  DECLINE_NOTE_LABEL,
  EDIT_FIELD_LABEL,
  EDIT_LABEL,
  type DecisionOutcome,
  type DecisionRequest,
} from "./decision";

import "./ApprovalActions.css";

/** Announced while a decision is being recorded (requirements 13.11, 15.8). */
export const SUBMITTING_LABEL = "Recording your decision…";

const NOTE_REQUIRED = "Add a note before declining. It is recorded in the audit trail.";
const EDIT_REQUIRED = "Describe the action CommunityOps should take instead.";
const CANCEL_LABEL = "Cancel";
const SUBMIT_EDIT_LABEL = "Submit edit";
const SUBMIT_DECLINE_LABEL = "Submit decline";
const ORIGINAL_ACTION_LABEL = "The action CommunityOps prepared";

/** Which expanded form, if any, is open. Only one can be. */
type Panel = "none" | "edit" | "decline";

export interface ApprovalActionsProps {
  /**
   * The agent's prepared action, verbatim. It pre-fills the edit field and is
   * displayed above it, so the user edits exactly the string that was prepared.
   */
  readonly requestedAction: string;

  /**
   * Issues the decision and reports back whether this card is still decidable.
   * Called at most once per user action.
   */
  readonly onDecide: (request: DecisionRequest) => Promise<DecisionOutcome>;
}

export function ApprovalActions({ requestedAction, onDecide }: ApprovalActionsProps) {
  const [panel, setPanel] = useState<Panel>("none");
  const [note, setNote] = useState("");
  const [editedAction, setEditedAction] = useState(requestedAction);
  const [submitting, setSubmitting] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  /**
   * The lock that makes "exactly one request" true rather than likely. State
   * cannot do this alone: two activations in one tick both read the pre-update
   * value of `submitting`.
   */
  const inFlight = useRef(false);

  /** The open panel's field, so a refused submit puts focus on what to fix. */
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);

  const fieldId = useId();
  const validationId = useId();
  const originalId = useId();
  const noticeId = useId();

  async function submit(request: DecisionRequest): Promise<void> {
    if (inFlight.current) return;

    inFlight.current = true;
    setSubmitting(true);
    setValidation(null);
    setFailure(null);

    const outcome = await onDecide(request);

    inFlight.current = false;
    setSubmitting(false);

    // `settled` means the page has replaced this card — with the recorded
    // decision, or with "This was already decided elsewhere." — so there is
    // nothing for the action row to say.
    if (outcome.kind === "retryable") {
      setFailure(outcome.error);
    }
  }

  function refuse(message: string): void {
    setValidation(message);
    fieldRef.current?.focus();
  }

  function approve(): void {
    void submit({ decision: "APPROVED", notes: "" });
  }

  function submitEdit(): void {
    const edited = editedAction.trim();

    if (edited === "") {
      refuse(EDIT_REQUIRED);
      return;
    }

    void submit({ decision: "EDITED", notes: "", editedAction: edited });
  }

  function submitDecline(): void {
    const reason = note.trim();

    // Requirement 5.4: the note is the record of why, so there is no declining
    // without one.
    if (reason === "") {
      refuse(NOTE_REQUIRED);
      return;
    }

    void submit({ decision: "DECLINED", notes: reason });
  }

  function openPanel(next: Panel): void {
    // Re-opening Edit starts from the prepared action again, so Cancel discards
    // an edit rather than parking it.
    if (next === "edit") setEditedAction(requestedAction);
    setValidation(null);
    setPanel(next);
  }

  function closePanel(): void {
    setValidation(null);
    setPanel("none");
  }

  const describedBy = (...ids: readonly (string | false)[]): string | undefined => {
    const present = ids.filter((id): id is string => id !== false);
    return present.length === 0 ? undefined : present.join(" ");
  };

  return (
    <div className="approval-actions">
      {/* All three labels stay visible at every width; they wrap rather than
          truncate or collapse into a menu (requirement 14.5). */}
      <div className="approval-actions__row" aria-busy={submitting}>
        {/* Approve is the primary while the three actions stand alone. Once Edit
            or Decline opens a panel, `Submit edit` / `Submit decline` is the
            confirming action, so Approve steps back to the default treatment:
            one primary action is visible at a time (requirement 12.11,
            checklist item 8 in design.md §15.3), and the button that completes
            what you started is the one that looks like it. */}
        <button
          type="button"
          className={
            panel === "none"
              ? "btn btn-primary approval-actions__button"
              : "btn approval-actions__button"
          }
          onClick={approve}
          disabled={submitting}
          aria-busy={submitting}
        >
          {APPROVE_LABEL}
        </button>
        <button
          type="button"
          className="btn approval-actions__button"
          onClick={() => openPanel(panel === "edit" ? "none" : "edit")}
          disabled={submitting}
          aria-expanded={panel === "edit"}
        >
          {EDIT_LABEL}
        </button>
        <button
          type="button"
          className="btn approval-actions__button"
          onClick={() => openPanel(panel === "decline" ? "none" : "decline")}
          disabled={submitting}
          aria-expanded={panel === "decline"}
        >
          {DECLINE_LABEL}
        </button>

        {submitting ? (
          <span className="approval-actions__submitting" role="status">
            {SUBMITTING_LABEL}
          </span>
        ) : null}
      </div>

      {panel === "edit" ? (
        <div className="approval-actions__panel">
          {/* The original, immediately above the field, for comparison
              (requirement 5.5). It also describes the field, so the comparison
              is available to a screen reader on the control itself. */}
          <div className="approval-actions__original" id={originalId}>
            <span className="approval-actions__original-label">{ORIGINAL_ACTION_LABEL}</span>
            <code className="approval-actions__original-value">{requestedAction}</code>
          </div>

          <label className="approval-actions__label" htmlFor={fieldId}>
            {EDIT_FIELD_LABEL}
          </label>
          <textarea
            id={fieldId}
            ref={fieldRef}
            className="approval-actions__field"
            value={editedAction}
            onChange={(event) => setEditedAction(event.target.value)}
            disabled={submitting}
            rows={3}
            aria-describedby={describedBy(originalId, validation !== null && validationId)}
            aria-invalid={validation !== null}
          />

          {validation === null ? null : (
            <p className="approval-actions__validation" id={validationId} role="alert">
              {validation}
            </p>
          )}

          <div className="approval-actions__panel-row">
            <button
              type="button"
              className="btn btn-primary approval-actions__button"
              onClick={submitEdit}
              disabled={submitting}
              aria-busy={submitting}
            >
              {SUBMIT_EDIT_LABEL}
            </button>
            <button
              type="button"
              className="btn approval-actions__button"
              onClick={closePanel}
              disabled={submitting}
            >
              {CANCEL_LABEL}
            </button>
          </div>
        </div>
      ) : null}

      {panel === "decline" ? (
        <div className="approval-actions__panel">
          <label className="approval-actions__label" htmlFor={fieldId}>
            {DECLINE_NOTE_LABEL}
          </label>
          <textarea
            id={fieldId}
            ref={fieldRef}
            className="approval-actions__field"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={submitting}
            rows={3}
            required
            aria-describedby={describedBy(noticeId, validation !== null && validationId)}
            aria-invalid={validation !== null}
          />

          {/* Requirement 5.4: stated before submitting, not after. */}
          <p className="approval-actions__notice" id={noticeId}>
            {AUDIT_TRAIL_NOTICE}
          </p>

          {validation === null ? null : (
            <p className="approval-actions__validation" id={validationId} role="alert">
              {validation}
            </p>
          )}

          <div className="approval-actions__panel-row">
            <button
              type="button"
              className="btn btn-primary approval-actions__button"
              onClick={submitDecline}
              disabled={submitting}
              aria-busy={submitting}
            >
              {SUBMIT_DECLINE_LABEL}
            </button>
            <button
              type="button"
              className="btn approval-actions__button"
              onClick={closePanel}
              disabled={submitting}
            >
              {CANCEL_LABEL}
            </button>
          </div>
        </div>
      ) : null}

      {/* A failure that left the approval decidable. The copy comes from the
          reviewed table; nothing from the failure itself is rendered. */}
      {failure === null ? null : (
        <div className="approval-actions__failure">
          <ApiErrorState error={failure} context="action" />
        </div>
      )}
    </div>
  );
}
