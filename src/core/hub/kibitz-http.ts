/** Read-only data routes for Kibitz. The caller must apply the global Host guard. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { ErrorCode } from "../common/types.js";
import { validateId } from "../run/store.js";
import { LEGACY_TASK_ID_PATTERN, StoreError, type Store } from "./store.js";
import { LOG_RANGE_LIMIT, RunLogRangeError, type RunReadStore } from "./run-store.js";

export interface KibitzReadDeps { store: Store; runStore: RunReadStore }

function byteParameter(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const values = params.getAll(name);
  if (!values.length) return fallback;
  const value = values[0]!;
  const number = Number(value);
  if (values.length !== 1 || value.length === 0 || /\D/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`invalid ${name}`);
  }
  return number;
}

/**
 * GET|HEAD /tasks/:id/versions returns Store.readTask verbatim, including all
 * payload fields and project/closed/empty histories. Corrupt storage is a 500.
 * GET|HEAD /tasks/:id/usage returns the usage sidecar bytes unchanged; missing
 * tasks or sidecars are 404. No JSON parsing or totals aggregation.
 *
 * GET|HEAD /runs/:id/log?from=0&limit=65536 returns raw bytes as Base64; limit is
 * 1..65536. Follow with an independent cursor per reader: consume decoded data,
 * then set cursor=next; drain while !eof, otherwise poll later (e.g. after 1s).
 * Serialize each reader's requests, keep the cursor on empty pages/errors, and
 * use a streaming TextDecoder for text across byte boundaries. eof is only a
 * size snapshot. 416 includes from/size for stale cursors; 409 LOG_CHANGED means
 * truncation during a read. Neither error silently resets the cursor.
 * No server-side reader state, watchers, timers, writes or process probes.
 */
export async function handleKibitzRead(req: IncomingMessage, res: ServerResponse, deps: KibitzReadDeps): Promise<boolean> {
  // Match before WHATWG URL dot-segment/backslash normalization, then decode
  // exactly once. Invalid path segments must not become a different resource.
  const target = req.url ?? "/";
  const queryStart = target.indexOf("?");
  const pathname = queryStart === -1 ? target : target.slice(0, queryStart);
  const query = queryStart === -1 ? "" : target.slice(queryStart + 1);
  const task = /^\/tasks\/(.*)\/(versions|usage)$/.exec(pathname);
  const run = /^\/runs\/(.*)\/log$/.exec(pathname);
  if (!task && !run) return false;
  res.setHeader("Cache-Control", "no-store");
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    send(405, { error: "method not allowed: use GET or HEAD" });
    return true;
  }
  let id: string, from = 0, limit = LOG_RANGE_LIMIT;
  try {
    id = decodeURIComponent((task ?? run)![1]!);
    if (/[\/\\\0\r\n]/.test(id)) throw new Error("invalid path segment");
    if (task) {
      if (!LEGACY_TASK_ID_PATTERN.test(id)) throw new Error("invalid task-id");
    } else {
      validateId(id);
      const params = new URLSearchParams(query);
      from = byteParameter(params, "from", 0, 0, Number.MAX_SAFE_INTEGER);
      limit = byteParameter(params, "limit", LOG_RANGE_LIMIT, 1, LOG_RANGE_LIMIT);
    }
  } catch {
    send(400, { error: "invalid path or byte range" });
    return true;
  }
  try {
    if (task?.[2] === "usage") {
      const bytes = await deps.store.readUsageRaw(id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : bytes);
    } else {
      send(200, task ? await deps.store.readTask(id) : await deps.runStore.readLogRange(id, from, limit));
    }
  } catch (error) {
    if (task && error instanceof StoreError && error.code === ErrorCode.TASK_NOT_FOUND) {
      send(404, { error: "task not found" });
    } else if (task?.[2] === "usage" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      send(404, { error: "usage not found" });
    } else if (run && error instanceof RunLogRangeError) {
      send(error.code === "LOG_CHANGED" ? 409 : 416, { code: error.code, from: error.from, size: error.size });
    } else if (run && (error as NodeJS.ErrnoException).code === "ENOENT") {
      send(404, { error: "log not found" });
    } else {
      console.error("[context-hub] Kibitz read failed:", error);
      send(500, { error: "internal error" });
    }
  }
  return true;
}
