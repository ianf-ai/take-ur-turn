/** Public shape is shared; the POSIX implementation remains byte-for-byte frozen. */
export type { StartOptions, StopOptions, StopResult } from './control-posix.js';
export { StartRunError } from './control-posix.js';
export function requireRunPlatform(platform = process.platform): void {
    if (!['darwin', 'linux', 'win32'].includes(platform))
        throw new Error('run/stop require macOS, Linux or Windows');
}
