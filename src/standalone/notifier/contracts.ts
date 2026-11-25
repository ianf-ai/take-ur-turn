/** Standalone-owned runtime injection and engine callbacks. */
import type { LaunchCatchup } from '../../core/common/config.js';
import type { NotifierLaneContext } from '../../core/notifier/shared-contracts.js';

export interface StandaloneNotifierDeps<Runtime = unknown> {
  /**
   * Strict startup-catchup switch reader (config key launch.catchup,
   * default "off"). Injectable for tests; a throw is logged as ONE visible
   * line and withholds the catchup pass (fail-visible, never a crash).
   */
  readLaunchCatchup?(configRoot: string): Promise<LaunchCatchup>;
  /** Task description reader for anchored checkout (defaults to context.read). */
  readTaskDescription?(taskId: string): Promise<string | undefined>;
  headlessRuntime?: Runtime;
}

export interface StandaloneLaneContext extends Pick<NotifierLaneContext,
  'log' | 'fullLog' | 'autoLaunchFailed' | 'autoLaunchSkipped' | 'autoGateReason' | 'autoLaunch'> {
  awaitSweepBarrier(taskId: string): Promise<void>;
}
