import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { nativeArgv } from '../src/standalone/launcher-headless/plan.js';

const prompt = 'parser check 空格🙂';
const session = '12345678-1234-1234-1234-123456789abc';
const common = ['-m', 'model', '-c', 'model_reasoning_effort=high', '-s', 'read-only', '-p', 'parser-profile', '-a', 'on-request'];

describe('headless Codex option scopes', () => {
  it.each([undefined, session])('preserves global settings once with exec-specific options (session=%s)', id => {
    const args = [...common, 'exec', '--skip-git-repo-check', '--color', 'never', '--ephemeral', '--output-schema', 'schema.json', '--json'];
    const argv = nativeArgv({ agent: 'codex', args }, prompt, id);
    const rootEnd = argv.indexOf('exec');
    expect(argv.slice(1, rootEnd)).toEqual(common);
    expect(argv.filter(v => v === 'exec')).toHaveLength(1);
    for (const option of ['--skip-git-repo-check', '--color', '--ephemeral', '--output-schema', '--json']) {
      expect(argv.filter(v => v === option)).toHaveLength(1);
      expect(argv.indexOf(option)).toBeGreaterThan(rootEnd);
    }
    if (id) {
      expect(argv.indexOf('--color')).toBeLessThan(argv.indexOf('resume'));
      expect(argv.indexOf('--skip-git-repo-check')).toBeGreaterThan(argv.indexOf('resume'));
      expect(argv.slice(-2)).toEqual([id, prompt]);
    } else expect(argv.at(-1)).toBe(prompt);
    expect(argv).not.toContain('--approve-for-me');
    expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('preserves inline values, ordered repeated configs and an explicit permission policy', () => {
    const args = ['--model=model', '-cfirst=1', '-c', 'second=2', '--sandbox=read-only', '--ask-for-approval=on-request', 'exec', '--color=never', '--output-schema=schema.json', '--skip-git-repo-check'];
    expect(nativeArgv({ agent: 'codex', args }, prompt, session)).toEqual([
      'codex', ...args.slice(0, 6), 'exec', '--color=never', 'resume', '--output-schema=schema.json', '--skip-git-repo-check', '--json', session, prompt,
    ]);
  });

  it.each([
    ['exec', 'resume', session], ['exec', '--unknown-option'], ['exec', '--color'], ['exec', '--color='],
    ['--sandbox'], ['--cd', '/other'], ['--last'], ['--worktree'], ['--json', '--json'],
  ])('rejects ambiguous or unsupported options before any launch: %j', (...args) => {
    expect(() => nativeArgv({ agent: 'codex', args }, prompt, session)).toThrow();
  });
});

// These are native parser checks only: --help exits before config/profile,
// auth, session lookup or any model invocation. Machines without Codex retain
// the hermetic tests above and explicitly skip this integration group.
const probe = spawnSync('codex', ['exec', '--help'], { encoding: 'utf8', timeout: 8000 });
const available = probe.status === 0 && probe.stdout.includes('Usage: codex exec');
describe.skipIf(!available)('installed Codex parser (no model calls)', () => {
  it.each([undefined, session])('accepts fresh/resume option placement (session=%s)', id => {
    for (const args of [
      ['exec', '--skip-git-repo-check'],
      [...common, 'exec', '--skip-git-repo-check', '--color', 'never', '--ephemeral'],
      ['exec', '--color=never', '--output-schema=schema.json', '--ephemeral', '--ignore-user-config', '--ignore-rules'],
    ]) {
      const argv = nativeArgv({ agent: 'codex', args }, prompt, id);
      const result = spawnSync(argv[0]!, [...argv.slice(1), '--help'], { encoding: 'utf8', timeout: 8000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(id ? 'Usage: codex exec resume' : 'Usage: codex exec');
    }
  });
});
