import { readdirSync, readFileSync } from 'node:fs';

export const layers = ['core', 'lanes', 'integration', 'power', 'measure'];
export const manifest = JSON.parse(readFileSync(new URL('../../test/suites.json', import.meta.url), 'utf8'));
export const nativeBudgetFiles = new Set(manifest.suites.filter(suite => suite.budgetClass === 'native-process').map(suite => suite.path));
export const nodeExtras = [
  'scripts/usage-audit/test/audit.test.mjs',
  'scripts/usage-audit/test/windows.test.mjs',
  'scripts/usage-audit/lib/stall.test.mjs',
  'scripts/test/profiles.test.mjs',
  'scripts/test/process.test.mjs',
];

export function inventory(root = new URL('../../test/', import.meta.url)) {
  const walk = (dir, prefix = 'test') => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const name = `${prefix}/${entry.name}`;
    return entry.isDirectory() ? walk(new URL(`${entry.name}/`, dir), name) : /\.test\.(ts|mjs)$/.test(entry.name) ? [name] : [];
  });
  return walk(root).sort();
}

export function validateInventory(files = inventory()) {
  const baseline = manifest.suites.map(suite => suite.path);
  const additions = manifest.additionalSuites ?? [];
  const declared = [...baseline, ...additions.map(suite => suite.path)].sort();
  if (new Set(baseline).size !== baseline.length || baseline.length !== manifest.baselineCount) throw new Error('duplicate/missing baseline suite declaration');
  if (new Set(declared).size !== declared.length || additions.some(suite => !baseline.includes(suite.extractedFrom))) throw new Error('invalid extracted suite declaration');
  if (JSON.stringify(files) !== JSON.stringify(declared)) throw new Error('suite inventory drift: every test must have exactly one manifest entry');
  for (const file of files) {
    if (!/^test\/(core|lanes|integration|power|measure)\/[^/]+\/[^/]+\.test\.(ts|mjs)$/.test(file)) throw new Error(`invalid environment/component path: ${file}`);
  }
  return files;
}

export function selectProfile(profile, files = validateInventory()) {
  if (profile === 'release-full') return files;
  if (profile === 'dev-mac') return files.filter(file => !file.startsWith('test/measure/') && !nativeBudgetFiles.has(file));
  if (profile === 'win32-gate') return files.filter(file => /^test\/(core\/|lanes\/(detached|windows)\/|integration\/)/.test(file));
  if (profile.startsWith('component:')) {
    const component = profile.slice('component:'.length);
    const chosen = files.filter(file => file.split('/')[2] === component || file.split('/')[1] === component);
    if (!chosen.length) throw new Error(`unknown component: ${component}`);
    return chosen;
  }
  throw new Error(`unknown test profile: ${profile}`);
}

// Watchdog budgets bound whole test processes, independent of case timeouts.
// Budget expiry is a failed gate (124), never a synthetic pass/exclusion.
export const budgets = { default: 30 * 60_000, closeAudit: 10 * 60_000, observation: 5 * 60_000, measure: 15 * 60_000 };
export function planProfile(profile) {
  const selected = selectProfile(profile);
  const groups = new Map();
  for (const file of selected) {
    const nativeSuite = profile === 'win32-gate' && file.startsWith('test/lanes/') ? `lane-${file.split('/').at(-1).split('.test.')[0]}` : undefined;
    const key = file.endsWith('/close-audit.test.ts') ? 'close-audit' : file === 'test/lanes/detached/headless-observation.test.ts' ? 'observation' : nativeSuite ?? file.split('/')[1];
    const engine = file.endsWith('.mjs') ? 'node' : 'vitest';
    const id = `${key}-${engine}`;
    if (!groups.has(id)) groups.set(id, { id, engine, files: [], budgetMs: key === 'close-audit' ? budgets.closeAudit : key === 'observation' ? budgets.observation : key === 'measure' ? budgets.measure : budgets.default });
    groups.get(id).files.push(file);
  }
  if (['release-full', 'dev-mac', 'win32-gate', 'component:usage'].includes(profile)) groups.set('usage-node', { id: 'usage-node', engine: 'node', files: nodeExtras, budgetMs: budgets.default });
  const jobs = [...groups.values()];
  if (profile === 'win32-gate') {
    const priority = job => job.id === 'core-vitest' ? 0 : job.files.some(file => file.endsWith('/windows-native.test.ts')) ? 1 : 2;
    jobs.sort((a, b) => priority(a) - priority(b));
  }
  return jobs;
}
