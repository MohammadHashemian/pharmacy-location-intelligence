import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Unit coverage for everything that is not a React tree.
 *
 * `src/lib` holds the analysis (SQL, scoring, formatting) and `src/app/api` holds the write
 * paths; both run in Node and can be measured with `v8` coverage. The components are covered
 * end-to-end by the Playwright suite in `tools/` — counting them here would report 0 % for
 * files that already have behavioural tests.
 *
 * Every test runs against a COPY of the database (see tests/setup.ts), never the live file.
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/lib/**/*.ts", "src/app/api/**/*.ts"],
      exclude: ["src/lib/db.ts"],
      thresholds: { lines: 70, functions: 70, statements: 70, branches: 60 },
    },
  },
});
