#!/usr/bin/env node
/**
 * MCP smoke test: walks the full task lifecycle (plus project scope and /state)
 * against a running Context Hub over real HTTP, asserting the derived state at
 * every step. Exits non-zero on the first mismatch.
 *
 * Usage: node scripts/mcp-smoke.mjs [endpoint]      (default http://127.0.0.1:3001/mcp)
 *
 * Complements test/e2e.mcp.test.ts (CI, in-process server): this one targets an
 * externally started `tut serve` — use it after every Hub change as a one-command
 * regression check.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ENDPOINT = process.argv[2] ?? "http://127.0.0.1:3001/mcp";
const STATE_URL = new URL("/state", ENDPOINT).href;

let passed = 0;
let failed = 0;

function ok(label) {
  passed++;
  console.log(`  ✓ ${label}`);
}

function fail(label, detail) {
  failed++;
  console.error(`  ✗ ${label}`);
  if (detail !== undefined) console.error(`    ${JSON.stringify(detail)}`);
}

function assert(cond, label, detail) {
  cond ? ok(label) : fail(label, detail);
  return cond;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) {
    const err = new Error(`${name} failed: ${text}`);
    err.toolResult = text;
    throw err;
  }
  return JSON.parse(text);
}

const run = async () => {
  const client = new Client({ name: "tut-smoke", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT)));
  console.log(`smoke against ${ENDPOINT}\n`);

  // --- task lifecycle -------------------------------------------------------
  const title = `smoke-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const created = await call(client, "context.create", {
    title,
    description: "smoke test walkthrough",
    creator: "smoke",
    role: "architect",
  });
  const taskId = created.task_id;
  assert(created.status === "designing" && created.version === 0,
    `create → designing (v0), task_id=${taskId}`, created);

  const pub = (content_type, role, payload, extra = {}) =>
    call(client, "context.publish", { task_id: taskId, role, content_type, payload, ...extra });

  let r = await pub("design", "architect", {
    summary: "smoke design", body: "## 背景与目标\nsmoke",
  });
  assert(r.status === "implementing", "design → implementing", r);

  r = await call(client, "context.read", { task_id: taskId });
  assert(r.status === "implementing" && r.versions.length === 1, "read → 1 version, implementing", r);

  r = await pub("code_changes", "executor", {
    summary: "smoke implementation", body: "## 实现概述\nsmoke", commits: ["a1b2c3d"],
  });
  assert(r.status === "reviewing", "code_changes (commits) → reviewing", r);
  const codeChangesVersion = r.version;

  r = await call(client, "context.read", { task_id: taskId });
  assert(JSON.stringify(r.versions[1]?.payload?.commits) === JSON.stringify(["a1b2c3d"]),
    "commits round-trip: [\"a1b2c3d\"]", r.versions[1]?.payload);

  // ref_version is a payload field (context-design 2.3/2.5), NOT a publish
  // input field — spreading it at the publish top level gets silently
  // stripped by zod and the reference chain never lands.
  r = await pub("review", "reviewer", {
    summary: "one issue found", body: "## 问题列表\n1. [high] …", verdict: "fail_code",
    ref_version: codeChangesVersion, // the code_changes this review reviews
  });
  assert(r.status === "revising", "review(fail_code) → revising", r);
  const failReviewVersion = r.version;

  r = await pub("revision", "executor", {
    summary: "fixed the issue", body: "## 对 review 的逐条回应\nfixed", commits: ["e4f5a6b"],
    ref_version: failReviewVersion, // the review this revision answers
  });
  assert(r.status === "reviewing", "revision → reviewing", r);
  const revisionVersion = r.version;

  r = await pub("review", "reviewer", {
    summary: "all clear", body: "## 总体评价\npass", verdict: "pass",
    ref_version: revisionVersion, // the revision this re-review clears
  });
  assert(r.status === "pending_approval" && r.needs_attention === false,
    "review(pass) → pending_approval, waiting for human", r);

  // Reference chain (context-design 2.5) must actually land in the stored
  // payloads — guards against ref_version sliding back to the wrong layer.
  r = await call(client, "context.read", { task_id: taskId });
  const codeChangesRec = r.versions.find((v) => v.version === codeChangesVersion);
  const failReviewRec = r.versions.find((v) => v.version === failReviewVersion);
  const revisionRec = r.versions.find((v) => v.version === revisionVersion);
  const passReviewRec = r.versions.find((v) => v.payload?.verdict === "pass");
  assert(failReviewRec?.payload?.ref_version === codeChangesRec?.version,
    "fail review payload.ref_version → the code_changes it reviews", failReviewRec?.payload);
  assert(revisionRec?.payload?.ref_version === failReviewRec?.version,
    "revision payload.ref_version → the fail_code review it answers", revisionRec?.payload);
  assert(passReviewRec?.payload?.ref_version === revisionRec?.version,
    "pass review payload.ref_version → the revision it clears", passReviewRec?.payload);

  r = await call(client, "context.decide", { task_id: taskId, decision: "approve", by: "smoke-human" });
  assert(r.status === "approved", "decide(approve) → approved", r);

  r = await call(client, "context.decide", {
    task_id: taskId, decision: "close", by: "smoke-human", reason: "smoke complete",
  });
  assert(r.status === "closed", "decide(close) → closed", r);

  // --- error surface --------------------------------------------------------
  const errResult = await client.callTool({
    name: "context.publish",
    arguments: { task_id: "no-such-task", role: "x", content_type: "note",
      payload: { summary: "s", body: "b" } },
  });
  assert(errResult.isError && errResult.content?.[0]?.text?.startsWith("TASK_NOT_FOUND"),
    "nonexistent task → isError TASK_NOT_FOUND", errResult.content?.[0]?.text);

  // --- project scope --------------------------------------------------------
  const pv = await call(client, "context.publish", {
    task_id: "project", role: "smoke", content_type: "note",
    payload: { summary: "smoke seed note", body: "smoke run marker" },
  });
  assert(!("status" in pv) && typeof pv.version === "number",
    `project publish (no create) → ok, no status key (v${pv.version})`, pv);

  const list = await call(client, "context.list", {});
  const projectEntry = list.tasks.find((t) => t.task_id === "project");
  const taskEntry = list.tasks.find((t) => t.task_id === taskId);
  assert(projectEntry?.scope === "project" && !("status" in projectEntry),
    "list → project entry has scope:project, no status", projectEntry);
  assert(taskEntry?.status === "closed", "list → smoke task closed", taskEntry);

  // --- /state ---------------------------------------------------------------
  const stateRes = await fetch(STATE_URL);
  const state = await stateRes.json();
  assert(stateRes.ok && state.flow_mode === "manual", `/state → flow_mode manual`, state);
  const stateEntry = state.tasks?.find((t) => t.task_id === taskId);
  assert(stateEntry?.status === "closed" && stateEntry?.waiting_for === "none",
    "/state → smoke task closed, waiting_for none", stateEntry);
  assert(!state.tasks?.some((t) => t.task_id === "project"),
    "/state → project scope excluded", state.tasks?.map((t) => t.task_id));

  await client.close();
};

try {
  await run();
} catch (e) {
  failed++;
  console.error(`  ✗ aborted: ${e.message}`);
}

console.log(`\n${failed === 0 ? "SMOKE PASSED" : "SMOKE FAILED"} (${passed} checks passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
