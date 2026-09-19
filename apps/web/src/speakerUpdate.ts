/**
 * The speaker mutation — `PUT /events/{eventId}/speakers/{speakerId}`
 * (requirement 6.5).
 *
 * **Where this belongs.** `src/api.ts` is the product's single typed client and
 * this function belongs in it, beside `decideApproval`. It lives here because
 * `api.ts` is owned by another workstream while Phase E lands, and a second
 * agent editing that file would conflict. Folding it in is a copy of
 * `updateSpeaker` below plus deleting this file; nothing else imports it except
 * `src/pages/SpeakerOps.tsx`. The transport is deliberately written as the exact
 * same sequence `apiFetch` performs — configuration check, token, organization
 * from the same token, `ApiError` on a non-2xx — and it reuses `api.ts`'s own
 * exports for the organization and the error type rather than re-deriving
 * either (requirements 16.2, 16.3, 16.4).
 *
 * **What it may send.** `services/api/speakers_handler.py::_update_speaker`
 * copies a fixed allowlist of keys out of the body and ignores everything else.
 * `SPEAKER_UPDATE_FIELDS` is that allowlist intersected with the fields
 * `src/types.ts` actually models, so the console can neither send a field the
 * endpoint would drop nor invent one the typed model has no value for. The body
 * is assembled by walking the allowlist — not by spreading the caller's object —
 * so an extra key on a caller's value cannot reach the wire (requirement 16.5).
 *
 * `organization_id` accompanies it because the handler rejects a body without
 * one, and it is resolved from the session's token here rather than accepted
 * from a caller (requirement 16.4).
 */

import { ApiError, getOrganizationContext, isMockMode } from "./api";
import { getIdToken } from "./auth";
import type { Speaker } from "./types";

/**
 * Same read as `api.ts`: absent is a valid state, and it means the console is
 * not configured rather than that the request should be attempted anyway.
 */
const API_BASE: string =
  typeof import.meta.env.VITE_API_URL === "string" ? import.meta.env.VITE_API_URL : "";

/**
 * The fields a speaker change may carry.
 *
 * The endpoint also accepts `name`, `email`, `phone`, `bio`,
 * `session_duration_minutes`, `travel_details`, `accommodation_details`,
 * `special_requirements`, `availability_notes`, `slides_submitted`,
 * `av_requirements` and `backup_for_speaker_id`. None of those are declared on
 * `Speaker` in `src/types.ts`, so the console holds no value for them and
 * offering them would mean rendering a field the typed model does not have
 * (requirement 16.5). They become available here the day the type does.
 */
export const SPEAKER_UPDATE_FIELDS = [
  "status",
  "topic",
  "session_type",
  "travel_required",
  "accommodation_required",
  "is_backup",
] as const;

export type SpeakerUpdateField = (typeof SPEAKER_UPDATE_FIELDS)[number];

/**
 * A speaker change: any subset of the allowed fields, typed from `Speaker`
 * itself so a value can never be the wrong shape for the field it is under.
 */
export type SpeakerUpdate = Partial<Pick<Speaker, SpeakerUpdateField>>;

/** What the console sends: the organization, plus the changed allowed fields. */
export type SpeakerUpdateBody = Readonly<
  { organization_id: string } & Partial<Pick<Speaker, SpeakerUpdateField>>
>;

/**
 * Assemble the request body.
 *
 * Exported because "sends only the fields the endpoint allows" is a property of
 * this function, testable without a network.
 */
export function buildSpeakerUpdateBody(
  organizationId: string,
  changes: SpeakerUpdate,
): SpeakerUpdateBody {
  // Assembled by walking the allowlist, so the key set of the result is bounded
  // by SPEAKER_UPDATE_FIELDS whatever else the caller's object carries.
  const allowed: SpeakerUpdate = {};

  for (const field of SPEAKER_UPDATE_FIELDS) {
    copyField(allowed, changes, field);
  }

  return { organization_id: organizationId, ...allowed };
}

/**
 * Copy one allowed field across, keeping the value's type tied to its key.
 *
 * The generic key is what makes this type-safe without a cast: `source[key]` and
 * `target[key]` are the same indexed type, so a boolean cannot land on `status`.
 */
function copyField<K extends SpeakerUpdateField>(
  target: SpeakerUpdate,
  source: SpeakerUpdate,
  key: K,
): void {
  const value = source[key];

  // An absent field is left absent rather than sent as null: the handler copies
  // any key it finds, so sending a field the user did not change would overwrite
  // it with the console's idea of "nothing".
  if (value !== undefined) {
    target[key] = value;
  }
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
  const category = isRecord(payload) && typeof payload.error === "string" ? payload.error : undefined;

  return new ApiError(
    message === "" ? `Request failed (HTTP ${response.status})` : message,
    response.status,
    category,
  );
}

/**
 * Apply a speaker change.
 *
 * Resolves with nothing: the endpoint answers `{ speaker_id, message }` and does
 * not return the updated record, so the caller's in-place row update is the
 * change it submitted and never a value invented here.
 */
export async function updateSpeaker(
  eventId: string,
  speakerId: string,
  changes: SpeakerUpdate,
): Promise<void> {
  const { organizationId } = await getOrganizationContext();
  const body = buildSpeakerUpdateBody(organizationId, changes);

  if (isMockMode) {
    // Local UI work with no backend. The caller applies the change it made to
    // its own copy, which is the whole of what mock mode can honestly report;
    // nothing is fabricated about the write having reached a server.
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

  const response = await fetch(
    `${API_BASE}/events/${encodeURIComponent(eventId)}/speakers/${encodeURIComponent(speakerId)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    throw await failureFrom(response);
  }
}
