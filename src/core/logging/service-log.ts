/** logs/diagnostics/{power-hub,power-notify,usage-audit}.log: service sinks
 * write, operators read. ManagedLog owns 5 MiB segments, two generations and
 * seven-day old-segment retirement; other names are never cleanup candidates. */
/** Install only in a service entry process, never in Hub library code. */
import path from 'node:path';
import { managedLogFdGuard } from './output-guard.js';
import { StringDecoder } from 'node:string_decoder';
import { ManagedLog } from './managed-log.js';

let active: ManagedLog | undefined;
export function serviceLogHealth(): ManagedLog['health'] | undefined { return active?.health; }
export async function flushServiceLogs(): Promise<void> { await active?.flush(); }
/** Routine service telemetry belongs in the managed file, without terminal mirroring. */
export function writeServiceLog(text: string): void { active?.write(text); }

export function installServiceLog(directory: string, name: 'power-hub.log' | 'power-notify.log' | 'usage-audit.log', { mirror = true }: { mirror?: boolean } = {}): () => Promise<void> {
  const stderr = process.stderr.write.bind(process.stderr);
  const target = path.join(directory, 'logs', 'diagnostics', name);
  const targets = () => [{ file: target, generations: 2 }, { file: path.join(directory, name), generations: 2 }];
  const blocked = [managedLogFdGuard(1, targets), managedLogFdGuard(2, targets)];
  // Detect inherited old generations before another writer can retire them.
  for (const guard of blocked) guard();
  const sink = new ManagedLog(target, { diagnostic: line => { if (mirror && !blocked[1]!()) stderr(line); } });
  active = sink;
  const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
  const originals = [process.stdout.write, process.stderr.write] as const;
  for (const [index, stream] of [process.stdout, process.stderr].entries()) {
    const original = originals[index]!;
    stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
      const text = decoders[index]!.write(typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : Buffer.from(chunk));
      sink.write(text);
      // Managed daemons use the diagnostic file as their output channel.
      // Direct foreground invocations keep their interactive stream too.
      const done = typeof encoding === 'function' ? encoding : callback;
      if (!mirror) {
        // File-only callbacks acknowledge the bounded drain, so a caller may
        // terminate after its final diagnostic without racing queued writes.
        if (done) void sink.flush().then(() => done());
        return true;
      }
      if (blocked[index]!()) {
        if (done) process.nextTick(done);
        return true;
      }
      // Preserve callback timing: the watcher's terminal timeout signal must
      // not wait behind the very libuv pool whose exhaustion it diagnoses.
      return original.call(stream, chunk, typeof encoding === 'string' ? encoding : undefined, done);
    }) as typeof stream.write;
  }
  const end = (): void => { for (const decoder of decoders) sink.write(decoder.end()); };
  const drain = (): void => { end(); void sink.flush(); };
  // Node's default uncaught-exception reporter bypasses stream.write. A
  // managed service must record the stack before terminating, never resume
  // service work after the failure. flush has the same one-second deadline.
  const crash = (error: Error, origin: string): void => {
    process.exitCode = 1;
    end();
    sink.write(`${origin}: ${error?.stack ?? String(error)}\n`);
    void sink.flush().finally(() => process.exit(1));
  };
  if (!mirror) process.once('uncaughtException', crash);
  process.on('beforeExit', drain);
  return async () => { end(); await sink.flush(); process.off('beforeExit', drain); process.off('uncaughtException', crash); process.stdout.write = originals[0]; process.stderr.write = originals[1]; if (active === sink) active = undefined; };
}
