import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Files run serially: several suites deterministically hide the shared
    // scripts/workspace.json + routes.json to pin the routing chain to
    // DEFAULT_ROLES — concurrent renames of the same files would race.
    fileParallelism: false,
  },
});
