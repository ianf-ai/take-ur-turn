/** Observe the real supervisor's lock read, without altering its result or
 * writing any run protocol files. Only loaded by the lock regression test. */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
if (['--supervise', '--supervise-windows'].includes(process.argv[2]) && process.env.RUN_LOCK_OBSERVED) {
  const original = fs.readFileSync; let reported = false;
  fs.readFileSync = function(file, ...rest) {
    const value = original.call(this, file, ...rest);
    if (!reported && /[/\\]meta\.lock$/.test(String(file)) && value.toString() === '') {
      reported = true; fs.writeFileSync(process.env.RUN_LOCK_OBSERVED, 'observed-empty-owner');
    }
    return value;
  };
  syncBuiltinESMExports();
}
