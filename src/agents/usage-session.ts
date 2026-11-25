/** Native JSONL normalization and accounting: one parser for all readers. */
import path from 'node:path';
import {nativeReadPort} from './ports.js';
import type {FrozenProfile} from './registry.js';
import {usageContextFor} from './usage-context.js';
import { valueAt, guardsMatch } from './projection.js';
import type { UsageSource } from './types.js';
import type { UsageCandidate } from './runtime-contract.js';
interface Tokens {input_tokens:number;output_tokens:number;total_tokens:number}
export interface NativeHeader {cwd:unknown;version:unknown;id?:unknown;excluded:boolean}
export interface NativeRow {line:number;ts:unknown;type:unknown;event:unknown;turn:unknown;role:unknown;stop:unknown;id:unknown;usage:unknown;start:boolean;end:boolean;sample:boolean;header?:NativeHeader|undefined}
export interface NativeSession {file:string;agent:string;profile:FrozenProfile;rows:NativeRow[];partial:boolean;complete_lines:number;header:NativeHeader|undefined;excluded:boolean}
export interface UsageWindow {cwd:string;launch_ts:string;ts:string;pi_session?:{session_id:string}}
export function sameUsageCwd(header:unknown,cwd:string,options:{platform?:NodeJS.Platform}={}):boolean {
 if((options.platform??nativeReadPort().platform())==='win32')return typeof header==='string'&&path.win32.isAbsolute(header)&&path.win32.resolve(header)===cwd;
 return path.posix.resolve((header??'/') as string)===cwd;
}
export function headerExcluded(raw:unknown,source:UsageSource):boolean {
 return source.header.exclude.any.some(p=>{const v=valueAt(raw,p.path);return p.op==='truthy'?!!v:p.op==='eq'?v===p.value:v!==null&&typeof v==='object'&&p.key in v;});
}
export function projectUsageRow(raw:unknown,source:UsageSource,line:number):NativeRow {
 const r=source.row;
 return {line,ts:valueAt(raw,r.timestamp),type:valueAt(raw,r.type),event:valueAt(raw,r.event),turn:valueAt(raw,r.turn),role:valueAt(raw,r.role),stop:valueAt(raw,r.stop),id:valueAt(raw,r.id),usage:valueAt(raw,r.usage),
  start:guardsMatch(raw,source.window.start),end:guardsMatch(raw,source.window.end),sample:guardsMatch(raw,source.samples)};
}
export function parseUsageSession(text:string,file:string,profile:FrozenProfile,profileRoot?:string):NativeSession {
 const source=profile.value.usage.source;if(!source)throw Error('unsupported_agent');
 const lines=text.split('\n'),partial=lines.at(-1)!.length>0;lines.pop();
 const rows:NativeRow[]=[];
 // Resolve the historical peer once for the session, including all later
 // header rows; custom profiles continue to use only their declared source.
 const other=usageContextFor(profile).peerHeader;
 for(let i=0;i<lines.length;i++) {
  const line=lines[i]!;if(!line.trim())continue;
  let raw:unknown;try{raw=JSON.parse(line);}catch{throw Error(`invalid_jsonl_line:${i+1}`);}
  // Preserve the legacy null-row diagnostic without exposing message bodies.
  if(raw===null)throw new TypeError("Cannot read properties of null (reading 'payload')");
  const type=valueAt(raw,['type']);
  let headerSource=type===source.header.type?source.header:undefined;
  // Only the two historical readers accepted each other's native headers.
  // A new profile always uses its own source, even when type names coincide.
  if(!headerSource&&other&&other.type===type)headerSource=other;
  const row=projectUsageRow(raw,source,i+1);
  if(headerSource)row.header={cwd:valueAt(raw,headerSource.cwd),version:valueAt(raw,headerSource.version),...(headerSource.id?{id:valueAt(raw,headerSource.id)}:{}),excluded:headerExcluded(raw,{...source,header:headerSource})};
  rows.push(row);
 }
 const header=rows[0]?.header;
 return {file,agent:profile.id,profile,rows,partial,complete_lines:lines.length,header,excluded:!header||header.excluded};
}
export function instant(value:unknown) {
  const n = Date.parse(value as string);
  if (typeof value !== 'string' || !Number.isFinite(n)) throw new Error('invalid_timestamp');
  return n;
}
export function vector(v:unknown) {
  const data=v as Record<string,number>|null;
  if (!data || !['input_tokens', 'output_tokens', 'total_tokens'].every(k => Number.isSafeInteger(data[k]!) && data[k]! >= 0)
      || data.total_tokens !== data.input_tokens! + data.output_tokens!) throw new Error('invalid_token_vector');
  return { input_tokens: data!.input_tokens!, output_tokens: data!.output_tokens!, total_tokens: data!.total_tokens! };
}
function add(a:Tokens, b:Tokens) { return vector(Object.fromEntries(Object.keys(a).map(k => [k, a[k as keyof Tokens] + b[k as keyof Tokens]]))); }
const zero = () => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
export function measureUsageSession(session:NativeSession, round:UsageWindow, options:{platform?:NodeJS.Platform} = {}):UsageCandidate[] {
  if (session.excluded || !sameUsageCwd(session.header!.cwd, round.cwd, {platform:options.platform??(session.profile.platform==='win32'?'win32':'linux')}) ||
      (round.pi_session && session.header!.id !== round.pi_session.session_id)) return [];
  const { rows, agent } = session;
  const contract=session.profile.value.usage;
  const source=contract?.source,accounting=contract?.accounting;
  if(!source||!accounting)return [];
  const summed=accounting.mode==='sum-deduplicated';
  if(source.header.accepted_versions.length&&!source.header.accepted_versions.includes(session.header!.version as string|number))throw new Error('unsupported_pi_schema');
  const L = instant(round.launch_ts), D = instant(round.ts);
  const isStart = (r:NativeRow) => r.start;
  const starts = rows.filter(isStart);
  const candidates = starts.filter(r => instant(r.ts) >= L && instant(r.ts) <= D);
  const results = [];
  for (const start of candidates) {
    const next = starts.find(r => r.line > start.line);
    const segment = rows.filter(r => r.line >= start.line && (!next || r.line < next.line));
    const end = segment.find(r => instant(r.ts) >= D && r.end && (!source.window.turn_match || r.turn===start.turn&&!!start.turn));
    if (!end) continue;
    if (session.partial && !next) throw new Error('partial_jsonl_tail');
    const window = segment.filter(r => r.line <= end.line);
    // Ordering must be coherent even when timestamps share a millisecond.
    for (let i = 1; i < window.length; i++) if (instant(window[i]!.ts) < instant(window[i-1]!.ts)) throw new Error('nonmonotonic_session_time');
    let tokens = zero(), cost = contract.cost.kind==='unavailable' ? null : 0;
    if (summed) {
      const seen = new Map();
      for (const r of window.filter(r => r.sample)) {
        const u = r.usage;
        if (!u) throw new Error('missing_usage');
        const fingerprint = JSON.stringify(u), key = r.id ?? r.line;
        if (seen.has(key)) { if (seen.get(key) !== fingerprint) throw new Error('conflicting_message_usage'); continue; }
        seen.set(key, fingerprint);
        for (const field of [...source.counters.input,source.counters.output,source.counters.total]) {
          const value=valueAt(u,field);
          if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('invalid_pi_usage');
        }
        tokens = add(tokens, vector({ input_tokens:source.counters.input.reduce((sum,p)=>sum+(valueAt(u,p) as number),0),output_tokens:valueAt(u,source.counters.output),total_tokens:valueAt(u,source.counters.total) }));
        const nativeCost=source.counters.cost?valueAt(u,source.counters.cost):undefined;
        if (nativeCost===undefined || (accounting.cost_null==='null'&&nativeCost===null))cost=null;
        else if(!Number.isFinite(nativeCost)||(nativeCost as number)<0)throw new Error('invalid_cost');
        else if(cost!==null)cost+=nativeCost as number;
      }
      if (!seen.size) throw new Error('missing_usage');
    } else {
      const snapshots = rows.filter(r => r.line <= end.line && r.sample && r.usage);
      const mapped=(r:NativeRow)=>vector({input_tokens:source.counters.input.reduce((sum,p)=>sum+(valueAt(r.usage,p) as number),0),output_tokens:valueAt(r.usage,source.counters.output),total_tokens:valueAt(r.usage,source.counters.total)});
      const before = snapshots.filter(r => r.line < start.line);
      if (starts[0] !== start && !before.length) throw new Error('missing_baseline');
      const baseline = before.length ? mapped(before.at(-1)!) : zero();
      const current = snapshots.filter(r => r.line > start.line);
      if (!current.length || instant(current.at(-1)!.ts) < D) throw new Error('missing_terminal_usage');
      let prev = zero();
      for (const r of snapshots) {
        const v = mapped(r);
        if (Object.keys(prev).some(k => v[k as keyof Tokens] < prev[k as keyof Tokens])) throw new Error('cumulative_reset');
        prev = v;
      }
      const final = mapped(current.at(-1)!);
      tokens = vector(Object.fromEntries(Object.keys(baseline).map(k => [k, final[k as keyof Tokens] - baseline[k as keyof Tokens]])));
    }
    if (cost !== null && !Number.isFinite(cost)) throw new Error('invalid_cost');
    results.push({ ...tokens, cost_usd: cost, session_file: session.file,
      window_start: start.ts as string, window_end: end.ts as string, start_line: start.line, end_line: end.line,
      ...(start.turn ? { turn_id: start.turn as string } : {}) });
  }
  return results;
}
