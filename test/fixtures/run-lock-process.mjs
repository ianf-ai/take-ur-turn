/** Test-only scheduler seam: pause an actual RunStore owner between O_EXCL
 * creation and owner write, or report exactly what its competitor observes. */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const [moduleUrl, root, id, role, mode] = process.argv.slice(2);
const report = value => fs.writeSync(1, `${JSON.stringify(value)}\n`);
if (role === 'owner') {
  const original = fs.openSync;
  fs.openSync = function(file, flags, ...rest) {
    const fd = original.call(this, file, flags, ...rest);
    if (String(file).endsWith('/meta.lock') && (flags & fs.constants.O_EXCL)) {
      // Positional write leaves the descriptor offset at zero, so the real
      // owner publication overwrites this prefix after SIGCONT.
      if (mode === 'partial') fs.writeSync(fd, '{"pid":', 0, 'utf8');
      report({ kind: 'window' });
      process.kill(process.pid, 'SIGSTOP');
    }
    return fd;
  };
} else {
  const original = fs.readFileSync; let reported = false;
  fs.readFileSync = function(file, ...rest) {
    const value = original.call(this, file, ...rest);
    if (!reported && String(file).endsWith('/meta.lock')) {
      reported = true; report({ kind: 'observed', raw: value.toString() });
    }
    return value;
  };
}
syncBuiltinESMExports();
const { RunStore } = await import(moduleUrl);
try {
  await new RunStore(root).updateMeta(id, m => ({ ...m, [role === 'owner' ? 'owner_done' : 'contender_done']: true }));
  report({ kind: 'done' });
} catch (error) {
  report({ kind: 'error', message: error.message }); process.exitCode = 1;
}
