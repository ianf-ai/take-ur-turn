import {posix as path} from 'node:path';
import {nativeReadPort} from '../../ports.js';
/** pi encodes a cwd as `--<cwd with [\\/:] as '-'>--` under the session base
 *  (pi resolves the cwd first — realpath when it exists, resolve otherwise). */
export function piSessionDirFor(cwd: string, base: string, realpath=(file:string)=>nativeReadPort().realpath(file)): string {
  let resolved: string;
  try { resolved = realpath(path.resolve(cwd)); } catch { resolved = path.resolve(cwd); }
  const safe = `--${resolved.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`;
  return path.join(base, safe);
}

export interface PiSessionHead { id: string; cwd?: string }

/** Read the FIRST line of one session file: the session header carries id and
 *  cwd. Only the head is read (bounded); no session bodies, no other projects. */
export function readPiSessionHead(file: string, head=(file:string)=>nativeReadPort().head(file)): PiSessionHead | undefined {
  try {
    const text=head(file);if(text===undefined)return undefined;
    const newline=text.indexOf('\n');
    const parsed:unknown=JSON.parse(newline===-1?text:text.slice(0,newline));
    if(parsed&&typeof parsed==='object'&&(parsed as {type?:unknown}).type==='session'){
      const {id,cwd}=parsed as {id?:unknown;cwd?:unknown};
      if(typeof id==='string')return {id,...(typeof cwd==='string'?{cwd}:{})};
    }
  }catch{/* Unreadable/malformed headers are not identity evidence. */}
  return undefined;
}

/** Verify an exact pi session exists for THIS project cwd. A missing or
 *  cross-project id is a refusal — never a fresh-session fallback. */
export function verifyPiSession(base: string, cwd: string, sessionId: string, io:Pick<import('../../ports.js').NativeReadPort,'entries'|'head'|'realpath'>=nativeReadPort()): { ok: true; file: string } | { ok: false; reason: string } {
  const dir = piSessionDirFor(cwd, base,io.realpath);
  let entries: string[];
  try {
    entries = io.entries(dir).filter(name => name.endsWith('.jsonl'));
  } catch {
    return { ok: false, reason: `no pi session store for this project (${dir}) — cannot confirm session ${sessionId}` };
  }
  const matches:string[]=[];
  for (const name of entries) {
    const file = path.join(dir, name);
    const head = readPiSessionHead(file,io.head);
    if (head?.id === sessionId) {
      if (head.cwd !== undefined && path.resolve(head.cwd) !== path.resolve(cwd)) {
        return { ok: false, reason: `session ${sessionId} belongs to another project (cwd ${head.cwd})` };
      }
      matches.push(file);
    }
  }
  if(matches.length===1)return {ok:true,file:matches[0]!};
  if(matches.length>1)return {ok:false,reason:`pi session ${sessionId} is ambiguous in ${dir}`};
  return { ok: false, reason: `pi session ${sessionId} not found in ${dir} (pi --session-id would CREATE a new session — refusing)` };
}
