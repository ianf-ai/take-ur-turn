// Shell dialect renderer — golden vectors and boundary contracts
// (launcher port design §4; work unit 6).  The vectors below are FROZEN
// bytes: they pin the four-dialect deterministic algorithms, the pane-runner
// payload encoding, the dialect source order, and the raw-argv Herdr
// control-plane boundary that only pane run crosses with one command string.
import { describe, expect, it } from "vitest";
import {
  CmdRuntimePathError,
  PaneCommandError,
  PaneShellError,
  cmdUnsafe,
  cmdq,
  defaultPaneRuntime,
  encodePaneRunnerPayload,
  psq,
  renderPaneCommand,
  resolvePaneShellDialect,
  sq,
  type PaneCommand,
  type PaneRuntimeOptions,
} from "../src/launcher/shell-renderer.js";
import { posixDirectPlanFor } from "../src/launcher/target-resolver.js";
import { HerdrClient, type HerdrClientOptions } from "../src/launcher/herdr-client.js";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

const RUNTIME: PaneRuntimeOptions = {
  nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
  paneRunnerEntry: "C:\\tut\\dist\\launcher\\pane-runner.js",
};

const agent = (overrides: Partial<PaneCommand>): PaneCommand => ({
  cwd: "/repo",
  executable: "pi",
  args: [],
  env: {},
  dialect: "posix",
  purpose: "agent",
  ...overrides,
});

/** Decode a payload token out of a rendered command_text. */
function payloadTokenOf(commandText: string): string {
  const match = /--payload ['"]([A-Za-z0-9_-]+)['"]/u.exec(commandText);
  if (match === null) throw new Error("no payload token in command text");
  return match[1] as string;
}

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Record<string, unknown>;
}

// --- quote primitives ---------------------------------------------------------------

describe("sq / psq / cmdq primitives", () => {
  it("sq wraps in single quotes and replaces each ' with the 4-char '\\'' sequence", () => {
    expect(sq("plain")).toBe("'plain'");
    expect(sq("O'Brien")).toBe("'O'\\''Brien'");
    expect(sq("a'b'c")).toBe("'a'\\''b'\\''c'");
    expect(sq("")).toBe("''");
    expect(sq("sp ace & ; β")).toBe("'sp ace & ; β'");
  });

  it("sq rejects NUL/CR/LF", () => {
    expect(() => sq("a\u0000b")).toThrow();
    expect(() => sq("a\r\nb")).toThrow();
  });

  it("psq doubles embedded apostrophes (PowerShell 5.1 and 7 share it)", () => {
    expect(psq("C:\\work dir\\O'Brien")).toBe("'C:\\work dir\\O''Brien'");
    expect(psq("β %")).toBe("'β %'");
  });

  it("cmdUnsafe flags exactly the cmd expansion set", () => {
    for (const bad of ["%", "!", "^", "&", "|", "<", ">", "(", ")", ";", '"', "a\rb", "a\nb", "a\u0000b"]) {
      expect(cmdUnsafe(bad), `unsafe: ${JSON.stringify(bad)}`).toBe(true);
    }
    for (const good of ["plain", "a b", "C:\\Program Files\\nodejs\\node.exe", "β", "'quoted'", "a,b=c"]) {
      expect(cmdUnsafe(good), `safe: ${JSON.stringify(good)}`).toBe(false);
    }
  });

  it("cmdq always double-quotes safe values and doubles trailing backslashes", () => {
    expect(cmdq("C:\\Program Files\\nodejs\\node.exe")).toBe('"C:\\Program Files\\nodejs\\node.exe"');
    expect(cmdq("")).toBe('""');
    expect(cmdq("a\\b\\")).toBe('"a\\b\\\\"'); // interior \ untouched, trailing run doubled
    expect(cmdq("\\".repeat(3))).toBe('"' + "\\".repeat(6) + '"'); // backslash-only value: 3 → 6
    expect(cmdq("--flag")).toBe('"--flag"');
  });

  it("cmdq refuses every unsafe value (no caret escaping, no second parse)", () => {
    for (const bad of ["100%", "a!b", "x^y", "a&b", "a|b", "<x>", "(x)", "a;b", 'say "hi"', "a\rb"]) {
      expect(() => cmdq(bad), `refuse: ${JSON.stringify(bad)}`).toThrow(PaneCommandError);
    }
  });
});

