/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
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
    // jsdom rather than node, because the tests that matter here render components and assert on
    // what a person would actually see. The pure-function tests run fine under it too, so one
    // environment covers both rather than splitting the suite by environment.
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Explicit imports from "vitest" in every test file, so nothing is injected globally except
    // the DOM matchers the setup file registers.
    globals: false,
    css: false,
  },
});
