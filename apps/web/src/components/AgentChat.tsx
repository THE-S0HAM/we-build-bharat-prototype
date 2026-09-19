/**
 * The operations chat.
 *
 * Talks to `POST /agent/chat`, which runs the existing 30-tool Bedrock Converse loop. There is no
 * second agent implementation here — this component sends a message and renders what comes back.
 *
 * Two things it does that a generic chat UI would not:
 *
 * 1. **Shows what the answer relied on.** Each assistant turn lists the tools it called. An answer
 *    whose sources are visible is one a leader can check, and it makes the difference between "the
 *    agent read your budget" and "the agent said a number" legible.
 *
 * 2. **Renders the approval gate honestly.** When a turn raised an approval, the reply is marked as
 *    prepared-and-waiting rather than done. The backend already phrases it that way; this makes it
 *    visually unmissable, because "I have prepared this" and "I have done this" are the difference
 *    the whole product rests on.
 */

import { useEffect, useRef, useState } from "react";

import { ApiError, agentChat } from "../api";
import type { AgentChatResponse, Role } from "../types";

interface Turn {
  role: "user" | "assistant";
  content: string;
  toolsUsed?: string[];
  approvalsCreated?: string[];
  truncated?: boolean;
  failed?: boolean;
}

/** Openers that exercise different parts of the operational state. */
const LEADER_SUGGESTIONS = [
  "What needs my attention?",
  "Which teams are blocked?",
  "How much budget remains?",
  "Why is this event orange?",
  "Which speakers need follow-up?",
  "Prepare today's operations brief.",
];

const MEMBER_SUGGESTIONS = [
  "What are my tasks?",
  "What is overdue on my team?",
  "What incidents are open?",
  "What is my team working on?",
];

export function AgentChat({
  eventId,
  role,
  funMode = false,
  onApprovalCreated,
  compact = false,
}: {
  eventId: string;
  role: Role;
  funMode?: boolean;
  /** Fired when a turn raised an approval, so the surrounding page can refresh its counts. */
  onApprovalCreated?: (approvalIds: string[]) => void;
  compact?: boolean;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const logRef = useRef<HTMLDivElement>(null);

  const suggestions = role === "LEADER" ? LEADER_SUGGESTIONS : MEMBER_SUGGESTIONS;

  // Keep the newest turn in view as the conversation grows.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [turns, busy]);

  async function send(message: string) {
    const text = message.trim();
    if (!text || busy) return;

    setTurns((prev) => [...prev, { role: "user", content: text }]);
    setDraft("");
    setBusy(true);

    try {
      const response: AgentChatResponse = await agentChat({
        message: text,
        session_id: sessionId,
        event_id: eventId,
        fun_mode: funMode,
      });
      setSessionId(response.session_id);
      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          content: response.reply,
          toolsUsed: response.tools_used,
          approvalsCreated: response.approvals_created,
          truncated: response.truncated,
        },
      ]);
      if (response.approvals_created.length > 0) {
        onApprovalCreated?.(response.approvals_created);
      }
    } catch (err) {
      // Rendered as a failed turn rather than a toast, so the conversation keeps its shape and the
      // user can see which question did not get answered.
      const message =
        err instanceof ApiError
          ? err.message
          : "The assistant could not be reached. Your operational data is unaffected.";
      setTurns((prev) => [...prev, { role: "assistant", content: message, failed: true }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat" style={compact ? { height: 460 } : undefined}>
      <div className="chat-log" ref={logRef} aria-live="polite" aria-label="Conversation">
        {turns.length === 0 && (
          <div className="stack-sm">
            <p className="t-body">
              Ask about the operation. Every figure comes from a live lookup, so answers reflect the
              current state rather than a cached summary.
            </p>
            <p className="t-meta">
              {role === "LEADER"
                ? "Consequential actions are prepared for your approval, never performed."
                : "You can see your own teams and tasks. Decisions are reserved for community leaders."}
            </p>
          </div>
        )}

        {turns.map((turn, index) => (
          <div key={index} className={`chat-turn ${turn.role}`}>
            {turn.role === "assistant" && <div className="chat-byline">CommunityOps</div>}
            <div
              className="chat-bubble"
              style={
                turn.failed
                  ? {
                      background: "var(--status-blocked-bg)",
                      color: "var(--status-blocked)",
                    }
                  : undefined
              }
            >
              {turn.content}
            </div>

            {/* Approvals first: the most important thing about a reply is whether it acted. */}
            {turn.approvalsCreated && turn.approvalsCreated.length > 0 && (
              <div className="chat-approval">
                <strong>Prepared, not performed.</strong> This needs your decision —{" "}
                {turn.approvalsCreated.join(", ")}. Open Approvals to approve, edit or decline.
              </div>
            )}

            {turn.truncated && (
              <div className="t-meta" style={{ color: "var(--status-at-risk)" }}>
                The answer was cut short. Try asking about one thing at a time.
              </div>
            )}

            {turn.toolsUsed && turn.toolsUsed.length > 0 && (
              <div className="chat-evidence" aria-label="Lookups used for this answer">
                {turn.toolsUsed.map((tool, i) => (
                  <span className="chat-tool" key={`${tool}-${i}`}>
                    {tool}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}

        {busy && (
          <div className="chat-turn assistant">
            <div className="chat-byline">CommunityOps</div>
            <div className="chat-bubble">
              <span className="chat-typing" aria-label="Thinking">
                <span />
                <span />
                <span />
              </span>
            </div>
          </div>
        )}
      </div>

      {turns.length === 0 && (
        <div className="chat-suggestions">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              className="chat-suggestion"
              type="button"
              onClick={() => send(suggestion)}
              disabled={busy}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      <form
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <label className="sr-only" htmlFor="agent-input">
          Ask CommunityOps
        </label>
        <textarea
          id="agent-input"
          className="textarea"
          rows={1}
          placeholder="Ask CommunityOps anything about this event…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. Standard for a chat composer.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(draft);
            }
          }}
          disabled={busy}
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