// --- dialect source ------------------------------------------------------------------

describe("shell dialect source: TUT_PANE_SHELL → platform default", () => {
  it("accepts the four vocabulary values from TUT_PANE_SHELL", () => {
    for (const value of ["posix", "powershell5", "pwsh", "cmd"] as const) {
      expect(resolvePaneShellDialect({ TUT_PANE_SHELL: value })).toBe(value);
    }
  });

  it("platform default: powershell5 on Windows, posix elsewhere", () => {
    expect(resolvePaneShellDialect({}, "win32")).toBe("powershell5");
    expect(resolvePaneShellDialect({}, "darwin")).toBe("posix");
    expect(resolvePaneShellDialect({}, "linux")).toBe("posix");
  });

  it("empty TUT_PANE_SHELL falls back to the platform default", () => {
    expect(resolvePaneShellDialect({ TUT_PANE_SHELL: "" }, "win32")).toBe("powershell5");
  });

  it("unknown values fail loudly before birth — never a silent guess", () => {
    expect(() => resolvePaneShellDialect({ TUT_PANE_SHELL: "zsh" })).toThrowError(PaneShellError);
    expect(() => resolvePaneShellDialect({ TUT_PANE_SHELL: "PowerShell7" })).toThrowError(/posix, powershell5, pwsh, cmd/);
  });
});

// --- golden vector: quote-punctuation -------------------------------------------------

describe("golden vector: quote-punctuation", () => {
  const input = {
    cwd: "/tmp/O'Brien & semicolon;",
    executable: "codex",
    args: ["--model", "gpt 5", "β"],
    env: {},
  } as const;

  it("posix: cd -- plus sq with the 4-char apostrophe sequence", () => {
    const rendered = renderPaneCommand(agent({ ...input }));
    expect(rendered).toEqual({
      dialect: "posix",
      command_text: "cd -- '/tmp/O'\\''Brien & semicolon;' && 'codex' '--model' 'gpt 5' 'β'",
      transport: "herdr-pane-run-single-string",
    });
  });

  it("powershell5/pwsh: doubled apostrophe inside the conservative script block", () => {
    const expected =
      "& { $savedPath = (Get-Location).Path; $exitCode = 1; " +
      "try { Set-Location -LiteralPath '/tmp/O''Brien & semicolon;'; & 'codex' '--model' 'gpt 5' 'β'; $exitCode = $LASTEXITCODE } " +
      "finally { Set-Location -LiteralPath $savedPath }; $global:LASTEXITCODE = $exitCode }";
    expect(renderPaneCommand(agent({ ...input, dialect: "powershell5" })).command_text).toBe(expected);
    expect(renderPaneCommand(agent({ ...input, dialect: "pwsh" })).command_text).toBe(expected);
  });

  it("cmd: the punctuation cwd forces the encoded runner", () => {
    const rendered = renderPaneCommand(agent({ ...input, dialect: "cmd" }), RUNTIME);
    const { command_text } = rendered;
    expect(command_text).toBe(`"C:\\Program Files\\nodejs\\node.exe" "C:\\tut\\dist\\launcher\\pane-runner.js" --payload "${payloadTokenOf(command_text)}"`);
    expect(command_text).not.toMatch(/[%^&;()!]/u);
  });

  it("all four dialects decode to the same semantic command", () => {
    // Only the cmd form encodes here (the punctuation cwd forces it); POSIX
    // and PowerShell carry the same raw values visibly.  Both roads must
    // agree on cwd/executable/args byte-for-byte.
    const cmd = renderPaneCommand(agent({ ...input, dialect: "cmd" }), RUNTIME);
    expect(decodePayload(payloadTokenOf(cmd.command_text))).toEqual({
      protocol_version: 1,
      cwd: "/tmp/O'Brien & semicolon;",
      executable: "codex",
      args: ["--model", "gpt 5", "β"],
      env: {},
      purpose: "agent",
    });
    const posix = renderPaneCommand(agent({ ...input })).command_text;
    const ps = renderPaneCommand(agent({ ...input, dialect: "powershell5" })).command_text;
    for (const text of [posix, ps]) {
      expect(text).toContain("gpt 5"); // one token, never re-split
      expect(text).toContain("β");
    }
    expect(posix).toContain("'/tmp/O'\\''Brien & semicolon;'");
    expect(ps).toContain("'/tmp/O''Brien & semicolon;'");
  });
});

