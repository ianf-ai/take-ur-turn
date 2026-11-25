import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJob } from './process.mjs';
import { planProfile, selectProfile, validateInventory } from './profiles.mjs';

process.chdir(fileURLToPath(new URL('../../', import.meta.url)));
const [profile = 'release-full', option] = process.argv.slice(2);
try {
  validateInventory();
  const plan = planProfile(profile);
  if (option && option !== '--list') throw new Error(`unknown option: ${option}`);
  if (option === '--list') { console.log(JSON.stringify({ profile, selected: selectProfile(profile), plan }, null, 2)); }
  else {
    if (profile === 'win32-gate' && process.platform !== 'win32') throw new Error('win32-gate requires native Windows; use --list to inspect it');
    if (profile === 'dev-mac' && process.platform !== 'darwin') throw new Error('dev-mac requires macOS; use --list to inspect it');
    if (process.platform === 'win32') {
      for (const command of ['git', 'sh.exe']) {
        const probe = spawnSync(command, ['--version'], { windowsHide: true, timeout: 5000 });
        if (probe.status !== 0) {
          const error = new Error(`environment preflight: ${command} is unavailable; put the installed Git cmd and bin directories on PATH`);
          error.exitCode = 2;
          throw error;
        }
      }
    }
    const resultsDir = process.env.TUT_TEST_RESULTS_DIR ? path.resolve(process.env.TUT_TEST_RESULTS_DIR) : mkdtempSync(path.join(tmpdir(), 'tut-tests-'));
    mkdirSync(resultsDir, { recursive: true });
    const results = [];
    console.log(`Profile ${profile}; serial; artifacts ${resultsDir}`);
    for (const job of plan) {
      const result = await runJob(job, { profile, resultsDir });
      results.push(result);
      writeFileSync(path.join(resultsDir, 'summary.json'), JSON.stringify({ profile, platform: process.platform, results }, null, 2) + '\n');
      if (result.interrupted) break;
    }
    const failed = results.filter(result => result.exitCode !== 0);
    console.log(`\n${profile}: ${results.length} processes, ${failed.length} failed; ${path.join(resultsDir, 'summary.json')}`);
    process.exitCode = failed.length ? (failed.some(result => result.timedOut) ? 124 : 1) : 0;
  }
} catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1; }
