import { rigLabel } from "../src/hub/rig.js";

/** Upgrade older behavior fixtures to the rig addressing convention. */
export function scopedFixture(text: string, root: string): string {
  return text.replace(/\b(?:tut-hub|tut-notify|[a-z0-9-]+\.(?:architect|executor|reviewer))(?![a-z0-9-])/g, label => rigLabel(label, root));
}

/** Exact expected POSIX agent command with the mandatory rig environment. */
export function agentFixture(text: string, root: string, hub = "http://127.0.0.1:1"): string {
  const assignments = `'TUT_HUB_ROOT=${root}' 'TUT_HUB_URL=${hub}' 'TUT_EVENT_PORT_URL=http://127.0.0.1:1/agent-event' `;
  return text.replace(/(&& )(env 'PI_SKIP_VERSION_CHECK=1' )?/, (_, prefix, pi) => `${prefix}${pi ?? "env "}${assignments}`);
}