// --- golden vector: powershell5-pi-env ------------------------------------------------

describe("golden vector: powershell5-pi-env (child-isolated env)", () => {
  const input = {
    cwd: "C:\\work dir\\O'Brien",
    executable: "pi",
    args: ["--model", "大模型"],
    env: { PI_SKIP_VERSION_CHECK: "1" },
  } as const;

  it("PS5 and pwsh share one encoded-runner form: no &&, no POSIX env, no $env: write", () => {
    const ps5 = renderPaneCommand(agent({ ...input, dialect: "powershell5" }), RUNTIME);
    const pwsh = renderPaneCommand(agent({ ...input, dialect: "pwsh" }), RUNTIME);
    expect(ps5.command_text).toBe(pwsh.command_text);
    const { command_text } = ps5;
    expect(command_text).not.toContain("&&");
    expect(command_text).not.toMatch(/\benv\b/u);
    expect(command_text).not.toContain("$env:");
    expect(command_text).not.toContain("Set-Location"); // pane cwd untouched in env mode
    expect(command_text).toContain("$global:LASTEXITCODE = $LASTEXITCODE");
    const expectedToken = encodePaneRunnerPayload(agent({ ...input, dialect: "powershell5" }));
    expect(command_text).toBe(
      `& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\tut\\dist\\launcher\\pane-runner.js' --payload '${expectedToken}'; $global:LASTEXITCODE = $LASTEXITCODE`,
    );
  });

  it("the payload carries cwd/executable/args/env byte-for-byte; args order unchanged", () => {
    const { command_text } = renderPaneCommand(agent({ ...input, dialect: "pwsh" }), RUNTIME);
    expect(decodePayload(payloadTokenOf(command_text))).toEqual({
      protocol_version: 1,
      cwd: "C:\\work dir\\O'Brien",
      executable: "pi",
      args: ["--model", "大模型"],
      env: { PI_SKIP_VERSION_CHECK: "1" },
      purpose: "agent",
    });
  });
});

// --- golden vector: cmd-expansion-characters ------------------------------------------

