/** Strict structural and semantic validation; no task-supplied executable code. */
import { z } from 'zod';
import type { AgentProfile } from './types.js';
import { commandWords } from './template.js';
const str = z.string().min(1).refine(s => !s.includes('\0'), 'NUL is forbidden');
const nat = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = nat.refine(n => n > 0);
const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const literals = <T extends [string, ...string[]]>(...values: T) => z.enum(values);
const key = str.refine(s => !['__proto__','prototype','constructor'].includes(s));
const path = z.array(z.union([key, nat])).min(1);
// A deliberately small regular language: anchored concatenations of literals,
// character classes and bounded repetitions. No backtracking expressions.
export function safePattern(pattern: string): boolean {
  if (!pattern.startsWith('^') || !pattern.endsWith('$') || pattern.length > 512) return false;
  const body = pattern.slice(1,-1);
  if (!/^(?:(?:\[(?:\\.|[^\]\\])+\]|\\[-wds]|[-_a-zA-Z0-9]|\((?:\?:)?|\))(?:\{\d+(?:,\d+)?\})?)+$/u.test(body)) return false;
  // Quantified groups, alternation and unbounded repetitions are excluded.
  if (/\)[{*+?]|\\[1-9]|\(\?[^:]/u.test(body)) return false;
  // Reject adjacent variable repetitions even when parentheses hide the
  // boundary. They otherwise admit combinatorial backtracking on a bad id.
  const flat=body.replace(/\(\?:|[()]/gu,'');
  if(/\}[^a-zA-Z0-9_-]*(?:\[[^\]]+\]|\\[wds]|[a-zA-Z0-9_-])\{/u.test(flat))return false;
  if([...body.matchAll(/\{(\d+)(?:,(\d+))?\}/gu)].some(m=>Number(m[1])>1048576||Number(m[2]??m[1])>1048576))return false;
  try { new RegExp(pattern, 'u'); return true; } catch { return false; }
}
const rule = obj({pattern: str.refine(safePattern, 'unsafe pattern'), flags:literals('','i','u','iu'), max_length:positive});
const guard = z.union([
 obj({path,op:z.literal('eq'),value:z.union([str,z.number(),z.boolean()])}),
 obj({path,op:z.literal('one-of'),values:z.array(str)}),
 obj({path,op:literals('string','finite-number','absent-or-null')})
]);
const extraction = z.union([
 obj({kind:z.literal('json-line'),guards:z.array(guard),path,rule,max_line_chars:positive,first:z.literal('legacy-first-buffer')}),
 obj({kind:z.literal('text-line'),pattern:rule,group:positive,max_matches:z.literal(1),max_line_chars:positive,first:z.literal('legacy-first-buffer')})
]);
const template = str.refine(s=>{try{commandWords(s);return true;}catch{return false;}},'invalid command template');
const nativeRoute = literals('codex','pi','opencode');
function cap<T extends z.ZodTypeAny>(spec:T, hooks:string[] = []) {
 return z.union([obj({tier:z.literal('declarative'),spec}),obj({tier:z.literal('assisted'),hook:str.refine(h=>hooks.includes(h),'unregistered hook at this capability')}),obj({tier:z.literal('unsupported'),reason:str})]);
}
const binding = obj({names:z.array(str),scope:str,syntax:literals('value','config-assignment'),key:str.nullable(),absent:z.literal('native-default'),conflict:z.literal('preserve-native-order')});
const cwd = obj({spawn:z.literal('checkoutRoot'),env_sync:z.array(str),native_precedence:z.array(str),path:literals('host-resolve','windows-native'),prepare:cap(obj({kind:z.literal('none')}),['pi-windows-location-v1'])});
const root = z.union([
 obj({kind:z.literal('option-or-home'),option:literals('codexRoot','piRoot'),home_parts:z.array(str),layout:literals('recursive','cwd-slash-encoded')}),
 obj({kind:z.literal('hook'),hook:z.literal('pi-windows-location-v1')}),
 obj({kind:z.literal('run-log'),via:z.literal('RunStore'),run_id:z.literal('round.run_id')})]);
const source = obj({kind:z.literal('jsonl'),roots:z.array(root),path_pattern:str.refine(s=>/^[a-zA-Z0-9_.*-]+(?:\/[a-zA-Z0-9_.*-]+)*$/u.test(s)&&!s.split('/').some(p=>p==='.'||p==='..'||p.includes('**')&&p!=='**')),encoding:z.literal('utf8'),
 header:obj({type:str,cwd:path,id:path.nullable(),version:path,accepted_versions:z.array(z.union([str,z.number()])),exclude:obj({any:z.array(z.union([obj({path,op:z.literal('truthy')}),obj({path,op:z.literal('eq'),value:z.union([str,z.number(),z.boolean(),z.null()])}),obj({path,op:z.literal('object-has-key'),key})]))})}),
 row:obj({timestamp:path,type:path,event:path,turn:path,role:path,stop:path,id:path,usage:path}),samples:z.array(guard),
 window:obj({start:z.array(guard),end:z.array(guard),turn_match:z.boolean(),launch_inclusive:z.literal(true),delivery_end_inclusive:z.literal(true),next_start_exclusive:z.literal(true),partial_last_segment:z.literal('invalid'),timestamp_order:z.literal('nondecreasing')}),
 counters:obj({input:z.array(path).min(1),output:path,total:path,cost:path.nullable()})});
