import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * `global` is a Node identifier, not a browser one. `amazon-cognito-identity-js`
 * bundles a `buffer` polyfill that references it bare, so without this shim the
 * module throws `ReferenceError: global is not defined` the moment it is
 * evaluated. `src/auth.ts` then fails to load, `App.tsx` fails with it, and the
 * console renders a blank page with nothing in `#root`.
 *
 * Stated twice on purpose, because two separate esbuild passes need it:
 *   - `define` covers the application source and the production build;
 *   - `optimizeDeps.esbuildOptions.define` covers the dev-time dependency
 *     pre-bundle, which `define` does not reach. Omitting the second one leaves
 *     the bare `global` sitting in `node_modules/.vite/deps`, which is exactly
 *     where it was found.
 *
 * Replacing the identifier with `globalThis` is safe in both environments: it is
 * defined in browsers and in Node, so tests are unaffected.
 */
const BROWSER_GLOBAL_SHIM: Record<string, string> = { global: "globalThis" };

export default defineConfig({
  plugins: [react()],
  define: BROWSER_GLOBAL_SHIM,
  optimizeDeps: {
    esbuildOptions: { define: BROWSER_GLOBAL_SHIM },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    // Component and interaction tests need a DOM. The existing api.test.ts
    // suite is environment-agnostic (it stubs fetch and import.meta.env), so a
    // single global jsdom environment keeps one configuration for all tests.
    environment: "jsdom",
    // Registers Testing Library's DOM matchers and per-test cleanup.
    setupFiles: ["./src/test/setup.ts"],
    // Test globals stay off: every test file imports from "vitest" explicitly.
    globals: false,
  },
});