describe("golden vector: cmd-expansion-characters (dynamic values never meet cmd)", () => {
  const input = {
    cwd: "C:\\work 100% ^ (x)!",
    executable: "pi",
    args: ["--note", "a&b;c"],
    env: { PI_SKIP_VERSION_CHECK: "1" },
  } as const;

  it("unsafe dynamic values select the encoded runner and decode exactly", () => {
    const { command_text } = renderPaneCommand(agent({ ...input, dialect: "cmd" }), RUNTIME);
    const withoutPayload = command_text.replace(/--payload "[A-Za-z0-9_-]+"/u, "--payload <token>");
    for (const unsafe of ["%", "!", "^", "&", "(", ")", ";"]) {
      expect(withoutPayload, `no raw ${unsafe} outside the payload`).not.toContain(unsafe);
    }
    expect(withoutPayload).not.toMatch(/\bset\b/u);
    expect(withoutPayload).not.toContain(" /c ");
    expect(decodePayload(payloadTokenOf(command_text))).toEqual({
      protocol_version: 1,
      cwd: "C:\\work 100% ^ (x)!",
      executable: "pi",
      args: ["--note", "a&b;c"],
      env: { PI_SKIP_VERSION_CHECK: "1" },
      purpose: "agent",
    });
  });

  it("the safe direct form keeps cd /d semantics: spaces quoted, no encoding", () => {
    const { command_text } = renderPaneCommand(
      agent({ cwd: "C:\\work dir", executable: "C:\\pi\\pi.exe", args: ["--model", "gpt 5"], dialect: "cmd" }),
      RUNTIME,
    );
    expect(command_text).toBe('cd /d "C:\\work dir" && "C:\\pi\\pi.exe" "--model" "gpt 5"');
  });

  it("an empty-string arg survives both cmd modes", () => {
    expect(renderPaneCommand(agent({ cwd: "C:\\w", executable: "pi", args: [""], dialect: "cmd" })).command_text)
      .toBe('cd /d "C:\\w" && "pi" ""');
    const encoded = renderPaneCommand(agent({ cwd: "C:\\w", executable: "pi", args: [""], env: { A: "1" }, dialect: "cmd" }), RUNTIME);
    expect(decodePayload(payloadTokenOf(encoded.command_text)).args).toEqual([""]);
  });
});

// --- golden vector: control-argv-raw --------------------------------------------------

describe("golden vector: control-argv-raw (only pane run receives the rendered string)", () => {
  interface CapturedCall {
    file: string;
    args: string[];
  }

  const makeClient = (): { client: HerdrClient; calls: CapturedCall[] } => {
    const calls: CapturedCall[] = [];
    const fakeSpawn = ((_file: string, args: readonly string[]) => {
      calls.push({ file: _file, args: [...args] });
      const child = new EventEmitter() as ChildProcess & { stdout: null; stderr: null };
      child.stdout = null;
      child.stderr = null;
      // The client settles on close; run notification loops only touch stdio
      // after registration, which the null sinks make safe.
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    }) as unknown as NonNullable<HerdrClientOptions["spawnFn"]>;
    return { client: new HerdrClient({ spawnFn: fakeSpawn }), calls };
  };

  it("pane rename carries the raw label as ONE argv item — label with & and β unquoted", async () => {
    const { client, calls } = makeClient();
    await expect(client.paneRename("w1:p2", "task.role & β")).resolves.toBeTruthy();
    const rename = calls.at(-1);
    expect(rename?.args).toEqual(["pane", "rename", "w1:p2", "task.role & β"]);
  });

  it("pane run argv is exactly [pane, run, paneId, command_text]", async () => {
    const { client, calls } = makeClient();
    const command_text = "cd -- '/repo' && 'codex' '--model' 'gpt 5' 'β'";
    await client.paneRun("w1:p2", command_text);
    const run = calls.at(-1);
    expect(run?.args).toHaveLength(4);
    expect(run?.args).toEqual(["pane", "run", "w1:p2", command_text]);
  });

  it("send-text keeps prompt punctuation as literal argv, never shell syntax", async () => {
    const { client, calls } = makeClient();
    await client.paneSendText("w1:p2", "轮到你了（role: executor）— O'Brien & \"quoted\"");
    expect(calls.at(-1)?.args).toEqual(["pane", "send-text", "w1:p2", "轮到你了（role: executor）— O'Brien & \"quoted\""]);
  });
});

// --- golden vector: route-order-and-suppression ---------------------------------------

