import {validateNativeLaunch} from '../../agents/public/index.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { HeadlessOwnership } from './store.js';
import { type WindowsPiSession, verifyWindowsPiContinuation } from '../../agents/public/native-compat.js';
import type { ResolvedAgentTarget } from '../launcher/target/types.js';

export interface DetachedWindowsTarget extends ResolvedAgentTarget {
  agent: string;
  version?: string;
}

/** Additive association carried through the existing ownership envelope.
 *  The run controller persists it unchanged; it grants no process authority. */
export interface WindowsLaunch {
  schema: 1;
  target: DetachedWindowsTarget;
  logical_argv: string[];
  pi_session?: WindowsPiSession;
}
export type WindowsOwnership = HeadlessOwnership & { windows?: WindowsLaunch };

export {physicalWindowsArgv} from '../../agents/public/native-compat.js';
export function windowsLaunchDigest(hubRoot: string, cwd: string, argv: readonly string[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({ hubRoot, checkoutRoot: cwd, argv })).digest('hex')}`;
}
export function readWindowsLaunch(ownership: HeadlessOwnership): WindowsLaunch {
  const data = (ownership as WindowsOwnership).windows;
  if (!data || data.schema !== 1 || !data.target || typeof data.target.agent !== 'string' || !data.target.agent || data.target.agent.includes('\0') ||
      !path.win32.isAbsolute(data.target.executable) || !Array.isArray(data.target.prefix_args) ||
      !data.target.prefix_args.every(a => typeof a === 'string' && !a.includes('\0')) ||
      !Array.isArray(data.logical_argv) || !data.logical_argv.every(a => typeof a === 'string' && !a.includes('\0'))) {
    throw new Error('Windows run lacks a valid frozen logical/physical launch identity');
  }
  validateNativeLaunch(data.target,data.pi_session,ownership.designated_session_id);
  return structuredClone(data);
}
export function verifyWindowsContinuation(ownership: HeadlessOwnership, cwd: string): void {
  const frozen = readWindowsLaunch(ownership);
  if (frozen.pi_session)verifyWindowsPiContinuation(frozen.pi_session,frozen.pi_session.session_id,cwd);
}
