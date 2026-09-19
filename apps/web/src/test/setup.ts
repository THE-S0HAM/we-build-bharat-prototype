/**
 * Test setup.
 *
 * Registers the DOM matchers and guarantees the DOM is torn down between tests. Without the
 * cleanup, a `getByText` in one test can match a node left behind by a previous one, which
 * produces passes that mean nothing.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
