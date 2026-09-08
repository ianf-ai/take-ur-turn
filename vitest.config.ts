import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // See test/setup.ts: pins the escalation event port to a dead port so
    // delivery suites never leak fixture events into a live notifier.
    setupFiles: ["./test/setup.ts"],
    // Files run serially: several suites deterministically hide the shared
    // scripts/workspace.json + routes.json to pin the routing chain to
    // DEFAULT_ROLES — concurrent renames of the same files would race.
    fileParallelism: false,
  },
});
