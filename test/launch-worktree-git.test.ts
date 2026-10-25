import type { WindowsOwnership } from '../src/standalone/launcher-headless/windows-plan.js';
import { writeNodeExecutable, writePiPackageFixture } from './helpers/executable.js';
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { worktreeGitEnvironment } from "../src/core/launcher/worktree-git.js";
import { buildHeadlessPlan } from "../src/standalone/launcher-headless/plan.js";
import { renderInvocationPaneCommand } from "../src/herdr/launcher/compat.js";
import { buildLaunchInvocation } from "../src/core/launcher/invocation.js";
import { startServer } from "../src/core/hub/server.js";
import { hubCreate, hubRead } from "../src/core/hub/hub-client.js";
import { RunStore } from "../src/core/run/store.js";
import { planResume } from "../src/core/run/resume.js";

const run = promisify(execFile);
const cli = path.resolve("dist/cli.js");

function fixture() {
  // All repositories, remote refs and Hub audit records remain outside the
  // source checkout; nothing contacts the project's real remotes.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "tut-worktree-git-")));
  const main = path.join(root, "main"), worker = path.join(root, "worker"), ordinary = path.join(root, "ordinary");
  const remote = path.join(root, "remote.git");
  const globalConfig = path.join(root, "empty-git-config"); writeFileSync(globalConfig, "");
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|ALLOW_PROTOCOL|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/u.test(key)) delete env[key];
  }
  const git = (cwd: string, args: string[], childEnv = env) => spawnSync("git", args, { cwd, env: childEnv, encoding: "utf8" });
  const ok = (cwd: string, ...args: string[]) => {
    const result = git(cwd, args);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  ok(root, "init", "--bare", remote);
  ok(root, "init", "-b", "main", main);
  ok(main, "config", "user.name", "TUT test");
  ok(main, "config", "user.email", "test@example.invalid");
  ok(main, "config", "commit.gpgsign", "false");
  ok(main, "config", "push.default", "current");
  writeFileSync(path.join(main, "seed"), "seed\n");
  ok(main, "add", "seed"); ok(main, "commit", "-m", "fixture seed");
  ok(main, "remote", "add", "origin", remote);
  ok(main, "worktree", "add", "-b", "worker", worker);
  ok(main, "worktree", "add", "-b", "ordinary", ordinary);
  return { root, main, worker, ordinary, remote, env, git, ok };
}

const shellPath = (file: string) => file.replaceAll("\\", "/");

function invocation(f: ReturnType<typeof fixture>, executable: string, args: string[], checkoutRoot = f.worker) {
  return buildLaunchInvocation({
    request: { kind: "round", task_id: "t", role: "executor", fresh: false, via: "start-next" },
    base_version: 0, hub_url: "http://127.0.0.1:1", route: { agent: shellPath(executable), args: args.map(shellPath) }, route_source: "task-cast", prompt: "fixture",
    context: {
      hubRoot: shellPath(f.main), checkoutRoot: shellPath(checkoutRoot), routingRoot: shellPath(f.main),
      checkout: checkoutRoot === f.main ? { kind: "current" } : { kind: "worktree", path: checkoutRoot },
      context: { kind: "shared" }, source: "anchor",
      anchor: { workspace_id: "w", pane_id: "p", cwd: f.main },
    },
    posix_direct: { executable: shellPath(executable), args: args.map(shellPath), env: { GIT_ALLOW_PROTOCOL: "file" } },
  });
}

