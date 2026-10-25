/** The control-plane owner supplies the selected platform capability.
 *  Older installations remain usable on POSIX; Windows refuses before a
 *  launch marker until the Windows controller has actually been integrated. */
import * as control from '../../core/run/control.js';

export function requireHeadlessPlatform(platform = process.platform): void {
  const selected = control as typeof control & { requireRunPlatform?: (platform?: NodeJS.Platform) => void };
  if ('requireRunPlatform' in control && selected.requireRunPlatform) return selected.requireRunPlatform(platform);
  if (platform === 'win32') throw new Error('Windows run control is not installed: integrate the requireRunPlatform control-plane implementation before detached launch');
  control.requirePosix(platform);
}
