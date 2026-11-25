import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as legacy from "../../../src/core/launcher/invocation.js";
import * as codec from "../../../src/protocol/launch-codec.js";
import * as policy from "../../../src/protocol/launch-policy.js";
import { LaunchInvocationError } from "../../../src/protocol/launch-error.js";
import { paneEnvArgs } from "../../../src/herdr/launcher/command-context.js";
import { rigEnvironment } from "../../../src/hub/rig-identity.js";
import { CommandInputError, PaneCommandError, psq } from "../../../src/core/common/shell-quote.js";

describe("launch compatibility identities", () => {
  it("keeps every old runtime export on the single policy/codec implementation", () => {
    const exports = { ...codec, ...policy, LaunchInvocationError };
    expect(Object.keys(legacy).sort()).toEqual(Object.keys(exports).sort());
    for (const [name, value] of Object.entries(exports)) {
      expect(legacy[name as keyof typeof legacy]).toBe(value);
    }
  });

  it("keeps raw Herdr env argv in insertion order while the Hub root stays shared", () => {
    const env = rigEnvironment("/shared/O'Brien β", "http://localhost:3001", "http://localhost:3002");
    expect(paneEnvArgs(env)).toEqual([
      "--env", "TUT_HUB_ROOT=/shared/O'Brien β",
      "--env", "TUT_HUB_URL=http://localhost:3001",
      "--env", "TUT_EVENT_PORT_URL=http://localhost:3002",
    ]);
    expect(paneEnvArgs({ Z: "", A: "x=y & z" })).toEqual(["--env", "Z=", "--env", "A=x=y & z"]);
  });

  it("exposes the neutral quote error as the same historical constructor", () => {
    expect(CommandInputError).toBe(PaneCommandError);
    for (const value of ["\0", "\r", "\n"]) {
      try {
        psq(value);
        expect.fail("invalid raw input was accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(CommandInputError);
        expect(error).toBeInstanceOf(PaneCommandError);
        expect(error).toMatchObject({ name: "PaneCommandError", message: "psq input must be a string without NUL/CR/LF" });
      }
    }
  });
});

describe("frozen v2 lane boundary", () => {
  it.each(["native", "node-entry"] as const)("round-trips a Windows %s target without any pane anchor", kind => {
    const plan = codec.buildLaunchInvocation({
      request: { kind: "round", task_id: "wire", role: "executor", fresh: false, via: "auto" },
      base_version: 4,
      hub_url: "http://localhost:3001",
      route: "pi",
      route_source: "task-cast",
      prompt: "开始 β",
      context: {
        hubRoot: "C:\\hub", routingRoot: "C:\\routing", checkoutRoot: "C:\\work tree",
        checkout: { kind: "worktree", path: "C:\\work tree" }, context: { kind: "shared" }, source: "project-root",
      },
      resolved_target: { kind, executable: "C:\\node.exe", prefix_args: ["C:\\agent.js"], source_path: "C:\\agent.cmd" },
      effective_agent: { executable: "C:\\node.exe", args: ["C:\\agent.js", "β"], env: { A: "x y" } },
    });
    expect(plan.context.anchor).toBeUndefined();
    const wire = codec.serializeLaunchInvocation(plan);
    expect(codec.serializeLaunchInvocation(codec.deserializeLaunchInvocation(wire))).toBe(wire);
    expect(plan.marker_projection).toEqual(policy.buildMarkerProjection({
      request: plan, base_version: 4, route: "pi", route_source: "task-cast",
      resolved_target: plan.resolved_target!, effective_agent: plan.effective_agent!,
    }));
    const marker = JSON.stringify(plan.marker_projection);
    for (const privateField of ["anchor", "naming", "checkoutRoot", "effective_agent", "source_path"]) {
      expect(marker).not.toContain(privateField);
    }
  });

  it("keeps protocol leaves independent of host, core and compatibility facades, including type edges", () => {
    const root = fileURLToPath(new URL("../../../src/protocol", import.meta.url));
    for (const name of readdirSync(root).filter(name => name.endsWith(".ts"))) {
      const source = ts.createSourceFile(name, readFileSync(path.join(root, name), "utf8"), ts.ScriptTarget.Latest, true);
      const inspect = (node: ts.Node): void => {
        let specifier: string | undefined;
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          specifier = node.moduleSpecifier.text;
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
          specifier = node.argument.literal.text;
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          specifier = node.arguments[0].text;
        }
        if (specifier !== undefined) {
          expect(specifier === "node:crypto" || /^\.\/[^/]+\.js$/u.test(specifier), `${name}: ${specifier}`).toBe(true);
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }
  });
});
