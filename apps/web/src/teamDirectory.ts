/**
 * The team directory — the one source of team identity in the console
 * (requirements 7.2, 7.3, design.md A5).
 *
 * `TaskBoard.tsx` used to hold six team ids and fan a request out per id. That
 * made the console the author of the organization's team structure: a team the
 * organization does not have appeared on screen, and a team it does have could
 * not. Every team identifier now originates in `GET /events/{eventId}/teams` and
 * nowhere else, which is the whole of requirement 7.2.
 *
 * That route does not exist yet (A5), so this module has one more job: decide,
 * at runtime, whether a team directory actually came back. `apiFetch` asserts
 * response shapes rather than validating them — see `src/lib/unknownValue.ts` —
 * so `getTeams` resolving is not evidence that a directory exists. Today the
 * request either fails or answers something that carries no `teams`, and both
 * resolve here to `absent`, which the page renders as "Team directory
 * unavailable".
 *
 * Nothing in this file names a team. It reads them, or reports that it cannot.
 */

import { getTeams } from "./api";
import type { Team } from "./types";

/**
 * What the console knows about this event's teams.
 *
 * `absent` is the honest third state between "here are the teams" and a thrown
 * failure: the request resolved, and what it resolved with is not a team
 * directory. A `teams: []` response is *not* absent — an event with no teams is
 * a real answer, and the page says so.
 */
export type TeamDirectory =
  | { readonly kind: "available"; readonly teams: readonly Team[] }
  | { readonly kind: "absent" };

const ABSENT: TeamDirectory = { kind: "absent" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();

  return text === "" ? null : text;
}

/**
 * One directory entry as a `Team`, or `null` when it carries no identity.
 *
 * An entry without a usable `team_id` is dropped rather than repaired: the id is
 * what every task request is addressed to, and there is no honest value for it
 * that this console could supply. A named-but-anonymous team is impossible; an
 * identified-but-unnamed one is not, so a missing `name` falls back to the id —
 * still a value the API returned, never one invented here.
 *
 * @param fallbackEventId the event the directory was requested for, used only
 * when the record omits `event_id`. It is never rendered.
 */
function asTeam(value: unknown, fallbackEventId: string): Team | null {
  if (!isRecord(value)) {
    return null;
  }

  const teamId = readString(value.team_id);
  if (teamId === null) {
    return null;
  }

  return {
    team_id: teamId,
    event_id: readString(value.event_id) ?? fallbackEventId,
    name: readString(value.name) ?? teamId,
    // Absent means nothing about activity, and a team the API returned is part of
    // the directory either way. `true` keeps it visible; only an explicit
    // `false` marks it as stood down.
    is_active: typeof value.is_active === "boolean" ? value.is_active : true,
  };
}

/**
 * Read a `GET /events/{eventId}/teams` response.
 *
 * Typed `unknown` on purpose: the point of this function is that the declared
 * response type is a contract the network has not honoured yet.
 */
export function readTeamDirectory(response: unknown, eventId: string): TeamDirectory {
  if (!isRecord(response) || !Array.isArray(response.teams)) {
    return ABSENT;
  }

  const teams: Team[] = [];

  for (const entry of response.teams) {
    const team = asTeam(entry, eventId);

    if (team !== null) {
      teams.push(team);
    }
  }

  // Entries were returned, and not one of them carried an identity: the console
  // cannot address a task request to any of them, so there is no directory here.
  if (teams.length === 0 && response.teams.length > 0) {
    return ABSENT;
  }

  return { kind: "available", teams };
}

/**
 * Fetch the event's team directory.
 *
 * Rejects only when the request itself failed, so the caller can tell "the
 * contract answered with no directory" (resolves `absent`) from "the request
 * failed" (rejects, and the page reports it through `useApiFailure`). Both
 * render the same unavailable state; only one of them offers a retry.
 */
export async function loadTeamDirectory(eventId: string): Promise<TeamDirectory> {
  return readTeamDirectory(await getTeams(eventId), eventId);
}
