import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    // Pure unit tests for meter-calculator run in Node — no browser DOM needed.
    // If you add React component tests in the future, switch to "jsdom".
    environment: "node",
    globals:     true,
    coverage: {
      provider:  "v8",
      reporter:  ["text", "json", "html"],
      reportsDirectory: "./coverage",
      include:   ["src/lib/billing/**/*.ts"],
      exclude:   ["src/lib/billing/__tests__/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
