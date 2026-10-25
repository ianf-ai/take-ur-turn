/** Windows PATH × PATHEXT discovery and ordered target classification. */
import type { Stats } from "node:fs";
import { stat as fsStatPromises } from "node:fs/promises";
import path from "node:path";
import { AgentTargetError, UnsupportedWindowsShimError } from "./types.js";
import type { ResolvedAgentTarget, WindowsTargetDeps } from "./types.js";
import { probeExecutable, probeTimeoutMs, probeWalkTimeoutMs, readHeaderDefault, withFsProbeBudget } from "./probe.js";
import { readHeaderFromFacts, spawnFactProbeDefault, statFromFacts, StreamingWindowsFactTable } from "./windows-facts.js";

const WINDOWS_SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1", ".sh"]);

const NODE_ENTRY_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

const NATIVE_EXTENSIONS = new Set([".exe", ".com"]);

const WINDOWS_NATIVE_HINT =
  "install the native executable, or point the workspace/task cast at a direct Node entry route (node + script) with node.exe on PATH; use tut assign for the workspace lineup (task cast takes precedence; correct cast in a new task, no default fallback)";

function whereLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("\u0000"));
}

/** The PATHEXT extension order; the Windows default mirrors where.exe. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

function pathextExtensions(environment: NodeJS.ProcessEnv): string[] {
  const raw = environment.PATHEXT ?? DEFAULT_PATHEXT;
  return raw.split(";").map((value) => value.trim()).filter((value) => value.length > 0);
}

/** Strip padding/quote wrappers Windows PATH entries sometimes carry. */
function cleanPathEntry(raw: string): string {
  return raw.trim().replace(/^"+|"+$/gu, "");
}

/**
 * Generate the Windows candidate list from PATH × PATHEXT inside Node
 * (UTF-16 strings — no console codepage decode).  Per directory: PATHEXT
 * order first, then the extensionless name; directories in PATH order.
 * Pure path generation — existence is decided by the resolver's stat seam,
 * so tests inject without touching the filesystem.
 */
export function enumeratePathCandidates(agent: string, environment: NodeJS.ProcessEnv): string[] {
  const pathValue = environment.PATH ?? "";
  const extensions = pathextExtensions(environment);
  const candidates: string[] = [];
  for (const rawDir of pathValue.split(";")) {
    const dir = cleanPathEntry(rawDir);
    if (dir.length === 0) continue;
    // Lowercase the appended extension: PATHEXT spellings vary (.CMD/.Cmd),
    // and a deterministic case keeps cross-platform fixtures and shim
    // messages stable (Windows itself resolves extensions case-insensitively).
    for (const ext of extensions) candidates.push(path.win32.join(dir, `${agent}${ext.toLowerCase()}`));
    candidates.push(path.win32.join(dir, agent));
  }
  return candidates;
}

/**
 * The default candidate provider: PATH+PATHEXT self-enumeration, with
 * where.exe kept only as the fallback for a PATH-less environment (its
 * CreateProcess resolution still finds System32\where.exe with an empty
 * PATH, covering the one case self-enumeration cannot).
 */
