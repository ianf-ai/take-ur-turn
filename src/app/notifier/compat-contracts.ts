/** Legacy flat injection and context shapes; type composition only. */
import type { SharedNotifierDeps } from '../../core/notifier/shared-contracts.js';
import type { HerdrNotifierDeps, HerdrLaneContext } from '../../herdr/notifier/contracts.js';
import type { StandaloneNotifierDeps, StandaloneLaneContext } from '../../standalone/notifier/contracts.js';

export interface LegacyNotifierDeps<Runtime = unknown, Remediation = unknown, Diagnostics = unknown>
  extends SharedNotifierDeps, HerdrNotifierDeps<Remediation, Diagnostics>, StandaloneNotifierDeps<Runtime> {}

export interface LaneContext extends HerdrLaneContext, StandaloneLaneContext {}
