/**
 * The task mutation body (requirement 7.8, 16.5).
 *
 * "Restricted to the fields that endpoint allows" is a property of
 * `buildTaskUpdateBody`, so it is checked here without a network: the body is
 * assembled by walking the allowlist, which is what makes the key set bounded
 * whatever a caller's object carries.
 */

import { describe, expect, it } from "vitest";

import { buildTaskUpdateBody, TASK_UPDATE_FIELDS, type TaskUpdate } from "./taskUpdate";

const ORG = "ORG-test";

describe("buildTaskUpdateBody", () => {
  it("carries the organization and only the fields that changed", () => {
    expect(buildTaskUpdateBody(ORG, { status: "BLOCKED" })).toEqual({
      organization_id: ORG,
      status: "BLOCKED",
    });
  });

  it("sends every allowed field when every allowed field changed", () => {
    const changes: TaskUpdate = {
      status: "OVERDUE",
      priority: "CRITICAL",
      assigned_to: "Asha",
      due_date: "2026-10-14T18:00:00Z",
      depends_on: ["TSK-9"],
      blocks: ["TSK-3"],
      escalation_level: 2,
    };

    expect(Object.keys(buildTaskUpdateBody(ORG, changes)).sort()).toEqual(
      ["organization_id", ...TASK_UPDATE_FIELDS].sort(),
    );
  });

  it("drops a key the endpoint does not accept, even when a caller supplies one", () => {
    // Typed callers cannot express this, but a value arriving from elsewhere can.
    const smuggled: TaskUpdate = JSON.parse(
      '{"status":"COMPLETED","title":"renamed","notes":"hi","organization_id":"ORG-other"}',
    ) as TaskUpdate;

    const body = buildTaskUpdateBody(ORG, smuggled);

    expect(body).toEqual({ organization_id: ORG, status: "COMPLETED" });
    expect(Object.keys(body)).not.toContain("title");
    // `notes` is on the endpoint's allowlist but not on the typed `Task` model, so
    // the console holds no value for it and never sends one (requirement 16.5).
    expect(Object.keys(body)).not.toContain("notes");
  });

  it("leaves an untouched field absent rather than sending it as empty", () => {
    expect(buildTaskUpdateBody(ORG, {})).toEqual({ organization_id: ORG });
  });
});