describe("golden vector: route-order-and-suppression (renderer consumes the frozen plan)", () => {
  const route = { agent: "codex", args: ["--model", "gpt 5", "--search"] };

  it("suppression on (default): codex gains exactly the two tail tokens; gpt 5 never re-splits", () => {
    const plan = posixDirectPlanFor(route, {});
    const { command_text } = renderPaneCommand({
      cwd: "/repo", executable: plan.executable, args: plan.args, env: plan.env, dialect: "posix", purpose: "agent",
    });
    expect(command_text).toBe(
      "cd -- '/repo' && 'codex' '--model' 'gpt 5' '--search' '-c' 'check_for_update_on_startup=false'",
    );
  });

  it("TUT_SUPPRESS_AGENT_UPDATE=0: raw route only", () => {
    const plan = posixDirectPlanFor(route, { TUT_SUPPRESS_AGENT_UPDATE: "0" });
    const { command_text } = renderPaneCommand({
      cwd: "/repo", executable: plan.executable, args: plan.args, env: plan.env, dialect: "posix", purpose: "agent",
    });
    expect(command_text).toBe("cd -- '/repo' && 'codex' '--model' 'gpt 5' '--search'");
  });

  it("pi suppression is a one-shot env operand, child-scoped by the renderer", () => {
    const plan = posixDirectPlanFor({ agent: "pi", args: ["--model", "fast"] }, {});
    const { command_text } = renderPaneCommand({
      cwd: "/repo", executable: plan.executable, args: plan.args, env: plan.env, dialect: "posix", purpose: "agent",
    });
    expect(command_text).toBe("cd -- '/repo' && env 'PI_SKIP_VERSION_CHECK=1' 'pi' '--model' 'fast'");
  });

  it("POSIX keeps the BARE route agent — the which path never enters the command", () => {
    const { command_text } = renderPaneCommand(agent({ cwd: "/repo", executable: "pi" }));
    expect(command_text).toBe("cd -- '/repo' && 'pi'");
    expect(command_text).not.toContain("/usr/");
    expect(command_text).not.toContain("/opt/");
  });
});

// --- service legacy parity + runtime path policy --------------------------------------

describe("service commands: POSIX legacy bytes through the shared renderer", () => {
  it("byte-identical cd && node form, with and without flags", () => {
    const base = { executable: "node", env: {}, dialect: "posix", purpose: "service" } as const;
    expect(renderPaneCommand({ ...base, cwd: "/x/proj", args: ["/x/proj/dist/cli.js", "serve"] }).command_text)
      .toBe("cd /x/proj && node /x/proj/dist/cli.js serve");
    expect(renderPaneCommand({ ...base, cwd: "/x/proj", args: ["/x/proj/dist/cli.js", "notify", "--url", "http://127.0.0.1:3101"] }).command_text)
      .toBe("cd /x/proj && node /x/proj/dist/cli.js notify --url http://127.0.0.1:3101");
  });

  it("service + PowerShell: the pane never sees && nor a POSIX env", () => {
    const { command_text } = renderPaneCommand({
      cwd: "C:\\proj", executable: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\proj\\dist\\cli.js", "serve"], env: {}, dialect: "powershell5", purpose: "service",
    });
    expect(command_text).not.toContain("&&");
    expect(command_text).toContain("Set-Location -LiteralPath 'C:\\proj'");
    expect(command_text).toContain("& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\proj\\dist\\cli.js' 'serve'");
  });

  it("service + cmd dual mode: safe direct, unsafe cwd encoded", () => {
    const safe = renderPaneCommand({
      cwd: "C:\\my proj", executable: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\my proj\\dist\\cli.js", "notify"], env: {}, dialect: "cmd", purpose: "service",
    }, RUNTIME);
    expect(safe.command_text).toBe('cd /d "C:\\my proj" && "C:\\Program Files\\nodejs\\node.exe" "C:\\my proj\\dist\\cli.js" "notify"');
    const unsafe = renderPaneCommand({
      cwd: "C:\\100% proj", executable: "C:\\node.exe",
      args: ["C:\\cli.js", "serve"], env: {}, dialect: "cmd", purpose: "service",
    }, RUNTIME);
    expect(unsafe.command_text).not.toContain("100%"); // unsafe value lives only in the payload
    expect(decodePayload(payloadTokenOf(unsafe.command_text)).cwd).toBe("C:\\100% proj");
    expect(decodePayload(payloadTokenOf(unsafe.command_text)).purpose).toBe("service");
  });
});

