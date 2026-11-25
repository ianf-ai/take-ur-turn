/** AgentProfile v2: data-only native CLI contracts. */
export type Platform = 'posix' | 'win32';
export type Mode = 'run' | 'resume';
export type PathRef = (string | number)[];
export type HookId = 'pi-store-v1' | 'pi-windows-location-v1' | 'opencode-usage-v1';
export type Capability<T> =
  | { tier: 'declarative'; spec: T }
  | { tier: 'assisted'; hook: HookId }
  | { tier: 'unsupported'; reason: string };
export type StringRule = { pattern: string; flags: '' | 'i' | 'u' | 'iu'; max_length: number };
export type Guard =
  | { path: PathRef; op: 'eq'; value: string | number | boolean }
  | { path: PathRef; op: 'one-of'; values: string[] }
  | { path: PathRef; op: 'string' | 'finite-number' | 'absent-or-null' };
export type ExtractionRule =
  | { kind: 'json-line'; guards: Guard[]; path: PathRef; rule: StringRule;
      max_line_chars: number; first: 'legacy-first-buffer' }
  | { kind: 'text-line'; pattern: StringRule; group: number;
      max_matches: 1; max_line_chars: number; first: 'legacy-first-buffer' };
/** Native option validation is code, not a user-authored grammar. */
export type NativeRoute = 'codex' | 'pi' | 'opencode';
export type RoutePolicy = NativeRoute | 'passthrough';
/** A shell-free command line with whole-word named placeholders. */
export type CommandTemplate = string;
export type OptionBinding = { names: string[]; scope: string; syntax: 'value' | 'config-assignment';
  key: string | null; absent: 'native-default'; conflict: 'preserve-native-order' };
export type CwdContract = { spawn: 'checkoutRoot'; env_sync: string[];
  native_precedence: string[]; path: 'host-resolve' | 'windows-native';
  prepare: Capability<{ kind: 'none' }> };
export type VerificationRule = { kind: 'observed-identity'; store: 'not-required' };
export type Root =
  | { kind: 'option-or-home'; option: 'codexRoot' | 'piRoot'; home_parts: string[];
      layout: 'recursive' | 'cwd-slash-encoded' }
  | { kind: 'hook'; hook: 'pi-windows-location-v1' }
  | { kind: 'run-log'; via: 'RunStore'; run_id: 'round.run_id' };
export type HeaderPredicate =
  | { path: PathRef; op: 'truthy' }
  | { path: PathRef; op: 'eq'; value: string | number | boolean | null }
  | { path: PathRef; op: 'object-has-key'; key: string };
export type HeaderFilter = { any: HeaderPredicate[] };
export type UsageSource = {
  kind: 'jsonl'; roots: Root[]; path_pattern: string; encoding: 'utf8';
  header: { type: string; cwd: PathRef; id: PathRef | null; version: PathRef;
    accepted_versions: (string | number)[]; exclude: HeaderFilter };
  row: { timestamp: PathRef; type: PathRef; event: PathRef; turn: PathRef;
    role: PathRef; stop: PathRef; id: PathRef; usage: PathRef };
  samples: Guard[];
  window: { start: Guard[]; end: Guard[]; turn_match: boolean;
    launch_inclusive: true; delivery_end_inclusive: true; next_start_exclusive: true;
    partial_last_segment: 'invalid'; timestamp_order: 'nondecreasing' };
  counters: { input: PathRef[]; output: PathRef; total: PathRef; cost: PathRef | null };
};
export type AccountingRule = {
  mode: 'cumulative-difference' | 'sum-deduplicated';
  dedup: 'message-id-or-line' | 'ordered-snapshots';
  baseline: 'last-before-start-or-first-zero' | 'zero';
  terminal: 'snapshot-at-or-after-delivery' | 'assistant-stop';
  integers: 'nonnegative-safe'; total: 'input-plus-output';
  cost_missing: 'null'; cost_null: 'invalid' | 'null';
};
export type UsageContract = {
  capability: Capability<UsageSource>; readable_formats: ('task-usage-v1')[];
  source: UsageSource | null; attribution: 'legacy-cwd-window-v1' | 'exact-session-window-v1';
  accounting: AccountingRule | null;
  cost: { kind: 'native-usd' | 'unavailable'; reason?: string };
};
export type InvokeContract = {
  run: Capability<CommandTemplate>; resume: Capability<CommandTemplate>;
  route: RoutePolicy; model: Capability<OptionBinding>;
  effort: Capability<OptionBinding>; cwd: Capability<CwdContract>;
};
export type SessionContract = {
  fresh_identity: 'native-observed' | 'designated'; capture: Capability<ExtractionRule>;
  id_validation: StringRule; resume_identity: 'observed' | 'designated';
  verify_resume: Capability<VerificationRule>; legacy_plain_argv: Capability<NativeRoute>;
};
export type PlatformOverride = {
  invoke?: { run?: Capability<CommandTemplate>; resume?: Capability<CommandTemplate>;
    cwd?: Capability<CwdContract> };
  usage?: { capability?: Capability<UsageSource>; source?: UsageSource | null;
    accounting?: AccountingRule | null; readable_formats?: ('task-usage-v1')[] };
};
export type AgentProfile = {
  schema_version: 2; id: string; revision: string;
  evidence: { baseline_commit: string; native_versions: string[];
    platforms: Platform[]; references: string[]; note: string };
  match: { supported_executable_names: string[];
    platform_target_identity: { win32: 'codex' | 'pi' } | null };
  invoke: InvokeContract; session: SessionContract; usage: UsageContract;
  platform_overrides: { posix?: PlatformOverride; win32?: PlatformOverride };
};
