// A legacy owner keeps using the original mutex addresses for its whole lifetime.
// The optional module runs the same fixture against an archived compiled binary.
import fs from 'node:fs';
import path from 'node:path';
const [moduleUrl, root, id, role, operation, releaseFile] = process.argv.slice(2);
const { RunStore } = await import(moduleUrl);
const report = value => fs.writeSync(1, JSON.stringify(value) + '\n');
const LegacyStore = process.env.TUT_TEST_LEGACY_STORE_MODULE
  ? (await import(process.env.TUT_TEST_LEGACY_STORE_MODULE)).RunStore
  : class extends RunStore {
    lock(id, name, waitMs = 2000) {
      return this.lockFile(path.join(this.directory(id), `${name}.lock`), waitMs, 'legacy lock busy');
    }
    lockAdmission(waitMs = 5000) {
      return this.lockFile(path.join(this.root, 'admission.lock'), waitMs, 'legacy admission busy');
    }
  };
const CurrentStore = class extends RunStore {
  lock(id, name, waitMs = 150) { return super.lock(id, name, waitMs); }
};
const store = role === 'legacy' ? new LegacyStore(root) : new CurrentStore(root);
function hold() {
  const deadline = performance.now() + 10000;
  while (!fs.existsSync(releaseFile)) {
    if (performance.now() >= deadline) throw new Error('legacy owner release timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
try {
  report({ kind: 'attempt' });
  if (operation === 'update') {
    await store.updateMeta(id, meta => {
      report({ kind: 'snapshot' });
      if (role === 'legacy') hold();
      return role === 'legacy' ? { ...meta, legacy_done: true } : { ...meta, agent_session_id: 'new-session-retained' };
    });
  } else {
    const release = operation === 'admission' ? await store.lockAdmission(150) : await store.lock(id, operation, 150);
    try { report({ kind: 'locked' }); if (role === 'legacy') hold(); }
    finally { release(); }
  }
  report({ kind: 'done' });
} catch (error) { report({ kind: 'error', message: error.message }); process.exitCode = 1; }
