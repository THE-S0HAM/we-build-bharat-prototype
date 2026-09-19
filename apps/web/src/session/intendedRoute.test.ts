/**
 * The intended route is read back out of history state, which anything can
 * write and a reload replays. These checks cover what must never come back out
 * of it: an off-site destination, or `/login` itself.
 */

import { describe, expect, it } from "vitest";
import {
  intendedRouteState,
  isSafeIntendedRoute,
  readIntendedRoute,
} from "./intendedRoute";

describe("isSafeIntendedRoute", () => {
  it("accepts an in-app path, with its search and hash", () => {
    expect(isSafeIntendedRoute("/speakers")).toBe(true);
    expect(isSafeIntendedRoute("/events/EVT-devcon-2026/checkin?q=priya")).toBe(true);
    expect(isSafeIntendedRoute("/audit#top")).toBe(true);
  });

  it("rejects anything that could leave the application", () => {
    // Both forms are read as protocol-relative URLs by browsers, so a bare
    // startsWith("/") check would navigate off-site.
    expect(isSafeIntendedRoute("//evil.example/steal")).toBe(false);
    expect(isSafeIntendedRoute("/\\evil.example")).toBe(false);
    expect(isSafeIntendedRoute("https://evil.example")).toBe(false);
    expect(isSafeIntendedRoute("speakers")).toBe(false);
  });

  it("rejects the login route, which would bounce the visitor back", () => {
    expect(isSafeIntendedRoute("/login")).toBe(false);
    expect(isSafeIntendedRoute("/login?next=/audit")).toBe(false);
  });
});

describe("readIntendedRoute", () => {
  it("reads back the route that was retained", () => {
    expect(readIntendedRoute(intendedRouteState("/approvals"))).toBe("/approvals");
  });

  it("returns null when history state carries nothing usable", () => {
    expect(readIntendedRoute(null)).toBeNull();
    expect(readIntendedRoute(undefined)).toBeNull();
    expect(readIntendedRoute("/approvals")).toBeNull();
    expect(readIntendedRoute({})).toBeNull();
    expect(readIntendedRoute({ from: 42 })).toBeNull();
  });

  it("returns null rather than an unsafe destination", () => {
    expect(readIntendedRoute({ from: "https://evil.example" })).toBeNull();
    expect(readIntendedRoute({ from: "//evil.example" })).toBeNull();
  });
});
