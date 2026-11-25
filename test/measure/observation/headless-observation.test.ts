import { NOW, fixture, notifierFixture } from '../../helpers/headless-observation.js';
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunStore } from '../../../src/core/run/store.js';

describe('24h observation measurements', () => {
  it.each(['tui', 'manual', 'foreign'])('24h pure %s task has no reconciliation false positives', async kind => {
    const f = await fixture();
    if (kind === 'manual') await f.run({ headless: undefined }, 0, false);
    if (kind === 'foreign') {
      const other = await fixture(); const m = await other.run();
      await f.append('note', 'human', { launch: { role: 'executor', base_version: 0, launch_mode: 'headless', attempt_id: m.headless!.attempt_id } });
    }
    const h = await notifierFixture(f); if (kind === 'tui') h.mode('tui'); await h.tick();
    for (let step = 1; step <= 17_280; step++) {
      h.now(NOW + step * 5000);
      if (step % 4320 === 0) { const r = await f.append('revision'); h.version(r.version); }
      await h.tick();
    }
    expect(f.reasons('stopped-without-publish')).toHaveLength(0); expect(f.reasons('ghost-delivery')).toHaveLength(0);
    expect(f.messages.some(m => m.title.includes('stalled'))).toBe(true); expect(h.launch).not.toHaveBeenCalled();
  }, 30_000);
  it('24h hermetic five-second observation: TUI, legacy, manual, foreign rig and mixed rounds have zero reconciliation false positives', async () => {
    // Real Store/RunStore fixtures; synthetic clock, not a live 24h soak.
    const f = await fixture(); await f.run({ ended_at: '2099-01-01T00:00:00Z' }); await f.append('code_changes');
    const h = await notifierFixture(f); h.mode('tui'); await h.tick();
    const foreignRoot = mkdtempSync(path.join(os.tmpdir(), 'tut-w3-foreign-')); const foreign = new RunStore(foreignRoot);
    const foreignId = foreign.create(); const own = f.runtime.runs()[0]!;
    await foreign.initialize(foreignId, { ...own, run_id: foreignId, headless: { ...own.headless!, attempt_id: randomUUID() } });
    const foreignAttempt = foreign.read(foreignId).headless!.attempt_id;
    for (let step = 1; step <= 17_280; step++) {
      h.now(NOW + step * 5000);
      if (step % 2880 === 0) {
        const phase = step / 2880;
        h.mode(phase === 1 ? 'tui' : 'detached');
        if (phase === 2) await f.append('note', 'human', { launch: { role: 'executor', base_version: (await f.hub.readTask(f.task)).versions.length } }); // legacy
        if (phase === 3) await f.append('note', 'human', { launch: { role: 'executor', base_version: (await f.hub.readTask(f.task)).versions.length, launch_mode: 'headless', attempt_id: foreignAttempt } });
        if (phase === 4) await f.run({ headless: undefined }, 0, false); // manual run proves no headless identity
        if (phase === 5) h.mode('tui');
        if (phase === 6) h.mode('detached');
        const r = await f.append('revision'); h.version(r.version);
      }
      await h.tick();
    }
    expect(f.reasons('stopped-without-publish')).toHaveLength(0); expect(f.reasons('ghost-delivery')).toHaveLength(0);
    expect(f.messages.some(m => m.title.includes('stalled'))).toBe(true); // channels remain live
    expect(h.launch).not.toHaveBeenCalled();
  }, 30_000);
});

// Native process/FD timing lives in measure; policy tests retain synthetic clocks.
import { spawn } from 'node:child_process';
import { openSync, readFileSync, fstatSync, statSync, closeSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { startServer } from '../../../src/hub/server.js';
import { writeConfigKey } from '../../../src/core/common/config.js';
import { createServer } from 'node:net';

async function loggingChild(code: string, stdio: ['ignore', number | 'ignore', number | 'ignore'] = ['ignore', 'ignore', 'ignore']): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`logging child exit ${code}`)));
  });
}
const loggingModule = pathToFileURL(path.resolve('dist/core/logging/managed-log.js')).href;
const serviceModule = pathToFileURL(path.resolve('dist/core/logging/service-log.js')).href;

