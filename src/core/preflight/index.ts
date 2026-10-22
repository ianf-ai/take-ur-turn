/**
 * Checkout preflight: existence/readability checks for the directory a
 * run/resume/auto launch is about to execute in — deliberately NOT the Hub
 * storage root, the routing root, or the installed TUT package root.
 *
 * Checkout preflight checks:
 *  - A checkout with a package.json that declares Node dependencies must have
 *    a readable local node_modules; missing → report (and with an explicit
 *    --fix-preflight, repair via `npm ci` under a supported lockfile).
 *  - A TUT SOURCE checkout (package.json name "take-ur-turn") must carry
 *    dist/cli.js + dist/core/run/supervisor.js; missing → report (fix: npm run
 *    build). An installed TUT copy is not a checkout — its files exist by
 *    construction and are never inspected here.
 *  - No manifest / no declared dependencies → not-applicable: arbitrary executable
 *    commands and non-JS projects are never blocked by this check.
 *  - Checks prove existence/readability only — never dependency completeness,
 *    version correctness, or artifact freshness. Permission/manifest damage
 *    is an error, not "missing".
 *
 * Default posture everywhere is report-only. Fixes run ONLY behind an
 * explicit --fix-preflight, only for the preflight items, only inside the
 * inspected checkout, each step bounded, visible, and stop-on-failure.
 */

import { spawn } from "node:child_process";
import { constants as FsConstants, accessSync, readFileSync } from "node:fs";
import path from "node:path";

export type PreflightCheckName = "node-manifest" | "node-modules" | "tut-dist";
export type PreflightStatus = "ok" | "missing" | "error" | "not-applicable";

export interface PreflightItem {
  check: PreflightCheckName;
  status: PreflightStatus;
  /** Absolute target path and the evidence behind the verdict. */
  detail: string;
  /** Suggested repair for a human (fix mode automates exactly this). */
  fix?: string;
}

export interface PreflightReport {
  /** The inspected checkout (absolute). */
  checkout: string;
  /** True when package.json declares name "take-ur-turn" and parses. */
  isTutCheckout: boolean;
  /** True when at least one applicable check exists (i.e. gating applies). */
  applicable: boolean;
  /** True when no applicable item is missing/error. */
  ok: boolean;
  items: PreflightItem[];
}

