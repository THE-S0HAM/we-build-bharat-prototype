/**
 * The incident mutation — `PUT /events/{eventId}/incidents/{incidentId}`
 * (requirement 8.8).
 *
 * **Where this belongs.** `src/api.ts` is the product's single typed client and
 * this function belongs in it, beside `decideApproval`. It lives here for the
 * same reason `src/speakerUpdate.ts` does: `api.ts` is owned by another
 * workstream while Phase G lands, and two agents in one file conflict. Folding it
 * in is a copy of `updateIncident` below plus deleting this file; nothing else
 * imports it except `src/pages/IncidentCenter.tsx`. The transport is the exact
 * sequence `apiFetch` performs — configuration check, token, organization from
 * that same token, `ApiError` on a non-2xx — and it reuses `api.ts`'s own exports
 * rather than re-deriving either (requirements 16.2, 16.3, 16.4).
 *
 * **What it may send.** `services/api/incidents_handler.py::_update_incident`
 * copies a fixed allowlist out of the body — title, description, severity,
 * status, impact_analysis, dependencies, backup_options, recommendation,
 * evidence, resolution_summary — and ignores everything else. `approval_id` is
 * deliberately not on it, which is why the incident→approval relationship is
 * derived rather than stored (requirement 8.6).
 *
 * `INCIDENT_UPDATE_FIELDS` is that allowlist narrowed to the two fields a leader
 * decides: how severe this is, and where it stands. The rest of the allowlist is
 * CommunityOps' own analysis — the impact, the dependencies, the recommendation,
 * the evidence it rests on. The page's whole thesis is that the leader decides on
 * a prepared proposal instead of rewriting it, so the console does not offer to
 * author the agent's analysis. Both fields are declared on `Incident` in
 * `src/types.ts`, so the caller can also apply the accepted change to its own row
 * without inventing a value (requirement 16.5).
 *
 * The body is assembled by walking the allowlist rather than by spreading the
 * caller's object, so an extra key on a caller's value cannot reach the wire.
 * `organization_id` accompanies it because the handler rejects a body without
 * one, and it is resolved from the session's token here rather than accepted from
 * a caller (requirement 16.4).
 */

import { ApiError, getOrganizationContext, isMockMode } from "./api";
import { getIdToken } from "./auth";
import type { Incident } from "./types";

/** Same read as `api.ts`: absent means "not configured", not "try anyway". */
const API_BASE: string =
  typeof import.meta.env.VITE_API_URL === "string" ? import.meta.env.VITE_API_URL : "";

export const INCIDENT_UPDATE_FIELDS = ["status", "severity"] as const;

export type IncidentUpdateField = (typeof INCIDENT_UPDATE_FIELDS)[number];

/**
 * An incident change: any subset of the allowed fields, typed from `Incident`
 * itself so a value can never be the wrong shape for the field it is under.
 */
export type IncidentUpdate = Partial<Pick<Incident, IncidentUpdateField>>;

/** What the console sends: the organization, plus the changed allowed fields. */
export type IncidentUpdateBody = Readonly<
  { organization_id: string } & Partial<Pick<Incident, IncidentUpdateField>>
>;

/**
 * Assemble the request body.
 *
 * Exported because "sends only the fields the endpoint allows" is a property of
 * this function, testable without a network.
 */
export function buildIncidentUpdateBody(
  organizationId: string,
  changes: IncidentUpdate,
): IncidentUpdateBody {
  const allowed: IncidentUpdate = {};

  for (const field of INCIDENT_UPDATE_FIELDS) {
    copyField(allowed, changes, field);
  }

  return { organization_id: organizationId, ...allowed };
}

/**
 * Copy one allowed field across, keeping the value's type tied to its key.
 *
 * The generic key is what makes this type-safe without a cast: `source[key]` and
 * `target[key]` are the same indexed type.
 */
function copyField<K extends IncidentUpdateField>(
  target: IncidentUpdate,
  source: IncidentUpdate,
  key: K,
): void {
  const value = source[key];

  // An absent field stays absent: the handler copies any key it finds, so
  // sending an unchanged field would overwrite it with the console's idea of
  // "nothing".
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
 * Apply an incident change.
 *
 * Resolves with nothing: the endpoint answers `{ incident_id, message }` and not
 * the updated record, so the caller's in-place row update is the change it
 * submitted and never a value invented here.
 */
export async function updateIncident(
  eventId: string,
  incidentId: string,
  changes: IncidentUpdate,
): Promise<void> {
  const { organizationId } = await getOrganizationContext();
  const body = buildIncidentUpdateBody(organizationId, changes);

  if (isMockMode) {
    // Local UI work with no backend. The caller applies the change it made to its
    // own copy, which is all mock mode can honestly report.
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
    `${API_BASE}/events/${encodeURIComponent(eventId)}/incidents/${encodeURIComponent(incidentId)}`,
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
