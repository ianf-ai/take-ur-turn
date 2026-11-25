/** Stateless delegation to the existing lane and its sole archive barrier. */
import type { InteractiveLanePort, NotifierConfigurationFacts } from '../../core/notifier/shared-contracts.js';
import type { TuiLanePort } from './contracts.js';

/** Both poll intake and the in-action fresh-state check use the original policy. */
export function remediationModeOf(facts: NotifierConfigurationFacts) {
  return facts.auto?.remediate ?? (facts.flow_mode === 'auto' ? 'enter-repress' : 'off');
}

export function createInteractiveLanePort(lane: TuiLanePort): InteractiveLanePort {
  return {
    refreshBindings: () => lane.refreshRouting(),
    acceptConfiguration: facts => lane.setRemediationMode(remediationModeOf(facts)),
    reconcileObservers: tasks => lane.retireObsoleteWorkingWatches(tasks),
    reportStatusEdge: (task, status, notify) => lane.reportHostStatus(task, status, notify),
    cleanupTaskResources: taskId => lane.cleanupClosedTask(taskId),
    awaitTaskArchive: taskId => lane.awaitSweepBarrier(taskId),
    launch: (task, role, baseVersion, wake) => lane.launch(task, role, baseVersion, wake),
  };
}