describe("launch worktree Git transport isolation", () => {
  it("leaves current, symlink aliases and unanchored previews alone", () => {
    const f = fixture();
    const alias = path.join(f.root, "alias"); symlinkSync(f.main, alias, process.platform === "win32" ? "junction" : "dir");
    for (const checkoutRoot of [f.main, alias]) expect(worktreeGitEnvironment({ hubRoot: f.main, checkoutRoot })).toEqual({});
    expect(worktreeGitEnvironment({ hubRoot: "<hub-root>", checkoutRoot: "<checkout-root>" })).toEqual({});
  });

  it("blocks default, named, explicit, multi-pushurl and newly added remotes before credentials", () => {
    const f = fixture();
    const policyEnv = { ...f.env, ...worktreeGitEnvironment({ hubRoot: f.main, checkoutRoot: f.worker }) };
    f.ok(f.main, "config", "--add", "remote.origin.pushurl", f.remote);
    f.ok(f.main, "config", "--add", "remote.origin.pushurl", "https://example.invalid/fixture.git");
    f.ok(f.main, "remote", "add", "later", f.remote);
    const sentinel = path.join(f.root, "credential-used");
    const helper = path.join(f.root, "helper");
    writeFileSync(helper, `#!/bin/sh\ntouch '${sentinel}'\nexit 1\n`); chmodSync(helper, 0o700);
    f.ok(f.main, "config", "credential.helper", helper);
    const protectedEnv = { ...policyEnv, GIT_SSH_COMMAND: helper };
    for (const args of [
      ["push"], ["push", "origin", "HEAD"], ["push", f.remote, "HEAD"], ["push", "later", "HEAD"],
      ["-c", "protocol.file.allow=always", "push", f.remote, "HEAD"],
      ["push", "https://example.invalid/fixture.git", "HEAD"], ["push", "ssh://example.invalid/fixture.git", "HEAD"],
      ["push", "ext::fixture", "HEAD"],
    ]) {
      const result = f.git(f.worker, args, protectedEnv);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/transport '.+' not allowed/u);
    }
    expect(existsSync(sentinel)).toBe(false);
    expect(f.git(f.root, ["--git-dir", f.remote, "show-ref", "--verify", "refs/heads/worker"]).status).not.toBe(0);
    const configBefore = readFileSync(path.join(f.main, ".git/config"), "utf8");
    writeFileSync(path.join(f.worker, "local"), "local change\n");
    expect(f.git(f.worker, ["add", "local"], policyEnv).status).toBe(0);
    expect(f.git(f.worker, ["commit", "-m", "local worker change"], policyEnv).status).toBe(0);
    expect(readFileSync(path.join(f.main, ".git/config"), "utf8")).toBe(configBefore);
    // Scope is the launched process: the main checkout and an ordinary
    // human worktree still really push to the disposable local remote.
    f.ok(f.main, "push", f.remote, "HEAD");
    f.ok(f.ordinary, "push", f.remote, "HEAD");
    expect(f.env.GIT_ALLOW_PROTOCOL).toBeUndefined();
  });

  it("executes the Herdr-rendered POSIX command with the same guard and permits commits", async () => {
    const f = fixture();
    const program = `
      const {spawnSync}=require('node:child_process');
      const fs=require('node:fs');
      const git=(...args)=>{const r=spawnSync('git',args,{encoding:'utf8'});return {status:r.status,stderr:r.stderr};};
      fs.writeFileSync('herdr-local','local');
      console.log(JSON.stringify({allow:process.env.GIT_ALLOW_PROTOCOL,add:git('add','herdr-local'),commit:git('commit','-m','herdr worker'),push:git('push')}));
    `;
    const script = path.join(f.root, "herdr-worker.cjs"); writeFileSync(script, program);
    const rendered = renderInvocationPaneCommand(invocation(f, process.execPath, [script]), "posix");
    const result = await run(process.platform === "win32" ? "sh.exe" : "/bin/sh", ["-c", rendered.command_text], { env: f.env });
    const observed = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    expect(observed).toMatchObject({ allow: "", add: { status: 0 }, commit: { status: 0 } });
    expect(observed.push.status).not.toBe(0); expect(observed.push.stderr).toContain("transport 'file' not allowed");
    const current = renderInvocationPaneCommand(invocation(f, "git", ["push"], f.main), "posix");
    // The route's original env survives for current checkout workers.
    expect(current.command_text).toContain("'GIT_ALLOW_PROTOCOL=file'");
  });

  it("runs real start-next → Hub marker → detached headless worker and restores the guard on resume", { timeout: process.platform === "win32" ? 90000 : 20000 }, async () => {
    const f = fixture();
    const bin = path.join(f.root, "bin"); mkdirSync(bin);
    const evidence = path.join(f.root, "evidence.json");
    const program = `
      const {spawnSync}=require('node:child_process'),fs=require('node:fs');
      const git=(...args)=>{const r=spawnSync('git',args,{encoding:'utf8'});return {status:r.status,stderr:r.stderr};};
      fs.writeFileSync('headless-local','local');
      const result={allow:process.env.GIT_ALLOW_PROTOCOL,cwd:process.cwd(),add:git('add','headless-local'),commit:git('commit','-m','headless worker'),push:git('push')};
      fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify(result));
      console.log(JSON.stringify({type:'thread.started',thread_id:'12345678-1234-1234-1234-123456789abc'}));
      console.log(JSON.stringify(result));
    `;
    // Windows uses the supported, verified Pi session producer. The worker
    // still runs the same Git guard assertions and never invokes a model.
    const piHeader = `const args=process.argv.slice(2),fs0=require('node:fs'),path0=require('node:path');
      const id=args[args.indexOf('--session-id')+1],dir=args[args.indexOf('--session-dir')+1];
      if(!id||!dir)throw Error('missing frozen Pi session');
      fs0.mkdirSync(dir,{recursive:true});fs0.writeFileSync(path0.join(dir,id+'.jsonl'),JSON.stringify({type:'session',id,cwd:process.cwd()})+'\\n');`;
    const codex = process.platform === "win32" ? writePiPackageFixture(bin, piHeader + program) : writeNodeExecutable(path.join(bin, "codex"), program);
    mkdirSync(path.join(f.main, ".context-hub"));
    writeFileSync(path.join(f.main, ".context-hub/config.json"), JSON.stringify({ flow_mode: "manual", launch_mode: "headless" }));
    const server = await startServer({ root: path.join(f.main, ".context-hub"), port: 0 });
    try {
      const task = await hubCreate(server.url, { title: "worktree transport guard", description: "local launch integration", creator: "test", role: "human", flow: "direct", cast: { executor: codex }, checkout: { kind: "worktree", path: f.worker } });
      const parentEnv = { ...f.env, TUT_HUB_ROOT: f.main, TUT_PROJECT_ROOT: f.main, TUT_USER_CONFIG_DIR: path.join(f.root, "no-user-config"), PI_CODING_AGENT_DIR: path.join(f.root, "pi-home"), PI_CODING_AGENT_SESSION_DIR: path.join(f.root, "sessions"), GIT_ALLOW_PROTOCOL: "file" };
      const output = await run(process.execPath, [cli, "start-next", task.task_id, "--url", server.url], { env: parentEnv });
      expect(output.stdout).toContain("detached launch attempt completed");
      const store = new RunStore(f.main);
      const id = store.list()[0]!;
      try {
        await expect.poll(() => { try { return store.read(id).ended_at; } catch { return undefined; } }, { timeout: process.platform === "win32" ? 45000 : 10000 }).toBeTruthy();
      } catch (cause) {
        let snapshot: unknown;
        try { snapshot = store.read(id); } catch (error) { snapshot = { read_error: String(error) }; }
        throw new Error(`worktree Git worker ${id} did not complete: ${JSON.stringify(snapshot)}`, { cause });
      }
      const completed = store.read(id); expect(completed.exit_code).toBe(0);
      if (process.platform === "win32") expect((completed.headless as WindowsOwnership).windows?.pi_session?.session_directory).toBe(path.join(f.root, "sessions"));
      const observed = JSON.parse(readFileSync(evidence, "utf8"));
      expect(observed).toMatchObject({ allow: "", cwd: realpathSync(f.worker), add: { status: 0 }, commit: { status: 0 } });
      expect(observed.push.status).not.toBe(0); expect(observed.push.stderr).toContain("transport 'file' not allowed");
      const fd = store.openLog(id);
      try { expect(readFileSync(fd, "utf8")).toContain("transport 'file' not allowed"); } finally { closeSync(fd); }
      expect((await hubRead(server.url, task.task_id)).versions[0]?.payload.launch).toMatchObject({ launch_mode: "headless" });
      const resume = await planResume(store, id, { env: parentEnv, hubUrl: server.url });
      expect(resume.managed).toBe(true); expect(resume.env.GIT_ALLOW_PROTOCOL).toBe("");
      expect(parentEnv.GIT_ALLOW_PROTOCOL).toBe("file");
      // Both rig-mode current checkout and anchored fallback use the main
      // root, so neither acquires a worktree-only restriction.
      for (const launchCheckout of ["rig", "anchored"] as const) {
        const plan = await buildHeadlessPlan({ task: { task_id: "current", title: "current", version: 0, cast: { executor: codex }, description: "no workspace declaration" }, role: "executor", records: [], hubRoot: f.main, hubUrl: server.url, eventUrl: "http://127.0.0.1:1/agent-event", env: parentEnv, launchCheckout });
        expect(plan.env.GIT_ALLOW_PROTOCOL).toBe("file");
      }
      const anchored = await buildHeadlessPlan({ task: { task_id: "anchored", title: "anchored", version: 0, cast: { executor: codex } }, description: `工作区：${process.platform === "win32" ? shellPath(f.worker).replace(/^[A-Za-z]:/, "") : f.worker}（分支 worker）`, role: "executor", records: [], hubRoot: f.main, hubUrl: server.url, eventUrl: "http://127.0.0.1:1/agent-event", env: parentEnv, launchCheckout: "anchored" });
      expect(anchored.env.GIT_ALLOW_PROTOCOL).toBe("");
    } finally { await server.close(); }
    // Keep the append-only Hub/run evidence in the temp directory.
  });
});
