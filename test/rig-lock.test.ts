import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireRigStartLock } from "../src/rig-lock.js";

let root: string;
let file: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "tut-start-lock-"));
  mkdirSync(path.join(root, ".context-hub"));
  file = path.join(root, ".context-hub/up.lock");
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it("does not treat permission-denied process probes as a dead owner", () => {
  const owner = JSON.stringify({ pid: 12345, started_at: new Date().toISOString() });
  writeFileSync(file, owner);
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error(), { code: "EPERM" }); });
  expect(() => acquireRigStartLock(root)).toThrow(`pid 12345`);
  expect(readFileSync(file, "utf8")).toBe(owner);
});

it("refuses an incomplete lock without guessing ownership or deleting it", () => {
  writeFileSync(file, "");
  expect(() => acquireRigStartLock(root)).toThrow("cannot verify startup lock");
  expect(readFileSync(file, "utf8")).toBe("");
});

it("does not retire a stale lock while another contender owns its recovery guard", () => {
  const owner = JSON.stringify({ pid: 12345, started_at: new Date().toISOString() });
  writeFileSync(file, owner);
  mkdirSync(`${file}.reclaim`);
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error(), { code: "ESRCH" }); });
  expect(() => acquireRigStartLock(root)).toThrow("startup lock recovery in progress");
  expect(readFileSync(file, "utf8")).toBe(owner);
});

it("release is idempotent and leaves a replacement owner untouched", () => {
  const release = acquireRigStartLock(root);
  release();
  expect(existsSync(file)).toBe(false);
  const replacement = JSON.stringify({ pid: 12345, started_at: "replacement" });
  writeFileSync(file, replacement);
  release();
  expect(readFileSync(file, "utf8")).toBe(replacement);
});
