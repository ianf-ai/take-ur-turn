/** Rig identity is the owning Hub root, never the task checkout or routing root. */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";


export function rigHash(root: string): string {
  let normalized = root.startsWith("<") ? root : path.resolve(root);
  try {
    normalized = realpathSync(normalized);
  } catch {
    // Preview roots may not exist.
  }
  return createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

export function rigLabel(label: string, root: string): string {
  return `${label}-${rigHash(root)}`;
}

export function unscopedLabel(label: string, root: string): string | undefined {
  const suffix = `-${rigHash(root)}`;
  return label.endsWith(suffix) ? label.slice(0, -suffix.length) : undefined;
}

export function rigEnvironment(root: string, hubUrl: string, eventUrl: string): Record<string, string> {
  return { TUT_HUB_ROOT: root, TUT_HUB_URL: hubUrl, TUT_EVENT_PORT_URL: eventUrl };
}

export function paneEnvArgs(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}
