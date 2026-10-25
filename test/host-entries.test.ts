/** Architecture contract for the production host entries (includes type edges). */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(repo, 'src');
// These are the only core modules allowed to assemble/re-export host behavior.
// Compatibility facades and single-host run/view adapters remain explicit.
const composition = new Set([
  'core/cli/rig.ts',
  'core/cli/task.ts',
  'core/cli/live-view.ts',
  'core/doctor/index.ts',
  'core/doctor/checks/power.ts',
  'core/launcher/entry.ts',
  'core/notifier/notifier.ts',
  'core/notifier/host-relay.ts',
  'core/remediator.ts',
  'core/run/launch-entry.ts',
  'core/run/resume.ts',
  'core/cli/run.ts',
]);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
}

function graph(sourceRoot: string, extension: '.ts' | '.js'): Map<string, string[]> {
  const entries = extension === '.ts' ? files(sourceRoot) : files(root).map(f => f.replace(root, sourceRoot).replace(/\.ts$/, '.js'));
  return new Map(entries.map(file => {
    const key = path.relative(sourceRoot, file).split(path.sep).join('/');
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const edges: string[] = [];
    function add(n: ts.Node | undefined) {
      if (!n || !ts.isStringLiteralLike(n) || !n.text.startsWith('.')) return;
      const target = path.resolve(path.dirname(file), n.text).replace(/\.js$/, extension);
      expect(existsSync(target), `${key}: missing ${n.text}`).toBe(true);
      edges.push(path.relative(sourceRoot, target).split(path.sep).join('/'));
    }
    function walk(n: ts.Node) {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) add(n.moduleSpecifier);
      else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) add(n.argument.literal);
      else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
        expect(n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]), `${key}: unresolved dynamic import`).toBe(true);
        add(n.arguments[0]);
      }
      ts.forEachChild(n, walk);
    }
    walk(ast);
    return [key, edges];
  }));
}

function closure(edges: Map<string, string[]>, entry: string): Set<string> {
  const seen = new Set<string>();
  function visit(file: string) {
    if (seen.has(file)) return;
    seen.add(file);
    for (const target of edges.get(file) ?? []) visit(target);
  }
  visit(entry);
  return seen;
}

describe('production dual host boundaries', () => {
  for (const ext of ['.ts', '.js'] as const) {
    it(`keeps both complete ${ext} import closures disjoint from the opposite host`, () => {
      const edges = graph(ext === '.ts' ? root : path.join(repo, 'dist'), ext);
      for (const [host, other] of [['herdr', 'standalone'], ['standalone', 'herdr']]) {
        const reached = closure(edges, `${host}/host-entry${ext}`);
        expect([...reached].filter(p => p.startsWith(`${other}/`))).toEqual([]);
        expect(reached.has(`core/notifier/notifier${ext}`)).toBe(false);
        expect(reached.has(`core/cli${ext}`)).toBe(false);
        expect([...reached].some(p => p.startsWith(`${host}/power/`))).toBe(true);
        expect([...reached].some(p => p.startsWith(`${host}/notifier/`))).toBe(true);
        expect([...reached].some(p => p.startsWith(`${host}/launcher`))).toBe(true);
      }
      // CLI really imports both entries; neither is just a measurement stub.
      const production = closure(edges, `cli${ext}`);
      expect(production.has(`herdr/host-entry${ext}`)).toBe(true);
      expect(production.has(`standalone/host-entry${ext}`)).toBe(true);
      for (const caller of ['core/cli/rig', 'core/cli/task', 'core/notifier/notifier']) {
        expect(edges.get(caller + ext)).toContain(`herdr/host-entry${ext}`);
        expect(edges.get(caller + ext)).toContain(`standalone/host-entry${ext}`);
      }
    });
  }

  it('freezes every core-to-host seam and rejects neutral leaves importing assembly roots', () => {
    const edges = graph(root, '.ts');
    const observed = new Set<string>();
    for (const [file, targets] of edges) {
      if (!file.startsWith('core/')) continue;
      for (const target of targets) {
        if (/^(herdr|standalone)\//.test(target)) {
          expect(composition.has(file), `${file} imports ${target}`).toBe(true);
          observed.add(file);
        }
        if (['core/cli.ts', 'cli.ts', 'core/notifier/notifier.ts', 'herdr/host-entry.ts', 'standalone/host-entry.ts'].includes(target)) {
          expect(composition.has(file), `${file} reverses into ${target}`).toBe(true);
        }
      }
    }
    expect([...observed].sort()).toEqual([...composition].sort());
    expect(edges.get('core/run/launch-entry.ts')).toContain('core/notifier/launch-revalidate.ts');
    expect(edges.get('core/common/channels.ts')).toContain('core/common/shell-quote.ts');
  });
});