describe("cmd runtime path policy (CmdRuntimePathError before Herdr mutation)", () => {
  const unsafePlan = { cwd: "C:\\work 100%", executable: "pi", args: [], env: { A: "1" }, dialect: "cmd" as const, purpose: "agent" as const };

  it("relative runtime paths are refused", () => {
    expect(() => renderPaneCommand(agent(unsafePlan), { ...RUNTIME, nodeExecutable: "node.exe" })).toThrowError(CmdRuntimePathError);
    expect(() => renderPaneCommand(agent(unsafePlan), { ...RUNTIME, paneRunnerEntry: "pane-runner.js" })).toThrowError(CmdRuntimePathError);
  });

  it("runtime paths with cmd expansion characters are refused", () => {
    expect(() => renderPaneCommand(agent(unsafePlan), { ...RUNTIME, nodeExecutable: "C:\\node^1\\node.exe" })).toThrowError(CmdRuntimePathError);
    expect(() => renderPaneCommand(agent(unsafePlan), { ...RUNTIME, paneRunnerEntry: "C:\\tut(x)\\pane-runner.js" })).toThrowError(CmdRuntimePathError);
  });

  it("spaces in runtime paths are supported (Program Files)", () => {
    const { command_text } = renderPaneCommand(agent(unsafePlan), RUNTIME);
    expect(command_text).toContain('"C:\\Program Files\\nodejs\\node.exe"');
  });

  it("the direct form never inspects runtime paths — only encoded mode needs them", () => {
    const broken = { nodeExecutable: "node.exe", paneRunnerEntry: "x" };
    const { command_text } = renderPaneCommand(agent({ cwd: "C:\\w", executable: "pi", dialect: "cmd" }), broken);
    expect(command_text).toBe('cd /d "C:\\w" && "pi"');
  });
});

// --- payload encoding contract ---------------------------------------------------------

describe("pane-runner payload encoding", () => {
  it("key order is frozen: protocol_version, cwd, executable, args, env, purpose", () => {
    const token = encodePaneRunnerPayload(agent({
      cwd: "/r", executable: "pi", args: ["a", ""], env: { PI_SKIP_VERSION_CHECK: "1" },
    }));
    const json = Buffer.from(token, "base64url").toString("utf8");
    expect(json).toBe('{"protocol_version":1,"cwd":"/r","executable":"pi","args":["a",""],"env":{"PI_SKIP_VERSION_CHECK":"1"},"purpose":"agent"}');
  });

  it("tokens are unpadded base64url only", () => {
    const token = encodePaneRunnerPayload(agent({ cwd: "/r" }));
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(token).not.toContain("=");
  });

  it("invalid PaneCommands are refused before rendering", () => {
    expect(() => renderPaneCommand(agent({ cwd: "" }))).toThrowError(PaneCommandError);
    expect(() => renderPaneCommand(agent({ executable: "" }))).toThrowError(PaneCommandError);
    expect(() => renderPaneCommand(agent({ args: ["a\u0000b"] }))).toThrowError(PaneCommandError);
    expect(() => renderPaneCommand(agent({ env: { "bad-name": "1" } }))).toThrowError(PaneCommandError);
    expect(() => renderPaneCommand(agent({ env: { A: "a\r\nb" } }))).toThrowError(PaneCommandError);
    expect(() => renderPaneCommand(agent({ dialect: "zsh" as never }))).toThrowError(PaneCommandError);
  });

  it("default runtime resolves the package-absolute pane-runner entry from src and dist alike", () => {
    const runtime = defaultPaneRuntime("file:///repo/src/launcher/shell-renderer.ts");
    expect(runtime.paneRunnerEntry).toBe("/repo/dist/launcher/pane-runner.js");
    expect(runtime.nodeExecutable).toBe(process.execPath);
  });
});
