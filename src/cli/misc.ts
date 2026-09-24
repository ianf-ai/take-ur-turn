import { resolveRigRoot } from "../hub/rig-discovery.js";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hubList, type HubListEntry, type HubListResult } from "../hub/hub-client.js";
import { renderDoctorReport, runDoctor as runDoctorChecks } from "../doctor/index.js";
import { DEFAULT_HUB_URL, cliFetchInit, isHubUnreachable, hubUnreachableLine, printJson, ATTENTION_MARKER, colWidth, padRow, failWith } from "./shared.js";
import { type ParsedArgs } from "./args.js";

// --- tut repair-meta / recover-record (storage repair clients, 4.3) ----------------

/**
 * Shared client for the two repair endpoints (system-design 4.3): POST the
 * JSON body to the running hub — repairs must go through the hub's
 * single-writer queue, never a second process writing files directly. Owns
 * the failure surface the same way tut mode does: a network-level failure
 * prints the unified HUB_UNREACHABLE line (with the tut serve remedy), an
 * HTTP-level failure the "HTTP <status>: <error>" one-liner. Returns the
 * process exit code.
 */
async function runRepairPost(pathname: string, url: string, body: unknown, command: string): Promise<number> {
  let res: Response;
  try {
    res = await fetch(new URL(pathname, url), cliFetchInit({
      method: "POST",
      headers: { "content-type": "application/json", Connection: "close" },
      body: JSON.stringify(body),
    }));
  } catch (e) {
    process.stderr.write(
      isHubUnreachable(e)
        ? hubUnreachableLine(url, e)
        : `tut: cannot reach Hub at ${url} (is tut serve running?): ${(e as Error).message}\n`,
    );
    return 1;
  }
  const out = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || out === null) {
    const error = typeof out?.error === "string" ? out.error : "unexpected response";
    process.stderr.write(`tut: ${command} failed: HTTP ${res.status}: ${error}\n`);
    return 1;
  }
  printJson(out);
  return 0;
}

/** tut repair-meta — A-class rebuild of a corrupt meta.json (system-design 4.3). */
async function runRepairMeta(parsed: Extract<ParsedArgs, { command: "repair-meta" }>): Promise<number> {
  return runRepairPost("/repair-meta", parsed.url, {
    task_id: parsed.task_id,
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(parsed.creator !== undefined ? { creator: parsed.creator } : {}),
    ...(parsed.createdAt !== undefined ? { created_at: parsed.createdAt } : {}),
    ...(parsed.flow !== undefined ? { flow: parsed.flow } : {}),
    ...(parsed.cast !== undefined ? { cast: parsed.cast } : {}),
    ...(parsed.checkout !== undefined ? { checkout: parsed.checkout } : {}),
  }, "repair-meta");
}

/** tut recover-record — B-class recovery registration (system-design 4.3). */
async function runRecoverRecord(parsed: Extract<ParsedArgs, { command: "recover-record" }>): Promise<number> {
  return runRepairPost("/recover-record", parsed.url, {
    task_id: parsed.task_id,
    record_file: parsed.recordFile,
    from_path: parsed.from,
    ...(parsed.source !== undefined ? { source: parsed.source } : {}),
  }, "recover-record");
}

/**
 * tut status ordering: needs_attention tasks first, then updated_at newest
 * first, task_id ascending as the stable final key. Plain string compares —
 * updated_at is an ISO-8601 UTC string (lexicographic == chronological) and
 * locale-aware compares would vary by environment.
 */
function statusEntryOrder(a: HubListEntry, b: HubListEntry): number {
  const attDiff = Number(b.needs_attention === true) - Number(a.needs_attention === true);
  if (attDiff !== 0) return attDiff;
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
  if (a.task_id !== b.task_id) return a.task_id < b.task_id ? -1 : 1;
  return 0;
}

/**
 * The one status snapshot both views share: task-scope entries only (project
 * is long-lived memory, not a lifecycle task) in status order. Entries pass
 * through verbatim — the CLI adds nothing and re-derives nothing.
 */
function statusSnapshot(result: HubListResult): HubListEntry[] {
  return result.tasks.filter((t) => t.scope !== "project").sort(statusEntryOrder);
}

