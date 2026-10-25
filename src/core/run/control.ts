/** Single platform selection. Windows modules are not loaded on POSIX. */
import * as posix from './control-posix.js';
const implementation = process.platform === 'win32' ? await import('./control-windows.js') : posix;
export const { startRun, stopRun, listRuns, attachRun } = implementation;
export { requirePosix, StartRunError } from './control-posix.js';
export { requireRunPlatform } from './control-contract.js';
export type { StartOptions, StopOptions, StopResult } from './control-contract.js';
