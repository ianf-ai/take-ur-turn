import { createHash } from 'node:crypto';
import path from 'node:path';
import type { HeadlessOwnership } from '../../core/run/store.js';
import { type WindowsPiSession, verifyWindowsPiSession } from '../../core/run/windows-pi-session.js';
import type { DetachedWindowsTarget } from './windows-target.js';

/** Additive association carried through the existing ownership envelope.
 *  The run controller persists it unchanged; it grants no process authority. */
export interface WindowsLaunch {
  schema: 1;
  target: DetachedWindowsTarget;
  logical_argv: string[];
  pi_session?: WindowsPiSession;
}
export type WindowsOwnership = HeadlessOwnership & { windows?: WindowsLaunch };

export function physicalWindowsArgv(target: DetachedWindowsTarget, logical: readonly string[], session?: WindowsPiSession): string[] {
  const args = logical.slice(1);
  if (session) {
    // Insert before the explicit prompt separator. Storage is fixed even if
    // environment/settings change after planning or between same-role rounds.
    const separator = args.lastIndexOf('--');
    if (separator < 0) throw new Error('pi argv has no prompt separator');
    args.splice(separator, 0, '--session-dir', session.session_directory);
  }
  return [target.executable, ...target.prefix_args, ...args];
}
export function windowsLaunchDigest(hubRoot: string, cwd: string, argv: readonly string[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({ hubRoot, checkoutRoot: cwd, argv })).digest('hex')}`;
}
export function readWindowsLaunch(ownership: HeadlessOwnership): WindowsLaunch {
  const data = (ownership as WindowsOwnership).windows;
  if (!data || data.schema !== 1 || !data.target || !['pi', 'codex'].includes(data.target.agent) ||
      !path.win32.isAbsolute(data.target.executable) || !Array.isArray(data.target.prefix_args) ||
      !data.target.prefix_args.every(a => typeof a === 'string' && !a.includes('\0')) ||
      !Array.isArray(data.logical_argv) || !data.logical_argv.every(a => typeof a === 'string' && !a.includes('\0'))) {
    throw new Error('Windows run lacks a valid frozen logical/physical launch identity');
  }
  if (data.target.agent === 'pi') {
    const s = data.pi_session;
    if (!s || !['flat','cwd-encoded'].includes(s.storage_layout) || !path.win32.isAbsolute(s.session_directory) ||
        !path.win32.isAbsolute(s.launch_cwd) || s.session_id !== ownership.designated_session_id) throw new Error('Windows pi run lacks a frozen session location/identity');
  }
  return structuredClone(data);
}
export function verifyWindowsContinuation(ownership: HeadlessOwnership, cwd: string): void {
  const frozen = readWindowsLaunch(ownership);
  if (frozen.pi_session) {
    if (frozen.pi_session.launch_cwd !== path.win32.resolve(cwd)) throw new Error('Windows pi launch cwd changed');
    const verified = verifyWindowsPiSession(frozen.pi_session, frozen.pi_session.session_id);
    if (frozen.pi_session.session_file !== undefined && verified.session_file !== frozen.pi_session.session_file) throw new Error('Windows pi session file changed since planning');
  }
}
