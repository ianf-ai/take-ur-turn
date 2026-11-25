/** Keep inherited regular-file output out of managed active and old segments.
 * Once identified, a descriptor stays blocked even after its inode is retired. */
import { fstatSync, statSync } from 'node:fs';

export function managedLogFdGuard(fd: number, targets: () => readonly { file: string; generations: number }[]): () => boolean {
  let blocked = false;
  return () => {
    if (blocked) return true;
    let output;
    try { output = fstatSync(fd); } catch { return true; }
    // Terminals, pipes and /dev/null remain independent health channels.
    if (!output.isFile()) return false;
    for (const { file, generations } of targets()) {
      for (let generation = 0; generation <= generations; generation++) {
        try {
          const segment = statSync(generation === 0 ? file : `${file}.${generation}`);
          if (output.dev === segment.dev && output.ino === segment.ino) { blocked = true; return true; }
        } catch (error) {
          // A missing segment is normal during rotation. If ownership cannot
          // be inspected, don't risk appending through an already-open file.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { blocked = true; return true; }
        }
      }
    }
    return false;
  };
}
