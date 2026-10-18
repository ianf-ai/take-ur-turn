import { readFile } from "node:fs/promises";
import { validateAgentRoute } from "../common/agent-command.js";
import type { Cast, Flow } from "../common/types.js";

/** A saved Notifier /state response, not a fresh Hub read after corruption. */
export async function readRepairSnapshot(file: string, taskId: string): Promise<{ title: string; flow?: Flow; cast?: Cast }> {
  const snapshot = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(snapshot?.tasks)) throw new Error("expected a saved /state response with tasks");
  const entries = snapshot.tasks.filter((t: unknown) => t !== null && typeof t === "object" &&
    (t as { task_id?: unknown }).task_id === taskId);
  if (entries.length !== 1) throw new Error(`expected exactly one snapshot entry for ${taskId}`);
  const entry = entries[0];
  if (typeof entry.title !== "string" || !entry.title.trim()) throw new Error("snapshot title is invalid");
  if (entry.flow !== undefined && !["full", "direct", "solo"].includes(entry.flow)) throw new Error("snapshot flow is invalid");
  let cast: Cast | undefined;
  if (entry.cast !== undefined) {
    if (entry.cast === null || typeof entry.cast !== "object" || Array.isArray(entry.cast)) throw new Error("snapshot cast is invalid");
    cast = {};
    for (const [role, route] of Object.entries(entry.cast)) {
      if (role !== "architect" && role !== "executor" && role !== "reviewer") throw new Error("snapshot cast role is invalid");
      cast[role] = validateAgentRoute(route, `snapshot cast ${role}`);
    }
  }
  return { title: entry.title, ...(entry.flow !== undefined ? { flow: entry.flow as Flow } : {}),
    ...(cast !== undefined ? { cast } : {}) };
}
