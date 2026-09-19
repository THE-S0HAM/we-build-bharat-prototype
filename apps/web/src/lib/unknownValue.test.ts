/**
 * The two helpers that keep a status table honest when the backend returns a
 * value outside the union `src/types.ts` declares.
 */

import { describe, expect, it } from "vitest";

import { humaniseUnknownValue, readTableEntry } from "./unknownValue";

const TABLE = { LOW: "Low risk", HIGH: "High risk" } as const;

describe("readTableEntry", () => {
  it("returns the entry for a key the table holds", () => {
    expect(readTableEntry(TABLE, "HIGH")).toBe("High risk");
  });

  it("returns undefined for a value outside the union rather than throwing", () => {
    const fromBackend: string = "SEVERE";

    expect(readTableEntry(TABLE, fromBackend as keyof typeof TABLE)).toBeUndefined();
  });

  it("treats an inherited property name as absent", () => {
    const fromBackend: string = "toString";

    expect(readTableEntry(TABLE, fromBackend as keyof typeof TABLE)).toBeUndefined();
  });
});

describe("humaniseUnknownValue", () => {
  it("reads SCREAMING_SNAKE_CASE as a sentence", () => {
    expect(humaniseUnknownValue("AWAITING_PAYMENT")).toBe("Awaiting payment");
  });

  it("returns null when there is no readable content to show", () => {
    expect(humaniseUnknownValue("   ")).toBeNull();
    expect(humaniseUnknownValue("__")).toBeNull();
  });
});