/** Human rendering of tut status: summary line + fixed-column task table. */
function renderStatus(result: HubListResult): string {
  const tasks = statusSnapshot(result);
  if (tasks.length === 0) return "no tasks\n";
  const attention = tasks.filter((t) => t.needs_attention === true).length;
  const closed = tasks.filter((t) => t.status === "closed").length;
  const rows = tasks.map((t) => [
    t.needs_attention === true ? ATTENTION_MARKER : "",
    t.task_id,
    t.status ?? "-",
    t.waiting_for ?? "-",
    t.updated_at,
    t.title,
  ]);
  const widths = [
    colWidth("att", rows, 0),
    colWidth("task_id", rows, 1),
    colWidth("status", rows, 2),
    colWidth("waiting_for", rows, 3),
    colWidth("updated_at", rows, 4),
  ];
  const lines = [
    `${tasks.length} tasks, ${attention} needs attention, ${closed} closed`,
    "",
    padRow(["att", "task_id", "status", "waiting_for", "updated_at", "title"], [...widths, 0]),
    ...rows.map((r) => padRow(r, widths)),
  ];
  return `${lines.join("\n")}\n`;
}

async function runStatus(parsed: Extract<ParsedArgs, { command: "status" }>): Promise<number> {
  try {
    const result = await hubList(parsed.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL);
    if (parsed.json) printJson({ tasks: statusSnapshot(result) });
    else process.stdout.write(renderStatus(result));
    return 0;
  } catch (e) {
    return failWith(e, parsed.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL);
  }
}

/** tut doctor — report-only self-check. Both faces (text and --json) draw
 *  from the SAME DoctorReport; runDoctor's robustness contract is that it
 *  never rejects (a bad input becomes that check's failure item), so the
 *  exit code is purely report.ok. Warnings do not flip it. */
async function runDoctor(parsed: Extract<ParsedArgs, { command: "doctor" }>, identityError?: unknown, hubRoot = resolveRigRoot()): Promise<number> {
  const report = await runDoctorChecks({
    root: parsed.root, url: parsed.url, hubRoot,
    // Keep offline diagnostics available without reading an unverified Hub.
    ...(identityError === undefined ? {} : { fetchImpl: (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/state") throw identityError;
      return fetch(input, init);
    }) as typeof fetch }),
  });
  if (parsed.json) printJson(report);
  else process.stdout.write(`${renderDoctorReport(report)}\n`);
  return report.ok ? 0 : 1;
}

// --- tut skill / tut init -----------------------------------------------------

/**
 * The skills directory shipped in the package, resolved module-relative
 * (../skills — one directory up from src/cli.ts and dist/cli.js alike;
 * identical for npm install, git clone, and npm link layouts).
 */
const SKILLS_DIR = fileURLToPath(new URL("../../skills/", import.meta.url));

/** The marked block `tut init` maintains in a project's AGENTS.md. */
function agentsBlock(): string {
  return [
    "<!-- TUT:BEGIN -->",
    "<!-- Managed block: `tut init` refreshes between the markers; keep edits outside -->",
    "",
    "## TUT (Take Ur Turn)",
    "",
    "本仓库使用 TUT（Take Ur Turn）多 Agent 协作：本地 Context Hub——append-only 记录、",
    "派生任务状态、人工审批门。收到「担任 TUT Host／全程驱动」类指令的 Agent：运行",
    "`tut skill host` 读取并遵守 Host 角色规则（工具面 MCP-first，`tut` CLI 为等价通道）。",
    "工人角色（architect / executor / reviewer）的 skill 由启动器在投递时自动供给，",
    "无需人工配置。",
    "",
    "<!-- TUT:END -->",
  ].join("\n");
}

/** `/<!-- TUT:BEGIN -->[\s\S]*?<!-- TUT:END -->/` as a source literal. */
const TUT_BLOCK_RE = /<!-- TUT:BEGIN -->[\s\S]*?<!-- TUT:END -->/;

/**
 * Atomic file replace (runAssign's pattern): the new content lands in
 * a temp SIBLING first and rename() swaps it in — an interrupted write can
 * only leave the target at its old content or the new content, never a
 * truncated mix (the old direct writeFileSync truncated AGENTS.md/.gitignore
 * when the process died mid-write). Failure removes the temp; the target is
 * never touched.
 */
