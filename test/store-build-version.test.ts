import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const manifest = vi.hoisted(() => ({ mode: "missing" }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (String(args[0]).endsWith("/package.json")) {
        if (manifest.mode === "corrupt") return "{broken";
        throw Object.assign(new Error(manifest.mode), { code: manifest.mode === "missing" ? "ENOENT" : "EACCES" });
      }
      return actual.readFileSync(...args);
    },
  };
});

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

it.each(["missing", "corrupt", "unreadable"])("appends without tut_version when the build manifest is %s", async (mode) => {
  manifest.mode = mode;
  vi.resetModules();
  const { Store } = await import("../src/hub/store.js");
  root = mkdtempSync(path.join(os.tmpdir(), "tut-manifest-"));
  const store = new Store(root);
  const { task_id } = await store.createTask({ title: "version fallback", description: "test", creator: "human", role: "executor" });
  await store.append(task_id, { role: "executor", content_type: "note", payload: { summary: "test", body: "test" } });
  const read = await store.readTask(task_id);
  expect(read.versions).toHaveLength(1);
  expect(read.versions[0]).not.toHaveProperty("tut_version");
});
