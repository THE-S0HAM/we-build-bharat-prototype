/**
 * `ApprovalActions` — the three decisions, and the guarantees that come with
 * taking them.
 *
 * These are the control-level behaviours: one request per action, the lock while
 * it is in flight, the note Decline cannot do without, and Edit at the fidelity
 * the contract actually has. The page-level consequences — the recorded copy, the
 * 409 replacement, the session strip — are in `src/pages/ApprovalCenter.test.tsx`.
 *
 * **Validates: Requirements 5.3, 5.4, 5.5, 12.8, 13.11**
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ApprovalActions, type ApprovalActionsProps } from "./ApprovalActions";
import { AUDIT_TRAIL_NOTICE, EDIT_FIELD_LABEL, type DecisionOutcome } from "./decision";

/** The exact string the agent prepared, which Edit must pre-fill with. */
const REQUESTED_ACTION = "SEND_SPEAKER_FOLLOWUP";

/** What the user puts in its place — one free-text action, as the contract has. */
const EDITED_ACTION = "PAUSE_SPEAKER_FOLLOWUP";

const DECLINE_NOTE = "Already replied by phone.";

const ORIGINAL_ACTION_LABEL = "The action CommunityOps prepared";

/** A promise the test resolves by hand, so "in flight" is a state it can assert. */
function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });

  return { promise, settle };
}

const settled = (): Promise<DecisionOutcome> => Promise.resolve({ kind: "settled" });

function renderActions(onDecide: ApprovalActionsProps["onDecide"]) {
  return render(
    <MemoryRouter>
      <ApprovalActions requestedAction={REQUESTED_ACTION} onDecide={onDecide} />
    </MemoryRouter>,
  );
}

describe("Approve (requirements 5.3, 13.11)", () => {
  it("issues exactly one request and locks every control until it resolves", async () => {
    const pending = deferred<DecisionOutcome>();
    const onDecide = vi.fn(() => pending.promise);
    renderActions(onDecide);

    const approve = screen.getByRole("button", { name: "Approve" });
    await userEvent.click(approve);

    // A second activation while the first is in flight issues nothing (Property 15).
    await userEvent.click(approve);
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith({ decision: "APPROVED", notes: "" });

    // The lock covers every control, not only the one that was pressed: there is
    // no second request left available to race the first.
    for (const label of ["Approve", "Edit", "Decline"]) {
      expect(screen.getByRole("button", { name: label })).toBeDisabled();
    }
    expect(screen.getByRole("status")).toHaveTextContent("Recording your decision…");

    pending.settle({ kind: "settled" });
  });
});

describe("Edit (requirement 5.5)", () => {
  it("pre-fills one field with the prepared action and shows the original for comparison", async () => {
    renderActions(vi.fn(settled));

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));

    // One labelled multi-line field, carrying the agent's action verbatim. No
    // per-field form: `_decide_approval` takes a single `edited_action` (A4).
    const field = screen.getByLabelText(EDIT_FIELD_LABEL);
    expect(field).toBeInstanceOf(HTMLTextAreaElement);
    expect(field).toHaveValue(REQUESTED_ACTION);

    // The original is rendered, and is attached to the field as its description,
    // so the comparison is available on the control itself and not only visually.
    expect(screen.getByText(ORIGINAL_ACTION_LABEL)).toBeInTheDocument();
    expect(field).toHaveAccessibleDescription(new RegExp(REQUESTED_ACTION));
  });

  it("submits EDITED with the field value as edited_action", async () => {
    const onDecide = vi.fn(settled);
    renderActions(onDecide);

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));

    const field = screen.getByLabelText(EDIT_FIELD_LABEL);
    await userEvent.clear(field);
    // `delay: null` types in one batch. The interaction is the same; it keeps a
    // controlled multi-line field off the per-keystroke path, which is the whole
    // cost of this test.
    await userEvent.type(field, EDITED_ACTION, { delay: null });
    await userEvent.click(screen.getByRole("button", { name: "Submit edit" }));

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith({
      decision: "EDITED",
      notes: "",
      editedAction: EDITED_ACTION,
    });
  });
});

describe("Decline (requirement 5.4)", () => {
  it("requires a note, says where the note goes, and submits it with the decline", async () => {
    const onDecide = vi.fn(settled);
    renderActions(onDecide);

    await userEvent.click(screen.getByRole("button", { name: "Decline" }));

    // Stated before submitting, not after (requirement 5.4).
    expect(screen.getByText(AUDIT_TRAIL_NOTICE)).toBeInTheDocument();

    // An empty note is refused in the browser, before any request.
    await userEvent.click(screen.getByRole("button", { name: "Submit decline" }));
    expect(onDecide).not.toHaveBeenCalled();

    const note = screen.getByLabelText("Why are you declining?");
    expect(note).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Add a note before declining. It is recorded in the audit trail.",
    );

    await userEvent.type(note, DECLINE_NOTE, { delay: null });
    await userEvent.click(screen.getByRole("button", { name: "Submit decline" }));

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith({ decision: "DECLINED", notes: DECLINE_NOTE });
  });
});