describe('managed logging native writer boundaries', () => {
  it.each(['hub', 'notify', 'watcher'] as const)('managed %s entry retains an uncaught startup-after-listen stack and exits nonzero', async service => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tut-log-crash-entry-'));
    const storage = path.join(root, '.context-hub');
    await writeConfigKey(storage, { key: 'usage_audit', value: 'on' });
    const hub = service === 'hub' ? undefined : await startServer({ root: storage, port: 0 });
    const portProbe = createServer();
    await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const eventPort = (portProbe.address() as { port: number }).port;
    await new Promise<void>(resolve => portProbe.close(() => resolve()));
    const name = service === 'hub' ? 'power-hub.log' : service === 'notify' ? 'power-notify.log' : 'usage-audit.log';
    const file = path.join(storage, 'logs', 'diagnostics', name);
    const preload = path.join(root, 'crash-after-start.mjs');
    // Throw only after the real entry has established its service boundary.
    await writeFile(preload, `
      import { existsSync, readFileSync } from 'node:fs';
      const timer = setInterval(function crashAfterStartup() {
        let ready = false;
        try { ready = ${service === 'watcher'
          ? `existsSync(${JSON.stringify(path.join(storage, 'runtime', 'usage-audit.lock'))})`
          : `/http:|listening for agent events/.test(readFileSync(${JSON.stringify(file)}, 'utf8'))`}; } catch {}
        if (ready) { clearInterval(timer); throw new Error('injected uncaught ${service} failure'); }
      }, 10);
    `);
    const args = service === 'hub' ? [path.resolve('dist/cli.js'), 'serve', '--port', '0', '--root', storage]
      : service === 'notify' ? [path.resolve('dist/cli.js'), 'notify', '--url', hub!.url, '--event-port', String(eventPort)]
      : [path.resolve('scripts/usage-audit/run.mjs'), '--watch', '--root', root, '--url', hub!.url];
    try {
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, ...args], {
          cwd: root, env: { ...process.env, TUT_HUB_ROOT: root, TUT_HUB_URL: hub?.url ?? 'http://127.0.0.1:1', TUT_POWER_SESSION: 'test-managed-crash' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
        const rescue = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
        child.once('error', error => { clearTimeout(rescue); reject(error); });
        child.once('close', code => { clearTimeout(rescue); resolve({ code, output }); });
      });
      expect(result).toEqual({ code: 1, output: '' });
      const log = await readFile(file, 'utf8');
      expect(log).toContain(`Error: injected uncaught ${service} failure`);
      expect(log).toContain('at Timeout.crashAfterStartup');
      expect(Buffer.byteLength(log)).toBeLessThanOrEqual(5 * 1024 * 1024);
    } finally { await hub?.close(); await rm(root, { recursive: true, force: true }); }
  }, 10_000);

  it.each(['power-hub.log', 'power-notify.log', 'usage-audit.log'] as const)('file-only %s captures both streams without terminal mirroring', async name => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tut-log-file-only-'));
    try {
      const terminal = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', String.raw`
          import { installServiceLog } from ${JSON.stringify(serviceModule)};
          const close = installServiceLog(${JSON.stringify(root)}, ${JSON.stringify(name)}, { mirror: false });
          process.stdout.write('service stdout\n');
          await new Promise(resolve => process.stderr.write('service stderr\n', resolve));
          const bytes = Buffer.from('汉');
          process.stderr.write(bytes.subarray(0, 1)); process.stderr.write(bytes.subarray(1));
          await close();
        `], { stdio: ['ignore', 'pipe', 'pipe'] });
        let text = '';
        child.stdout.on('data', chunk => { text += chunk; });
        child.stderr.on('data', chunk => { text += chunk; });
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve(text) : reject(new Error(`logging child exit ${code}: ${text}`)));
      });
      expect(terminal).toBe('');
      expect(await readFile(path.join(root, 'logs', 'diagnostics', name), 'utf8')).toBe('service stdout\nservice stderr\n汉');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('three processes share the rotation lock; all UTF-8 messages survive across segments', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tut-log-process-'));
    try {
      const file = path.join(root, 'service.log');
      await Promise.all([0, 1, 2].map(writer => loggingChild(`
        import { ManagedLog } from ${JSON.stringify(loggingModule)};
        const sink = new ManagedLog(${JSON.stringify(file)}, { maxBytes: 1024 });
        for (let i=0; i<10; i++) { sink.write(${JSON.stringify(String(writer))}+':'+i+':'+'汉'.repeat(28)+'\\n'); await sink.flush(); }
      `)));
      const segments = (await readdir(root)).filter(s => /^service\.log(?:\.[12])?$/.test(s)).sort().reverse();
      expect(segments).toHaveLength(3);
      const lines = (await Promise.all(segments.map(s => readFile(path.join(root, s), 'utf8')))).join('').trim().split('\n');
      expect(lines).toHaveLength(30); expect(new Set(lines).size).toBe(30);
      expect(lines.join('')).not.toContain('\ufffd');
      for (const segment of segments) expect(statSync(path.join(root, segment)).size).toBeLessThanOrEqual(1024);
      for (let writer=0; writer<3; writer++) expect(lines.filter(s => s.startsWith(`${writer}:`)).map(s => Number(s.split(':')[1]))).toEqual(Array.from({length:10}, (_,i)=>i));
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15_000);
  it('a service with stdout/stderr still holding the old FD reopens the active path; no copytruncate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tut-log-heldfd-'));
    const storage = path.join(root, '.context-hub');
    const { mkdir } = await import('node:fs/promises'); await mkdir(path.join(storage, 'logs', 'diagnostics'), { recursive: true }); await mkdir(path.join(storage, 'logs', 'delivery'), { recursive: true });
    const file = path.join(storage, 'logs', 'diagnostics', 'power-notify.log');
    await writeFile(file, 'x'.repeat(5 * 1024 * 1024));
    const oldFd = openSync(file, 'a');
    try {
      await loggingChild(`
        import { installServiceLog } from ${JSON.stringify(serviceModule)};
        const close = installServiceLog(${JSON.stringify(storage)}, 'power-notify.log');
        process.stdout.write('after-rotation-out\\n'); process.stderr.write('after-rotation-err\\n');
        await new Promise(resolve => process.stdout.write('callback-drained\\n', resolve));
        const bytes = Buffer.from('汉'); process.stdout.write(bytes.subarray(0, 1)); process.stdout.write(bytes.subarray(1));
        await close();
      `, ['ignore', oldFd, oldFd]);
      expect(fstatSync(oldFd).ino).toBe(statSync(`${file}.1`).ino);
      expect(fstatSync(oldFd).size).toBe(5 * 1024 * 1024);
      expect(readFileSync(file, 'utf8')).toBe('after-rotation-out\nafter-rotation-err\ncallback-drained\n汉');
      expect(statSync(file).ino).not.toBe(fstatSync(oldFd).ino);
    } finally { closeSync(oldFd); await rm(root, { recursive: true, force: true }); }
  }, 15_000);
});

const deliveryModule = pathToFileURL(path.resolve('dist/herdr/launcher/delivery.js')).href;
const maxLogBytes = 5 * 1024 * 1024;

async function rotateWithAnotherProcess(file: string, generations: number): Promise<void> {
  await loggingChild(String.raw`
    import { ManagedLog } from ${JSON.stringify(loggingModule)};
    const sink = new ManagedLog(${JSON.stringify(file)}, { generations: ${generations} });
    sink.write('other-writer-rotation\n'); await sink.flush();
  `);
}

describe('inherited diagnostic descriptors before sink installation', () => {
  it.each([1, 2])('protects service stdout/stderr already pointing at generation %i, including degradation', async generation => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tut-log-prerotated-service-'));
    const storage = path.join(root, '.context-hub');
    const { mkdir } = await import('node:fs/promises'); await mkdir(path.join(storage, 'logs', 'diagnostics'), { recursive: true }); await mkdir(path.join(storage, 'logs', 'delivery'), { recursive: true });
    const file = path.join(storage, 'logs', 'diagnostics', 'power-notify.log');
    await writeFile(file, 'x'.repeat(maxLogBytes));
    const oldFd = openSync(file, 'a');
    try {
      await rotateWithAnotherProcess(file, 2);
      if (generation === 2) {
        // Seed the next fixture segment after the other writer has exited.
        await writeFile(file, 'y'.repeat(maxLogBytes)); await rotateWithAnotherProcess(file, 2);
      }
      const old = `${file}.${generation}`;
      expect(fstatSync(oldFd).ino).toBe(statSync(old).ino);
      await loggingChild(String.raw`
        import { installServiceLog } from ${JSON.stringify(serviceModule)};
        const close = installServiceLog(${JSON.stringify(storage)}, 'power-notify.log');
        await new Promise(resolve => process.stdout.write('managed-out\n', resolve));
        await new Promise(resolve => process.stderr.write('managed-err\n', resolve));
        await close();
      `, ['ignore', oldFd, oldFd]);
      expect(readFileSync(file, 'utf8')).toBe('other-writer-rotation\nmanaged-out\nmanaged-err\n');
      expect(readFileSync(old, 'utf8')).toBe('x'.repeat(maxLogBytes));
      const health = path.join(root, 'health.json');
      await loggingChild(String.raw`
        import { installServiceLog, serviceLogHealth, flushServiceLogs } from ${JSON.stringify(serviceModule)};
        import { logFs } from ${JSON.stringify(loggingModule)};
        import { writeFileSync } from 'node:fs';
        let appends = 0;
        logFs.append = async () => { appends++; throw new Error('EACCES injected'); };
        const close = installServiceLog(${JSON.stringify(storage)}, 'power-notify.log');
        process.stdout.write('failed-out\n'); process.stderr.write('failed-err\n');
        await flushServiceLogs();
        for (let i=0; i<10; i++) { process.stdout.write('discarded-out\n'); process.stderr.write('discarded-err\n'); }
        await flushServiceLogs();
        writeFileSync(${JSON.stringify(health)}, JSON.stringify({ appends, health: serviceLogHealth() }));
        await close();
      `, ['ignore', oldFd, oldFd]);
      const state = JSON.parse(await readFile(health, 'utf8'));
      expect(state.appends).toBe(1); expect(state.health.disabled).toBe(true);
      expect(state.health.diagnostic).toContain('EACCES injected');
      expect(readFileSync(old, 'utf8')).toBe('x'.repeat(maxLogBytes));
      expect(readFileSync(file, 'utf8')).toBe('other-writer-rotation\nmanaged-out\nmanaged-err\n');
      for (const segment of (await readdir(path.dirname(file))).filter(s => /^power-notify\.log(?:\.[12])?$/.test(s))) {
        expect(statSync(path.join(path.dirname(file), segment)).size).toBeLessThanOrEqual(maxLogBytes);
      }
    } finally { closeSync(oldFd); await rm(root, { recursive: true, force: true }); }
  }, 15_000);

  it.each([['active', false], ['old', false], ['active', true], ['old', true]] as const)(
    'delivery stderr at %s with persistent failure=%s never bypasses the managed writer', async (position, fail) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'tut-log-delivery-fd-'));
      const storage = path.join(root, '.context-hub');
      const { mkdir } = await import('node:fs/promises'); await mkdir(path.join(storage, 'logs', 'diagnostics'), { recursive: true }); await mkdir(path.join(storage, 'logs', 'delivery'), { recursive: true });
      const file = path.join(storage, 'logs', 'delivery', 'delivery.log');
      await writeFile(file, 'x'.repeat(maxLogBytes));
      const oldFd = openSync(file, 'a');
      try {
        if (position === 'old') await rotateWithAnotherProcess(file, 1);
        const evidence = path.join(root, 'result.json');
        await loggingChild(String.raw`
          import { createDeliveryDiagnostics } from ${JSON.stringify(deliveryModule)};
          import { logFs } from ${JSON.stringify(loggingModule)};
          import { statSync, writeFileSync } from 'node:fs';
          const original = process.stderr.write.bind(process.stderr);
          let stderrWrites = 0, appends = 0;
          process.stderr.write = (...args) => { stderrWrites++; return original(...args); };
          const sink = createDeliveryDiagnostics({ env: { TUT_PROJECT_ROOT: ${JSON.stringify(root)} },
            ...(${fail} ? { fs: { ...logFs, isDirectory: dir => statSync(dir).isDirectory(),
              append: async () => { appends++; throw new Error('EACCES injected'); } } } : {}) });
          for (let i=0; i<4; i++) { sink.emit('event-'+i); await sink.flush(); }
          writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ stderrWrites, appends }));
        `, ['ignore', 'ignore', oldFd]);
        expect(fstatSync(oldFd).size).toBe(maxLogBytes);
        expect(readFileSync(`${file}.1`, 'utf8')).toBe('x'.repeat(maxLogBytes));
        const result = JSON.parse(await readFile(evidence, 'utf8'));
        expect(result.stderrWrites).toBe(0);
        if (fail) expect(result.appends).toBe(1);
        else {
          const active = await readFile(file, 'utf8');
          for (let i=0; i<4; i++) expect(active.match(new RegExp(`event-${i}\\n`, 'g'))).toHaveLength(1);
        }
        const segments = (await readdir(path.dirname(file))).filter(s => /^delivery\.log(?:\.1)?$/.test(s));
        expect(segments.length).toBeGreaterThan(0);
        for (const segment of segments) {
          expect(statSync(path.join(path.dirname(file), segment)).size).toBeLessThanOrEqual(maxLogBytes);
        }
      } finally { closeSync(oldFd); await rm(root, { recursive: true, force: true }); }
    }, 15_000,
  );
});

it('delivery initialization has a real drain deadline and later flushes return immediately', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tut-log-initialization-deadline-'));
  try {
    const result = path.join(root, 'result.json');
    await loggingChild(String.raw`
      import { createDeliveryDiagnostics } from ${JSON.stringify(deliveryModule)};
      import { writeFileSync } from 'node:fs';
      let mkdirCalls = 0; const diagnostics = [];
      const sink = createDeliveryDiagnostics({ env: { TUT_PROJECT_ROOT: ${JSON.stringify(root)} },
        stderr: line => diagnostics.push(line), fs: { isDirectory: () => true,
          mkdir: async () => { mkdirCalls++; await new Promise(() => {}); },
          size: async () => -1, rename: async () => {}, append: async () => { throw Error('unexpected append'); } } });
      const start = performance.now(); sink.emit('first'); await sink.flush();
      const elapsed = performance.now() - start;
      const next = performance.now();
      for (let i=0; i<10; i++) { sink.emit('later'); await sink.flush(); }
      writeFileSync(${JSON.stringify(result)}, JSON.stringify({ elapsed, later: performance.now()-next,
        mkdirCalls, degraded: diagnostics.filter(line => line.includes('log degraded')).length }));
    `);
    const state = JSON.parse(await readFile(result, 'utf8'));
    expect(state.elapsed).toBeGreaterThanOrEqual(900); expect(state.elapsed).toBeLessThan(2500);
    expect(state.later).toBeLessThan(500); expect(state.mkdirCalls).toBe(1); expect(state.degraded).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10_000);

it.each(['service', 'delivery'])('partitioned %s sink preserves a legacy inherited descriptor and unknown siblings', async kind => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tut-log-legacy-fd-'));
  const storage = path.join(root, '.context-hub');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(storage);
  const name = kind === 'service' ? 'power-notify.log' : 'delivery.log';
  const legacy = path.join(storage, name);
  await writeFile(legacy, 'legacy bytes');
  const unknown = path.join(storage, 'logs', kind === 'service' ? 'diagnostics' : 'delivery', 'unknown');
  await mkdir(path.dirname(unknown), { recursive: true });
  await writeFile(unknown, 'protected');
  const fd = openSync(legacy, 'a');
  try {
    await loggingChild(kind === 'service' ? String.raw`
      import { installServiceLog } from ${JSON.stringify(serviceModule)};
      const close = installServiceLog(${JSON.stringify(storage)}, 'power-notify.log');
      process.stderr.write('new bytes\n'); await close();
    ` : String.raw`
      import { createDeliveryDiagnostics } from ${JSON.stringify(deliveryModule)};
      const sink = createDeliveryDiagnostics({ env: { TUT_PROJECT_ROOT: ${JSON.stringify(root)} } });
      sink.emit('new bytes'); await sink.flush();
    `, ['ignore', 'ignore', fd]);
    expect(readFileSync(legacy, 'utf8')).toBe('legacy bytes');
    expect(readFileSync(path.join(path.dirname(unknown), name), 'utf8')).toContain('new bytes');
    expect(readFileSync(unknown, 'utf8')).toBe('protected');
  } finally { closeSync(fd); await rm(root, { recursive: true, force: true }); }
}, 15000);
