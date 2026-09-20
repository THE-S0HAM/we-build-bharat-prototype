/**
 * The team directory reader (requirements 7.2, 7.3, design.md A5).
 *
 * `GET /events/{eventId}/teams` does not exist yet, and `apiFetch` asserts
 * response shapes rather than validating them. So "did a team directory actually
 * come back?" is a runtime question, and these are its answers.
 */

import { describe, expect, it } from "vitest";

import { readTeamDirectory } from "./teamDirectory";

const EVENT_ID = "EVT-1";

describe("readTeamDirectory", () => {
  it("reads the specified contract", () => {
    const directory = readTeamDirectory(
      {
        teams: [
          { team_id: "TEAM-9", event_id: EVENT_ID, name: "Venue crew", is_active: true },
          { team_id: "TEAM-4", event_id: EVENT_ID, name: "Comms crew", is_active: false },
        ],
        count: 2,
      },
      EVENT_ID,
    );

    expect(directory).toEqual({
      kind: "available",
      teams: [
        { team_id: "TEAM-9", event_id: EVENT_ID, name: "Venue crew", is_active: true },
        { team_id: "TEAM-4", event_id: EVENT_ID, name: "Comms crew", is_active: false },
      ],
    });
  });

  it("reports the directory absent when the response carries no teams (today's state)", () => {
    // The route does not exist, so nothing answers with a directory.
    expect(readTeamDirectory({}, EVENT_ID)).toEqual({ kind: "absent" });
    expect(readTeamDirectory({ teams: "soon" }, EVENT_ID)).toEqual({ kind: "absent" });
    expect(readTeamDirectory(null, EVENT_ID)).toEqual({ kind: "absent" });
    expect(readTeamDirectory("", EVENT_ID)).toEqual({ kind: "absent" });
  });

  it("treats an event with no teams as a real answer, not as an absent directory", () => {
    expect(readTeamDirectory({ teams: [], count: 0 }, EVENT_ID)).toEqual({
      kind: "available",
      teams: [],
    });
  });

  it("drops an entry with no identity, because no task request can be addressed to it", () => {
    const directory = readTeamDirectory(
      { teams: [{ name: "Nameless" }, { team_id: "TEAM-9", name: "Venue crew" }] },
      EVENT_ID,
    );

    expect(directory.kind).toBe("available");
    expect(directory.kind === "available" ? directory.teams.map((t) => t.team_id) : []).toEqual([
      "TEAM-9",
    ]);
  });

  it("reports absent when entries came back and not one of them carried an identity", () => {
    expect(readTeamDirectory({ teams: [{ name: "Nameless" }] }, EVENT_ID)).toEqual({
      kind: "absent",
    });
  });

  it("falls back to the identifier the API returned when a team has no name, never to a made-up one", () => {
    const directory = readTeamDirectory({ teams: [{ team_id: "TEAM-9" }] }, EVENT_ID);

    expect(directory).toEqual({
      kind: "available",
      teams: [{ team_id: "TEAM-9", event_id: EVENT_ID, name: "TEAM-9", is_active: true }],
    });
  });
});
