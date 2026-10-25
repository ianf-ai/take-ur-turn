import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Optional artifacts from the actual npm test entry, without changing
    // selection, assertions or the default local reporter.
    ...(process.env.TUT_TEST_REPORT_JSON ? {
      reporters: ["verbose" as const, "json" as const],
      outputFile: process.env.TUT_TEST_REPORT_JSON,
    } : {}),
    // Native Windows fixture hops include CLR + Node startup. Keep product
    // probe/deadline budgets unchanged; give multi-hop integration cases room.
    hookTimeout: process.platform === "win32" ? 90_000 : 10_000,
    testTimeout: process.platform === "win32" ? 60_000 : 5_000,
    // See test/setup.ts: pins the escalation event port to a dead port so
    // delivery suites never leak fixture events into a live notifier.
    setupFiles: ["./test/setup.ts"],
    globalSetup: ["./test/global-setup.ts"],
    // Keep suites serial: integration fixtures share build artifacts and
    // process-level resources.
    fileParallelism: false,
  },
});
