import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgets, inventory, manifest, nodeExtras, planProfile, selectProfile, validateInventory } from './profiles.mjs';

test('all 112 original suite names have exactly one environment/component owner', () => {
  assert.equal(manifest.suites.length, 112);
  assert.equal(validateInventory().length, 115);
  assert.deepEqual(manifest.additionalSuites.map(suite => suite.path), [
    'test/integration/stack/event-chain-default-url.test.ts',
    'test/measure/observation/headless-observation.test.ts',
    'test/core/hub/task-prune.test.ts',
  ]);
  assert.equal(new Set(manifest.suites.map(suite => suite.previousPath)).size, 112);
  for (const suite of manifest.suites) assert.equal(suite.path.split('/').at(-1), suite.previousPath.split('/').at(-1));
  assert.throws(() => validateInventory([...inventory(), 'test/orphan.test.ts']), /inventory drift/);
});
test('Windows gate keeps native Windows, probe and three-agent acceptance, excluding Herdr/power/measure', () => {
  const selected = selectProfile('win32-gate');
  for (const name of ['windows-native', 'agent-probe', 'agent-profile-contracts', 'headless-opencode', 'headless-observation', 'close-audit']) assert.ok(selected.some(file => file.endsWith(`/${name}.test.ts`)), name);
  assert.ok(selected.every(file => !/\/(herdr|power|measure|shared)\//.test(file)));
  const jobs = planProfile('win32-gate');
  const planned = jobs.flatMap(job => job.files).filter(file => file.startsWith('test/'));
  assert.deepEqual(planned.slice().sort(), selected.slice().sort());
  assert.equal(new Set(planned).size, planned.length);
  assert.ok(jobs.filter(job => job.files.some(file => file.startsWith('test/lanes/'))).every(job => job.files.length === 1));
  assert.ok(jobs[1].files[0].endsWith('/windows-native.test.ts'));
  assert.equal(jobs.find(job => job.id === 'close-audit-vitest').budgetMs, 600000);
  assert.equal(jobs.find(job => job.id === 'observation-vitest').budgetMs, 300000);
});
test('mac developer gate retains Herdr and excludes measure and the declared native-process budget tier', () => {
  const selected = selectProfile('dev-mac');
  assert.ok(selected.some(file => file.endsWith('/launcher-herdr-v2.test.ts')));
  assert.ok(!selected.some(file => file.includes('/measure/') || ['close-audit', 'run', 'run-cooperative', 'run-resume', 'launcher-detached', 'power-standalone'].some(name => file.endsWith(`/${name}.test.ts`))));
});
test('release plan partitions all suites once and includes existing Node test entrypoints', () => {
  const plan = planProfile('release-full');
  const files = plan.flatMap(job => job.files);
  assert.equal(new Set(files).size, files.length);
  assert.deepEqual(files.filter(file => file.startsWith('test/')).sort(), inventory());
  for (const file of nodeExtras) assert.ok(files.includes(file));
  assert.equal(plan.find(job => job.id === 'close-audit-vitest').budgetMs, budgets.closeAudit);
  assert.equal(plan.find(job => job.id === 'observation-vitest').budgetMs, budgets.observation);
});
test('components select all their owners across environments, and typos fail closed', () => {
  const files = selectProfile('component:run');
  assert.ok(files.includes('test/measure/run/run-lock-sharing.test.ts'));
  assert.ok(files.includes('test/integration/run/run-hub.test.ts'));
  assert.ok(selectProfile('component:herdr').every(file => file.startsWith('test/lanes/herdr/')));
  assert.throws(() => selectProfile('component:typo'), /unknown component/);
  assert.throws(() => selectProfile('typo'), /unknown test profile/);
});
