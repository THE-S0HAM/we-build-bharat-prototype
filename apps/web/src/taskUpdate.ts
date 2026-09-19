/**
 * The task mutation — `PUT /events/{eventId}/teams/{teamId}/tasks/{taskId}`
 * (requirement 7.8).
 *
 * **Where this belongs.** `src/api.ts` is the product's single typed client and
 * this function belongs in it, beside `getTasks`. It lives here for the same
 * reason `src/speakerUpdate.ts` does: `api.ts` is shared by every workstream, so
 * Phase F keeps its additive surface there to the one read the team-first board
 * cannot exist without (`getTeams`). Folding this in later is a copy of
 * `updateTask` below plus deleting this file; only `src/pages/TaskBoard.tsx`
 * imports it. The transport is deliberately the same sequence `apiFetch`
 * performs — configuration check, token, organization from that same token,
 * `ApiError` on a non-2xx — and it reuses `api.ts`'s own exports for the
 * organization and the error type rather than re-deriving either (requirements
 * 16.2, 16.3, 16.4).
 *
 * **What it may send.** `services/api/tasks_handler.py` copies a fixed allowlist
 * of keys out of the body and ignores the rest. The fields this console is
 * cleared to send are `status`, `priority`, `assigned_to`, `due_date`,
 * `depends_on`, `blocks`, `escalation_level` and `notes`.
 * `TASK_UPDATE_FIELDS` is that set intersected with what `src/types.ts` models,
 * which drops `notes` — `Task` declares no `notes`, so the console holds no value
 * for it and offering one would mean editing a field the typed model does not
 * have (requirement 16.5). It becomes available here the day the type does. The
 * body is assembled by walking the allowlist, never by spreading a caller's
 * object, so an extra key cannot reach the wire.
 */

import { ApiError, getOrganizationContext, isMockMode } from "./api";
import { getIdToken } from "./auth";
import type { Task } from "./types";

/** Same read as `api.ts`: absent means this console is not configured. */
const API_BASE: string =
  typeof import.meta.env.VITE_API_URL === "string" ? import.meta.env.VITE_API_URL : "";

export const TASK_UPDATE_FIELDS = [
  "status",
  "priority",
  "assigned_to",
  "due_date",
  "depends_on",
  "blocks",
  "escalation_level",
] as const;

export type TaskUpdateField = (typeof TASK_UPDATE_FIELDS)[number];

/**
 * A task change: any subset of the allowed fields, typed from `Task` itself so a
 * value can never be the wrong shape for the field it is under.
 */
export type TaskUpdate = Partial<Pick<Task, TaskUpdateField>>;

/** What the console sends: the organization, plus the changed allowed fields. */
export type TaskUpdateBody = Readonly<{ organization_id: string } & TaskUpdate>;

/**
 * Copy one allowed field across, keeping the value's type tied to its key.
 *
 * An absent field stays absent rather than being sent as null: the handler copies
 * any key it finds, so sending a field the user did not touch would overwrite it
 * with this console's idea of "nothing".
 */
function copyField<K extends TaskUpdateField>(target: TaskUpdate, source: TaskUpdate, key: K): void {
  const value = source[key];

  if (value !== undefined) {
    target[key] = value;
  }
}

/**
 * Assemble the request body.
 *
 * Exported because "sends only the fields the endpoint allows" is a property of
 * this function, testable without a network.
 */
export function buildTaskUpdateBody(organizationId: string, changes: TaskUpdate): TaskUpdateBody {
  const allowed: TaskUpdate = {};

  for (const field of TASK_UPDATE_FIELDS) {
    copyField(allowed, changes, field);
  }

  return { organization_id: organizationId, ...allowed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Read the backend's failure payload for the two fields `ApiError` carries.
 * Neither reaches the screen — `ErrorState` renders reviewed copy only — but the
 * category is what selects that copy (design.md §12).
 */
async function failureFrom(response: Response): Promise<ApiError> {
  const payload: unknown = await response.json().catch(() => null);
  const message = isRecord(payload) && typeof payload.message === "string" ? payload.message : "";
  const category =
    isRecord(payload) && typeof payload.error === "string" ? payload.error : undefined;

  return new ApiError(
    message === "" ? `Request failed (HTTP ${response.status})` : message,
    response.status,
    category,
  );
}

/**
 * Apply a task change.
 *
 * Resolves with nothing: the endpoint answers with an acknowledgement rather than
 * the record, so the caller's in-place update is the change that was accepted and
 * never a value invented here (requirement 7.8).
 */
export async function updateTask(
  eventId: string,
  teamId: string,
  taskId: string,
  changes: TaskUpdate,
): Promise<void> {
  const { organizationId } = await getOrganizationContext();
  const body = buildTaskUpdateBody(organizationId, changes);

  if (isMockMode) {
    // Local UI work with no backend. The caller applies the change it made to its
    // own copy, which is all mock mode can honestly report; nothing is fabricated
    // about the write having reached a server.
    return;
  }

  if (API_BASE === "") {
    throw new ApiError(
      "No API URL is configured. Set VITE_API_URL to the deployed API, or VITE_USE_MOCK=true for local demo data.",
      0,
      "CONFIGURATION_ERROR",
    );
  }

  const token = await getIdToken();
  if (!token) {
    throw new ApiError("Your session has expired. Please sign in again.", 401, "UNAUTHORIZED");
  }

  const path = `/events/${encodeURIComponent(eventId)}/teams/${encodeURIComponent(
    teamId,
  )}/tasks/${encodeURIComponent(taskId)}`;

  const response = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw await failureFrom(response);
  }
}