const accounting = obj({mode:literals('cumulative-difference','sum-deduplicated'),dedup:literals('message-id-or-line','ordered-snapshots'),baseline:literals('last-before-start-or-first-zero','zero'),terminal:literals('snapshot-at-or-after-delivery','assistant-stop'),integers:z.literal('nonnegative-safe'),total:z.literal('input-plus-output'),cost_missing:z.literal('null'),cost_null:literals('invalid','null')});
const usageCapability = cap(source,['opencode-usage-v1','pi-windows-location-v1']);
const formats = z.array(z.literal('task-usage-v1'));
const override = obj({invoke:obj({run:cap(template).optional(),resume:cap(template).optional(),cwd:cap(cwd).optional()}).optional(),usage:obj({capability:usageCapability.optional(),source:source.nullable().optional(),accounting:accounting.nullable().optional(),readable_formats:formats.optional()}).optional()});
export const profileSchema = obj({schema_version:z.literal(2),id:str.refine(s=>/^[a-z][a-z0-9-]{0,63}$/u.test(s)),revision:str,
 evidence:obj({baseline_commit:str,native_versions:z.array(str),platforms:z.array(literals('posix','win32')).min(1),references:z.array(str),note:str}),
 match:obj({supported_executable_names:z.array(str).min(1),platform_target_identity:obj({win32:literals('codex','pi')}).nullable()}),
 invoke:obj({run:cap(template),resume:cap(template),route:literals('codex','pi','opencode','passthrough').default('passthrough'),model:cap(binding),effort:cap(binding),cwd:cap(cwd)}),
 session:obj({fresh_identity:literals('native-observed','designated'),capture:cap(extraction),id_validation:rule,resume_identity:literals('observed','designated'),verify_resume:cap(obj({kind:z.literal('observed-identity'),store:z.literal('not-required')}),['pi-store-v1']),legacy_plain_argv:cap(nativeRoute)}),
 usage:obj({capability:usageCapability,readable_formats:formats,source:source.nullable(),attribution:literals('legacy-cwd-window-v1','exact-session-window-v1'),accounting:accounting.nullable(),cost:obj({kind:literals('native-usd','unavailable'),reason:str.optional()})}),
 platform_overrides:obj({posix:override.optional(),win32:override.optional()})});
/** Validate expanded profiles too, so a platform override cannot bypass invariants. */
export function validateProfile(raw:unknown):AgentProfile {
 if(raw&&typeof raw==='object'&&'schema_version' in raw&&raw.schema_version===1)throw Error('AgentProfile v1 token grammar is retired; migrate to schema_version 2 command strings (workspace-agent-onboarding.md)');
 const p=profileSchema.parse(raw) as AgentProfile;
 for(const mode of ['run','resume'] as const) {
  const c=p.invoke[mode];if(c.tier!=='declarative')continue;
  const words=commandWords(c.spec),slots=words.slice(1).filter(w=>w.startsWith('{'));
  if(slots.filter(w=>w==='{prompt}').length!==1)throw Error('command needs exactly one {prompt}');
  if(mode==='resume'&&!slots.includes('{session}'))throw Error('resume command needs {session}');
  if(mode==='run'&&p.session.fresh_identity==='native-observed'&&slots.includes('{session}'))throw Error('observed run cannot designate identity');
  if(new Set(slots).size!==slots.length)throw Error('duplicate command placeholder');
  const nativeSlots=p.invoke.route==='codex'?['root','parent','shared','nonroot','json']:p.invoke.route==='pi'?['print','mode']:p.invoke.route==='opencode'?['json']:[];
  for(const slot of slots)if(['root','parent','shared','nonroot','json','print','mode'].includes(slot.slice(1,-1))&&!nativeSlots.includes(slot.slice(1,-1)))throw Error('placeholder unavailable for route policy');
  const projections=slots.filter(w=>['{args}','{options}','{root}','{parent}','{shared}','{nonroot}'].includes(w));
  if(projections.includes('{args}')&&projections.length>1||projections.includes('{options}')&&projections.length>1||projections.includes('{nonroot}')&&projections.some(w=>w!=='{nonroot}'&&w!=='{root}'))throw Error('overlapping argument projection');
 }
 const u=p.usage;
 if(u.capability.tier==='unsupported'&&(u.source!==null||u.accounting!==null||u.readable_formats.length))throw Error('unsupported usage has source');
 if(u.capability.tier==='declarative'&&(!u.source||!u.accounting||JSON.stringify(u.source)!==JSON.stringify(u.capability.spec)))throw Error('usage source mismatch');
 if(u.accounting) {
  const a=u.accounting,cumulative=a.mode==='cumulative-difference';
  if(a.dedup!==(cumulative?'ordered-snapshots':'message-id-or-line')||a.baseline!==(cumulative?'last-before-start-or-first-zero':'zero')||a.terminal!==(cumulative?'snapshot-at-or-after-delivery':'assistant-stop'))throw Error('accounting mismatch');
 }
 if(u.source&&(u.cost.kind==='unavailable'?u.source.counters.cost!==null:u.source.counters.cost===null))throw Error('cost source mismatch');
 if(p.session.capture.tier==='declarative'&&p.session.capture.spec.kind==='text-line') {
  const c=p.session.capture.spec,count=(c.pattern.pattern.match(/\((?!\?:)/gu)??[]).length;
  if(c.group>count)throw Error('capture group missing');
 }
 return p;
}
