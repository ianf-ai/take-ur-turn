/** Internal delivery confirmation v2 contract. Transport success never proves input consumption. */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export type TransportFault = 'INVALID_ARGUMENT' | 'NOT_STARTED' | 'SPAWN_FAILED'
  | 'EXIT_ERROR' | 'SIGNAL' | 'TIMEOUT' | 'ABORTED' | 'INVALID_ACK' | 'INTERNAL';
export type ReadFault = TransportFault | 'INVALID_JSON' | 'INVALID_SHAPE'
  | 'PANE_MISSING' | 'PANE_DUPLICATE' | 'IDENTITY_CHANGED'
  | 'STATUS_MISSING' | 'STATUS_INVALID' | 'LATE_RESULT' | 'WRONG_SEQUENCE';
export type GiveUpReason = 'text-uncertain' | 'enter-not-sent' | 'enter-uncertain'
  | 'identity-invalid' | 'baseline-working' | 'baseline-unknown'
  | 'attribution-unavailable' | 'status-unavailable' | 'deadline' | 'cancelled';
export interface PaneIdentity {
  paneId: string;
  terminalId: string | null;
  workspaceId: string | null;
  agentSession: {agent: string; kind: string; value: string} | null;
  serverEpoch: null;    // 当前接口无可用 server 世代证明
  agentGeneration: null; // session/terminal 不冒充 agent 进程世代
}
export interface CallContext {
  attemptId: string;    // 本地关联键，不进 prompt、不作因果证明
  sequence: number;     // 本 attempt 的串行控制调用序号，从 1 递增
  deadlineMonoMs: number;
  signal: AbortSignal;
}
export interface CallTrace {
  attemptId: string;
  sequence: number;
  startedMonoMs: number;
  finishedMonoMs: number;
  spawned: boolean;
  exitCode: number | null;
  signal: string | null;
  fault: TransportFault | null;
}
export type SendResult =
  | {kind: 'sent'; trace: CallTrace}
  | {kind: 'not-sent'; trace: CallTrace}
  | {kind: 'uncertain'; trace: CallTrace};
export interface StatusSample {
  attemptId: string;
  sequence: number;
  startedMonoMs: number;
  finishedMonoMs: number;
  status: AgentStatus;
  identity: PaneIdentity | null;
  paneRevision: number | null;
  error: ReadFault | null;
  readSource: 'herdr-pane-list';
  detectorSource: null;
  detectorAgeMs: null;
  attribution: 'unavailable';
}
export interface DeliveryClientV2 {
  sendText(target: PaneIdentity, text: string, call: CallContext): Promise<SendResult>;
  sendEnter(target: PaneIdentity, call: CallContext): Promise<SendResult>;
  readAgentStatus(target: PaneIdentity, call: CallContext): Promise<StatusSample>;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Capture available identity; source is session provenance, not detector provenance. */
export function paneIdentityFrom(row: Record<string, unknown>): PaneIdentity {
  const session = row.agent_session;
  return {
    paneId: typeof row.pane_id === 'string' ? row.pane_id : '',
    terminalId: nullableString(row.terminal_id),
    workspaceId: nullableString(row.workspace_id),
    agentSession: object(session) && nullableString(session.agent) && nullableString(session.kind) && nullableString(session.value)
      ? { agent: session.agent as string, kind: session.kind as string, value: session.value as string } : null,
    serverEpoch: null, agentGeneration: null,
  };
}

/** Known 0.8.2 success envelope plus the legacy empty/plain `ok` ACK. */
export function validDeliveryAck(stdout: string): boolean {
  const text = stdout.trim();
  if (text === '' || text === 'ok') return true;
  try {
    const value: unknown = JSON.parse(text);
    if (!object(value) || 'error' in value || value.ok === false || value.success === false || (value.type !== undefined && value.type !== 'ok')) return false;
    if ('result' in value && !object(value.result)) return false;
    const result = object(value.result) ? value.result : value;
    return result.type === 'ok' && !('error' in result) && result.ok !== false && result.success !== false;
  } catch { return false; }
}

export function parseStatusSample(
  stdout: string, target: PaneIdentity, sample: StatusSample, previousRevision?: number,
): StatusSample {
  const fail = (error: ReadFault): StatusSample => ({ ...sample, status: 'unknown', error });
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return fail('INVALID_JSON'); }
  if (object(value) && ('error' in value || value.ok === false || value.success === false)) return fail('INVALID_SHAPE');
  const result = object(value) && object(value.result) ? value.result : value;
  if (object(result) && ('error' in result || result.ok === false || result.success === false)) return fail('INVALID_SHAPE');
  const rows = Array.isArray(result) ? result : object(result) ? result.panes : undefined;
  if (!Array.isArray(rows)) return fail('INVALID_SHAPE');
  // Count raw exact matches before any tolerant conversion could drop a bad row.
  const matches = rows.filter(row => object(row) && row.pane_id === target.paneId);
  if (matches.length === 0) return fail('PANE_MISSING');
  if (matches.length !== 1) return fail('PANE_DUPLICATE');
  const row = matches[0] as Record<string, unknown>;
  const identity = paneIdentityFrom(row);
  const revision = row.revision;
  sample = { ...sample, identity, paneRevision: typeof revision === 'number' ? revision : null };
  if ((target.terminalId !== null && target.terminalId !== identity.terminalId)
    || (target.workspaceId !== null && target.workspaceId !== identity.workspaceId)
    || (target.agentSession !== null && (identity.agentSession === null
      || target.agentSession.agent !== identity.agentSession.agent
      || target.agentSession.kind !== identity.agentSession.kind
      || target.agentSession.value !== identity.agentSession.value))
    || (typeof revision === 'number' && previousRevision !== undefined && revision < previousRevision)) {
    return fail('IDENTITY_CHANGED');
  }
  if (revision != null && (!Number.isSafeInteger(revision) || (revision as number) < 0)) return fail('INVALID_SHAPE');
  if (['terminal_id', 'workspace_id'].some(key => row[key] != null
    && (typeof row[key] !== 'string' || row[key] === ''))) return fail('INVALID_SHAPE');
  if (row.agent_session != null && (!object(row.agent_session)
    || !['agent', 'kind', 'value'].every(key => nullableString((row.agent_session as Record<string, unknown>)[key])))) return fail('INVALID_SHAPE');
  if (row.agent_status == null) return fail('STATUS_MISSING');
  if (!['idle', 'working', 'blocked', 'done', 'unknown'].includes(row.agent_status as string)) return fail('STATUS_INVALID');
  return { ...sample, status: row.agent_status as AgentStatus, error: null };
}