async function defaultWindowsCandidates(agent: string, environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<string[]> {
  const enumerated = enumeratePathCandidates(agent, environment);
  if (enumerated.length > 0) return enumerated;
  const probe = await probeExecutable("where.exe", [agent], { timeoutMs });
  if (probe.error !== undefined) {
    throw new AgentTargetError(
      agent,
      `cannot be resolved (where.exe fallback failed: ${probe.error.message})`,
      WINDOWS_NATIVE_HINT,
    );
  }
  const lines = whereLines(probe.stdout);
  if (probe.code !== 0 || lines.length === 0) {
    throw new AgentTargetError(
      agent,
      `not found via the where.exe fallback (exit ${probe.code ?? "?"})`,
      WINDOWS_NATIVE_HINT,
    );
  }
  return lines;
}

function isENOENT(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isRegularFile(entry: Stats): boolean {
  return entry.isFile();
}

/**
 * Resolve one route agent against the candidate list, in list order.
 *
 * Existence comes first: the self-enumerated list carries every generated
 * path, so classification (shim/native/node-entry) applies only to a
 * candidate that actually exists — a missing agent stays "not found"
 * instead of tripping a shim refusal on a path that is not there.  A
 * native executable or direct Node entry is a trustworthy result and
 * stops the walk; unsupported shims are a fail-closed refusal when
 * reached — never executed, never silently translated.
 */
export async function resolveWindowsExecutableTarget(
  routeAgent: string,
  deps: WindowsTargetDeps = {},
): Promise<ResolvedAgentTarget> {
  const environment = deps.environment ?? process.env;
  const fsProbeBudgetMs = probeTimeoutMs(environment);
  const walkBudgetMs = probeWalkTimeoutMs(environment);
  const deadline = performance.now() + walkBudgetMs;
  const rejected: string[] = [];
  const remaining = (): number => {
    const ms = deadline - performance.now();
    if (ms <= 0) throw new AgentTargetError(routeAgent,
      `PATH walk timed out after ${walkBudgetMs}ms${rejected.length > 0 ? `; ${rejected.join("; ")}` : ""}`, WINDOWS_NATIVE_HINT);
    return Math.min(fsProbeBudgetMs, ms);
  };
  const nodeExecutable = deps.nodeExecutable ?? process.execPath;
  const listCandidates = deps.candidates ?? ((agent: string) => defaultWindowsCandidates(agent, environment, remaining()));

  let candidates: string[];
  try {
    candidates = await withFsProbeBudget(() => listCandidates(routeAgent), remaining());
  } catch (error) {
    throw new AgentTargetError(routeAgent, `candidate discovery failed: ${(error as Error).message}`, WINDOWS_NATIVE_HINT);
  }
  remaining();

  // Production default (neither stat nor readHeader injected): serve every
  // candidate's facts from a streaming session backed by killable children
  // — a hung statSync/openSync inside one (dead-UNC SMB connect) cannot
  // cancel itself, but the parent SIGKILLs the stalled child, keeps the
  // rows it already streamed, marks the stalled candidate's directory as a
  // bounded unavailability, and resumes past it, so the main process's
  // threadpool is never held hostage and usable candidates sharing the
  // batch are never sunk .  Injected seams (tests)
  // instead run per-candidate adapters under the signal+race budget of
  // withFsProbeBudget.
  const factTable = deps.stat === undefined && deps.readHeader === undefined && candidates.length > 0
    ? new StreamingWindowsFactTable(candidates, fsProbeBudgetMs, deps.factProbe ?? spawnFactProbeDefault, deadline)
    : undefined;
  const stat = deps.stat ?? (factTable !== undefined
    ? statFromFacts(factTable)
    : (candidate: string) => fsStatPromises(candidate));
  const readHeader = deps.readHeader ?? (factTable !== undefined ? readHeaderFromFacts(factTable) : readHeaderDefault);

  let sawEvidence = false; // some candidate existed (or errored beyond ENOENT)
  try {
    for (const raw of candidates) {
      remaining();
      let candidate: string;
      try {
        candidate = path.win32.resolve(raw);
      } catch {
        rejected.push(`'${raw}': has an unsafely normalizable target`);
        continue;
      }

      let entry: Stats;
      try {
        // Bounded: a dead-UNC candidate stat cannot stall the walk.
        entry = await withFsProbeBudget((signal) => stat(candidate, signal), remaining());
      } catch (error) {
        if (isENOENT(error)) {
          // The candidate never existed — not an untrusted result, and not a
          // reason to mention it in the final error.
          continue;
        }
        sawEvidence = true;
        rejected.push(
          `resolves to an unavailable target ('${candidate}': ${error instanceof Error ? error.message : String(error)})`,
        );
        continue;
      }
      remaining();
      sawEvidence = true;
      if (!isRegularFile(entry)) {
        rejected.push(`resolves to a non-file target ('${candidate}')`);
        continue;
      }

      const extension = path.win32.extname(candidate).toLowerCase();
      if (WINDOWS_SHIM_EXTENSIONS.has(extension)) {
        throw new UnsupportedWindowsShimError(
          routeAgent,
          candidate,
          `TUT does not execute ${extension} shims; ${WINDOWS_NATIVE_HINT}`,
        );
      }
      if (NATIVE_EXTENSIONS.has(extension)) {
        return { kind: "native", executable: candidate, prefix_args: [], source_path: candidate };
      }

      if (NODE_ENTRY_EXTENSIONS.has(extension)) {
        // A direct Node entry: Node runs the script itself; no file association,
        // no shebang reliance, no shell.
        return {
          kind: "node-entry",
          executable: nodeExecutable,
          prefix_args: [candidate],
          source_path: candidate,
        };
      }

      if (extension.length === 0) {
        // Extensionless targets are accepted only with a PE (MZ) header.  A
        // non-PE extensionless result is the common POSIX-shim shape on
        // Windows: skip it and let the next where.exe candidate decide.  The
        // default header adapter reads the real leading bytes; a read failure
        // is likewise an untrusted candidate rather than a reason to abandon
        // later candidates.
        let header: Buffer;
        try {
          header = await withFsProbeBudget((signal) => readHeader(candidate, 2, signal), remaining());
        } catch (error) {
          rejected.push(
            `header read failed for '${candidate}' (${error instanceof Error ? error.message : String(error)})`,
          );
          continue;
        }
        remaining();
        if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) {
          return { kind: "native", executable: candidate, prefix_args: [], source_path: candidate };
        }
        rejected.push(`resolves to an extensionless non-executable target ('${candidate}': no PE header)`);
        continue;
      }

      // Any other extension (.py, .pl, …) reaches Windows only through shell
      // file associations — same refusal class as npm command shims.
      throw new UnsupportedWindowsShimError(
        routeAgent,
        candidate,
        `files of type '${extension}' need a shell/file association to run; ${WINDOWS_NATIVE_HINT}`,
      );
    }

    remaining();
    if (!sawEvidence) {
      throw new AgentTargetError(
        routeAgent,
        `not found on PATH (no existing PATH+PATHEXT candidate for '${routeAgent}')`,
        WINDOWS_NATIVE_HINT,
      );
    }
    throw new AgentTargetError(
      routeAgent,
      `all candidates are untrusted: ${rejected.join("; ")}`,
      WINDOWS_NATIVE_HINT,
    );
  } finally {
    // The walk's verdict is definitive (native/node-entry/shim, or a
    // terminal failure): a still-scanning fact child stops here —
    // candidates past the verdict, dead UNC or not, are never probed
    // (review v8: stop on definitive results).
    factTable?.dispose();
  }
}