async function atomicReplace(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, content, "utf8");
    await rename(temp, file);
  } catch (e) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw e;
  }
}

async function runSkill(parsed: Extract<ParsedArgs, { command: "skill" }>): Promise<number> {
  const file = path.join(SKILLS_DIR, `${parsed.role}.md`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    process.stderr.write(
      `tut: cannot read the ${parsed.role} skill (${file}) — the skills/ directory must sit next to the installed CLI (npm package content)\n`,
    );
    return 1;
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  return 0;
}

async function runInit(): Promise<number> {
  const root = process.cwd();

  // Step 1 — .context-hub/: the runtime-data root (serve's default --root,
  // and the layout marker tut up accepts for non-JS repos). mkdir recursive
  // is a no-op when it already exists — reruns stay idempotent.
  const hubDir = path.join(root, ".context-hub");
  try {
    await mkdir(hubDir, { recursive: true });
    process.stdout.write(`init: ensured ${hubDir}/\n`);
  } catch (e) {
    process.stderr.write(`tut: cannot create ${hubDir}: ${(e as Error).message}\n`);
    return 1;
  }

  // Step 2 — .gitignore: runtime data is machine-local, never committed.
  // Idempotent: any existing ignore line for it (with or without the
  // trailing slash) means no write at all.
  const gitignore = path.join(root, ".gitignore");
  const GITIGNORE_ENTRY = ".context-hub/";
  try {
    let giExisting: string | null = null;
    try {
      giExisting = readFileSync(gitignore, "utf8");
    } catch {
      giExisting = null; // absent (any other read failure resurfaces at the write below)
    }
    if (giExisting === null) {
      await atomicReplace(gitignore, `${GITIGNORE_ENTRY}\n`);
      process.stdout.write(`init: created ${gitignore} ignoring ${GITIGNORE_ENTRY}\n`);
    } else if (
      giExisting.split("\n").some((line) => {
        const trimmed = line.trim();
        return trimmed === ".context-hub" || trimmed === GITIGNORE_ENTRY;
      })
    ) {
      process.stdout.write(`init: .gitignore already ignores ${GITIGNORE_ENTRY} (idempotent — no change)\n`);
    } else {
      const base = giExisting.replace(/\s+$/, "");
      await atomicReplace(gitignore, base.length === 0 ? `${GITIGNORE_ENTRY}\n` : `${base}\n${GITIGNORE_ENTRY}\n`);
      process.stdout.write(`init: appended ${GITIGNORE_ENTRY} to ${gitignore}\n`);
    }
  } catch (e) {
    process.stderr.write(`tut: cannot write ${gitignore}: ${(e as Error).message}\n`);
    return 1;
  }

  // Step 3 — the AGENTS.md TUT block (the original init behavior).
  const target = path.join(root, "AGENTS.md");
  const block = agentsBlock();
  let existing: string | null = null;
  try {
    existing = readFileSync(target, "utf8");
  } catch {
    existing = null; // absent (any other read failure resurfaces at the write below)
  }
  try {
    if (existing === null) {
      await atomicReplace(target, `${block}\n`);
      process.stdout.write(`init: created ${target} with the TUT block\n`);
    } else if (TUT_BLOCK_RE.test(existing)) {
      await atomicReplace(target, existing.replace(TUT_BLOCK_RE, block));
      process.stdout.write(`init: refreshed the TUT block in ${target} (idempotent — no duplicate)\n`);
    } else {
      await atomicReplace(target, `${existing.replace(/\s*$/, "\n\n")}${block}\n`);
      process.stdout.write(`init: appended the TUT block to ${target}\n`);
    }
  } catch (e: unknown) {
    process.stderr.write(`tut: cannot write ${target}: ${(e as Error).message}\n`);
    return 1;
  }
  process.stdout.write("init: the activation phrase needs no instructions — paste「担任 TUT Host，全程驱动这个任务：<你的需求>」into any agent session\n");
  return 0;
}

export { runStatus, runDoctor, runRepairMeta, runRecoverRecord, runSkill, runInit };