interface ManifestShape {
  name?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function declaresNodeDependencies(manifest: ManifestShape): boolean {
  for (const key of ["dependencies", "devDependencies"] as const) {
    const value = manifest[key];
    if (isRecord(value) && Object.keys(value).length > 0) return true;
  }
  return false;
}

function notApplicable(check: PreflightCheckName, detail: string): PreflightItem {
  return { check, status: "not-applicable", detail };
}

/** One bounded fix step: raw argv, fixed cwd, visible output. */
export interface PreflightFixStep {
  description: string;
  argv: string[];
  cwd: string;
}

export type PreflightFixRunner = (
  step: PreflightFixStep,
) => Promise<{ code: number | null; signal: string | null }>;

/** The default runner keeps every step VISIBLE but diagnostic-only: child
 *  stdout/stderr are piped and forwarded to the log sink (stderr by default)
 *  so the CLI's machine-readable stdout (run-id line / doctor --json) is
 *  never polluted by npm/build output. */
export const PREFLIGHT_FIX_TIMEOUT_MS = 10 * 60 * 1000;

export function defaultPreflightFixRunner(log: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): PreflightFixRunner {
  return (step) =>
    new Promise((resolve) => {
      log(`preflight fix: ${step.description} (${step.argv.join(" ")}) in ${step.cwd}`);
      const child = spawn(step.argv[0]!, step.argv.slice(1), { cwd: step.cwd, stdio: ["ignore", "pipe", "pipe"], shell: false });
      child.stdout?.on("data", (chunk: Buffer) => { log(chunk.toString("utf8").replace(/\n$/u, "")); });
      child.stderr?.on("data", (chunk: Buffer) => { log(chunk.toString("utf8").replace(/\n$/u, "")); });
      const timer = setTimeout(() => {
        log(`preflight fix: step exceeded ${PREFLIGHT_FIX_TIMEOUT_MS}ms and was killed`);
        child.kill("SIGKILL");
      }, PREFLIGHT_FIX_TIMEOUT_MS);
      child.once("error", (e) => {
        clearTimeout(timer);
        resolve({ code: null, signal: null });
        log(`preflight fix: cannot run ${step.argv[0]}: ${(e as Error).message}`);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
}

/** Inspect one checkout. Pure diagnostics; never writes. */
export function preflightCheckout(checkout: string): PreflightReport {
  const absolute = path.resolve(checkout);
  // Human repair commands are POSIX shell text. Keep the checkout as one
  // literal word, including spaces, apostrophes and shell metacharacters.
  const checkoutWord = `'${absolute.replaceAll("'", "'\\''")}'`;
  const items: PreflightItem[] = [];
  let isTutCheckout = false;
  let manifest: ManifestShape | undefined;
  let hasDeps = false;

  const manifestPath = path.join(absolute, "package.json");
  let manifestRaw: string;
  try {
    manifestRaw = readFileSync(manifestPath, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      // No Node manifest: arbitrary-command / non-JS territory — never gated.
      items.push(notApplicable("node-manifest", `no package.json in ${absolute}`));
      items.push(notApplicable("node-modules", "no Node manifest — nothing to install"));
      items.push(notApplicable("tut-dist", "no package.json — not a TUT source checkout"));
      return { checkout: absolute, isTutCheckout, applicable: false, ok: true, items };
    }
    items.push({ check: "node-manifest", status: "error", detail: `cannot read ${manifestPath}: ${(e as Error).message}`, fix: "repair the package.json permissions/path and retry" });
    items.push({ check: "node-modules", status: "error", detail: "manifest unreadable — dependency applicability unknown" });
    items.push({ check: "tut-dist", status: "error", detail: "manifest unreadable — TUT checkout detection impossible" });
    return { checkout: absolute, isTutCheckout, applicable: true, ok: false, items };
  }
  try {
    const parsed: unknown = JSON.parse(manifestRaw);
    if (!isRecord(parsed)) throw new Error("package.json is not a JSON object");
    manifest = parsed as ManifestShape;
  } catch (e) {
    items.push({ check: "node-manifest", status: "error", detail: `invalid package.json in ${absolute}: ${(e as Error).message}`, fix: "repair package.json by hand (preflight never edits manifests)" });
    items.push({ check: "node-modules", status: "error", detail: "manifest invalid — dependency applicability unknown" });
    items.push({ check: "tut-dist", status: "error", detail: "manifest invalid — TUT checkout detection impossible" });
    return { checkout: absolute, isTutCheckout, applicable: true, ok: false, items };
  }

  isTutCheckout = manifest.name === "take-ur-turn";
  hasDeps = declaresNodeDependencies(manifest);
  items.push({ check: "node-manifest", status: "ok", detail: `${manifestPath}${isTutCheckout ? " (TUT source checkout)" : ""}` });

  if (!hasDeps) {
    items.push(notApplicable("node-modules", "package.json declares no Node dependencies"));
  } else {
    const modulesPath = path.join(absolute, "node_modules");
    try {
      accessSync(modulesPath, FsConstants.R_OK);
      items.push({ check: "node-modules", status: "ok", detail: `${modulesPath} present and readable` });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const hasLock = existsQuietly(path.join(absolute, "package-lock.json"));
        items.push({
          check: "node-modules",
          status: "missing",
          detail: `${modulesPath} is missing (checkout declares Node dependencies)`,
          fix: hasLock
            ? `cd ${checkoutWord} && npm ci`
            : `install dependencies manually in ${absolute} (no supported lockfile — preflight will not invent a package manager)`,
        });
      } else {
        items.push({ check: "node-modules", status: "error", detail: `cannot access ${modulesPath}: ${(e as Error).message}`, fix: "repair node_modules permissions and retry" });
      }
    }
  }

  if (!isTutCheckout) {
    items.push(notApplicable("tut-dist", "not a TUT source checkout (package.json name differs)"));
  } else {
    const missing: string[] = [];
    const unreadable: string[] = [];
    for (const artifact of ["dist/cli.js", "dist/core/run/supervisor.js"]) {
      const file = path.join(absolute, artifact);
      try {
        accessSync(file, FsConstants.R_OK);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") missing.push(file);
        else unreadable.push(`${file} (${(e as Error).message})`);
      }
    }
    if (missing.length > 0) {
      items.push({
        check: "tut-dist",
        status: "missing",
        detail: `TUT build artifacts missing: ${missing.join(", ")}`,
        fix: `cd ${checkoutWord} && npm run build`,
      });
    } else if (unreadable.length > 0) {
      items.push({ check: "tut-dist", status: "error", detail: `cannot read build artifacts: ${unreadable.join(", ")}`, fix: "repair dist permissions and retry" });
    } else {
      items.push({ check: "tut-dist", status: "ok", detail: `dist artifacts present in ${absolute}` });
    }
  }

  const applicable = items.some((item) => item.status !== "not-applicable");
  const ok = !items.some((item) => item.status === "missing" || item.status === "error");
  return { checkout: absolute, isTutCheckout, applicable, ok, items };
}

function existsQuietly(file: string): boolean {
  try {
    accessSync(file, FsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** The next automated fix step for the current report, or null when done /
 *  manual-only. Order: dependencies first, build after (build needs deps). */
export function nextPreflightFixStep(report: PreflightReport): PreflightFixStep | null {
  const modules = report.items.find((item) => item.check === "node-modules");
  const dist = report.items.find((item) => item.check === "tut-dist");
  if (modules?.status === "missing" && existsQuietly(path.join(report.checkout, "package-lock.json"))) {
    return { description: "install dependencies with npm ci (supported lockfile present)", argv: ["npm", "ci"], cwd: report.checkout };
  }
  // Without a supported lockfile the install stays manual — never guess a
  // package manager or mutate manifests/lockfiles.
  if (dist?.status === "missing" && (!modules || modules.status === "ok" || modules.status === "not-applicable")) {
    return { description: "build TUT dist artifacts with npm run build", argv: ["npm", "run", "build"], cwd: report.checkout };
  }
  return null;
}

export interface PreflightFixResult {
  report: PreflightReport;
  /** Steps actually executed (in order). */
  executed: PreflightFixStep[];
  /** First failing step, when one failed. */
  failure?: { step: PreflightFixStep; code: number | null; signal: string | null };
}

/** Repair loop: run the next step, re-check, repeat. Stop on failure or when
 *  no supported step remains; healthy items are never re-installed/rebuilt. */
export async function fixPreflight(
  checkout: string,
  run: PreflightFixRunner,
  maxSteps = 4,
): Promise<PreflightFixResult> {
  const executed: PreflightFixStep[] = [];
  let report = preflightCheckout(checkout);
  for (;;) {
    const step = nextPreflightFixStep(report);
    if (step === null || executed.length >= maxSteps) break;
    executed.push(step);
    const outcome = await run(step);
    if (outcome.code !== 0) {
      report = preflightCheckout(checkout);
      return { report, executed, failure: { step, code: outcome.code, signal: outcome.signal } };
    }
    report = preflightCheckout(checkout);
  }
  return { report, executed };
}

/** Human-readable one-liner block for CLI rejection paths. */
export function renderPreflightReport(report: PreflightReport, options: { manualOnly?: boolean } = {}): string {
  const lines = [`checkout preflight failed for ${report.checkout}:`];
  for (const item of report.items) {
    if (item.status === "ok" || item.status === "not-applicable") continue;
    lines.push(`  [${item.check}] ${item.status}: ${item.detail}`);
    if (item.fix !== undefined) lines.push(`    fix: ${item.fix}`);
  }
  lines.push(options.manualOnly
    ? "  follow the fix steps above by hand in the checkout, then retry the launch"
    : "  repair with an explicit --fix-preflight (supported steps only) or by hand, then retry");
  return lines.join("\n");
}

/** npm resolves through PATH; steps above use the bare "npm" command. */
export function npmCommandHead(env: NodeJS.ProcessEnv = process.env): string {
  return env.TUT_PREFLIGHT_NPM ?? "npm";
}

/** The default runner with the env-resolved npm head. */
export function envPreflightFixRunner(env: NodeJS.ProcessEnv = process.env, log?: (line: string) => void): PreflightFixRunner {
  const fallback = defaultPreflightFixRunner(log);
  const npm = npmCommandHead(env);
  return (step) => fallback({ ...step, argv: step.argv.map((token, index) => (index === 0 && token === "npm" ? npm : token)) });
}
