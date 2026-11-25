/** Architecture contract for the production host entries (includes type edges). */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const root = path.join(repo, 'src');
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
  it('keeps remediation evidence and shared identity/checkout leaves independent of hosts', () => {
    const edges = graph(root, '.ts');
    const leaf = 'herdr/launcher/remediation-contracts.ts';
    expect(edges.get(leaf)).toEqual([]);
    expect(edges.get('herdr/launcher/delivery.ts')).toContain(leaf);
    expect(edges.get('herdr/launcher/remediator.ts')).toContain(leaf);
    const delivery = closure(edges, 'herdr/launcher/delivery.ts');
    expect(delivery.has('herdr/launcher/remediator.ts')).toBe(false);
    for (const neutral of ['hub/rig-identity.ts', 'core/launcher/checkout-provider.ts']) {
      expect([...closure(edges, neutral)].some(p => /^(herdr|standalone)\//.test(p))).toBe(false);
    }
  });

  for (const ext of ['.ts', '.js'] as const) {
    it(`keeps both complete ${ext} import closures disjoint from the opposite host`, () => {
      const edges = graph(ext === '.ts' ? root : path.join(repo, 'dist'), ext);
      for (const [file, targets] of edges) {
        if (file.startsWith('core/')) {
          expect(targets.filter(target => /^(herdr|standalone)\//.test(target)), file).toEqual([]);
        }
      }
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
      for (const caller of ['app/cli/rig', 'app/cli/task', 'app/doctor/index', 'app/notifier/notifier']) {
        expect(edges.get(caller + ext)).toContain(`herdr/host-entry${ext}`);
        expect(edges.get(caller + ext)).toContain(`standalone/host-entry${ext}`);
      }
    });
  }

  it('keeps shared notifier closures neutral and the remaining notifier facade one-way', () => {
    const edges = graph(root, '.ts');
    const shared = ['engine', 'shared-contracts', 'log-cache', 'notifications', 'launch-catchup', 'launch-revalidate'];
    for (const name of shared) {
      const entry = `core/notifier/${name}.ts`;
      const reached = closure(edges, entry);
      expect([...reached].filter(p => /^(herdr|standalone|app)\//.test(p)), entry).toEqual([]);
      expect(reached.has('core/notifier/notifier.ts'), entry).toBe(false);
    }
    for (const file of ['herdr/notifier/contracts.ts', 'standalone/notifier/contracts.ts']) {
      const reached = closure(edges, file);
      expect([...reached].filter(p => p.startsWith('app/')), file).toEqual([]);
    }
    expect(edges.get('core/notifier/notifier.ts')).toEqual(['app/notifier/notifier.ts']);
    expect(edges.get('app/notifier/compat-contracts.ts')).toEqual([
      'core/notifier/shared-contracts.ts', 'herdr/notifier/contracts.ts', 'standalone/notifier/contracts.ts',
    ]);
    for (const facade of ['core/notifier/notifier.ts']) {
      const callers = [...edges].filter(([, targets]) => targets.includes(facade)).map(([file]) => file);
      expect(callers).toEqual([]);
      const source = ts.createSourceFile(facade, readFileSync(path.join(root, facade), 'utf8'), ts.ScriptTarget.Latest, true);
      expect(source.statements.every(ts.isExportDeclaration), facade).toBe(true);
    }
    // Baseline 3e5f644a has no non-trivial source SCC (value AND type edges).
    for (const [file, targets] of edges) {
      for (const target of targets) expect(closure(edges, target).has(file), `${file} -> ${target} creates a cycle`).toBe(false);
    }
  });

  it('keeps CLI policies, Doctor checks and views neutral; legacy entries have no production callers', () => {
    const edges = graph(root, '.ts');
    for (const entry of [
      'core/cli/host-ports.ts', 'core/cli/task-handlers.ts', 'core/cli/rig-handlers.ts',
      'core/cli/misc-handlers.ts', 'core/cli/doctor.ts', 'core/cli/live-view.ts',
      'core/doctor/runner.ts', 'core/cli/live-view/view.ts',
    ]) {
      const reached = closure(edges, entry);
      expect([...reached].filter(p => /^(herdr|standalone|app)\//.test(p)), entry).toEqual([]);
    }
    for (const [facade, implementation] of [
      ['core/cli.ts', 'app/cli.ts'],
      ['core/cli/task.ts', 'app/cli/task.ts'],
      ['core/cli/rig.ts', 'app/cli/rig.ts'],
      ['core/doctor/index.ts', 'app/doctor/index.ts'],
    ]) {
      expect(edges.get(facade!)).toContain(implementation);
      expect([...edges].filter(([, targets]) => targets.includes(facade!)), facade).toEqual([]);
    }
    expect([...edges].filter(([, targets]) => targets.includes('core/cli/misc.ts'))).toEqual([]);
    // Production CLI consumes the single application Notifier assembly.
    expect(edges.get('app/cli/rig.ts')).toContain('app/notifier/notifier.ts');
  });

  it('retains the old callable APIs as the same production exports', async () => {
    const pairs = await Promise.all([
      Promise.all([import('../../../src/core/cli.js'), import('../../../src/app/cli.js')]),
      Promise.all([import('../../../src/core/cli/task.js'), import('../../../src/app/cli/task.js')]),
      Promise.all([import('../../../src/core/cli/rig.js'), import('../../../src/app/cli/rig.js')]),
      Promise.all([import('../../../src/core/doctor/index.js'), import('../../../src/app/doctor/index.js')]),
    ]);
    for (const [legacy, production] of pairs) {
      expect(Object.keys(legacy).sort()).toEqual(Object.keys(production).sort());
      for (const key of Object.keys(production)) {
        expect((legacy as Record<string, unknown>)[key], key).toBe((production as Record<string, unknown>)[key]);
      }
    }
  });

  it('rejects core imports of host lanes and neutral leaves importing assembly roots', () => {
    const edges = graph(root, '.ts');
    for (const [file, targets] of edges) {
      if (!file.startsWith('core/')) continue;
      for (const target of targets) {
        expect(/^(herdr|standalone)\//.test(target), `${file} imports ${target}`).toBe(false);
        if (['core/cli.ts', 'cli.ts', 'app/cli.ts', 'app/cli/rig.ts', 'app/cli/task.ts', 'app/cli/doctor.ts', 'app/doctor/index.ts', 'app/notifier/notifier.ts', 'core/notifier/notifier.ts', 'herdr/host-entry.ts', 'standalone/host-entry.ts'].includes(target)) {
          expect(['core/cli.ts', 'core/cli/rig.ts', 'core/cli/task.ts', 'core/cli/misc.ts', 'core/doctor/index.ts', 'core/notifier/notifier.ts'].includes(file), `${file} reverses into ${target}`).toBe(true);
        }
      }
    }
    expect(edges.get('standalone/launcher-detached/start-next.ts')).toContain('core/notifier/launch-revalidate.ts');
    expect(edges.get('core/common/channels.ts')).toContain('core/common/shell-quote.ts');
  });
});
