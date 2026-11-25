import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { windowsPiEncodedCwd } from '../../../dist/agents/public/native-compat.js';
import { createServer } from 'node:http';
import { Store } from '../../../dist/hub/store.js';
import { startServer } from '../../../dist/hub/server.js';
import { readConfigFile, writeConfigKey, parseConfigValue } from '../../../dist/core/common/config.js';
import { extract } from '../lib/rounds.mjs';
import { attribute, measure, readSession } from './helpers.mjs';
import { run, collect, enabled, lock, lockPath, merge, writeUsage, loadUsage, source, validateUsage } from '../lib/audit.mjs';
import { canonicalRoot } from '../../../dist/hub/rig-discovery.js';
import { parse } from '../run.mjs';
import { installServiceLog } from '../../../dist/core/logging/service-log.js';
// Real native fixture directory: legacy POSIX encoding is not a Windows filename.
const fixtureCwdDirectory = root => process.platform === 'win32' ? windowsPiEncodedCwd(root) : `--${root.slice(1).replaceAll('/', '-')}--`;
const T = n => new Date(Date.UTC(2026,0,1,0,0,0,n)).toISOString();
async function temp(t) { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'usage-test-'))); t.after(() => fs.rm(dir,{recursive:true,force:true})); await fs.mkdir(path.join(dir,'.context-hub','runtime'),{recursive:true}); return dir; }
const launch = (v, n, agent='pi', role='executor') => ({ version:v, timestamp:T(n), role:'human', content_type:'note', payload:{launch:{role, base_version:v-1,route:{agent,args:[]}}} });
const delivery = (v,n,role='executor') => ({ version:v,timestamp:T(n),role,content_type:role==='executor'?'code_changes':role==='architect'?'design':'review',payload:{} });
const task = (root,versions,id='one') => ({task_id:id, versions});
const piHead = root => ({type:'session',version:3,cwd:root,timestamp:T(0)});
const user = n => ({type:'message',id:`u${n}`,timestamp:T(n),message:{role:'user'}});
const pi = (n,stop='toolUse',id=`a${n}`) => ({type:'message',id,timestamp:T(n),message:{role:'assistant',stopReason:stop,usage:{input:10,output:5,cacheRead:20,cacheWrite:2,reasoning:4,totalTokens:37,cost:{total:0.125}}}});
const codexHead = root => ({type:'session_meta',timestamp:T(0),payload:{cwd:root,source:'cli',cli_version:'test'}});
const ev = (n,type,extra={}) => ({type:'event_msg',timestamp:T(n),payload:{type,...extra}});
const count = (n,input,output) => ev(n,'token_count',{info:{total_token_usage:{input_tokens:input,output_tokens:output,total_tokens:input+output,cached_input_tokens:10,reasoning_output_tokens:2}}});
async function session(dir,agent,rows,name='session.jsonl',tail='') { const file=path.join(dir,name); await fs.writeFile(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n'+tail); return readSession(file,agent); }

for (const agent of ['pi','codex']) test(`${agent}: note-terminated round and subsequent code delivery both count, including same-session tails`, async t => {
  const root=await temp(t);
  const note=(v,n,role='executor',content_type='note')=>({...delivery(v,n,role),content_type});
  const versions=[launch(1,5,agent),note(2,15,'human'),note(3,20,'reviewer'),note(4,25),
    note(5,30),delivery(6,35),launch(7,50,agent),delivery(8,70)];
  const rows=agent==='pi'
    ? [piHead(root),user(10),pi(20),pi(40,'stop'),user(60),pi(80,'stop')]
    : [codexHead(root),ev(10,'task_started',{turn_id:'a'}),count(20,100,10),count(40,150,20),ev(41,'task_complete',{turn_id:'a'}),
      ev(60,'task_started',{turn_id:'b'}),count(80,180,25),ev(81,'task_complete',{turn_id:'b'})];
  const s=await session(root,agent,rows);
  const rounds=extract(task(root,versions),root);
  assert.deepEqual(rounds.map(r=>[r.launch_version,r.delivery_version]),[[1,4],[7,8]]);
  const value=validateUsage(merge(null,attribute(rounds,[s])));
  assert.deepEqual(value.rounds.map(r=>[r.input_tokens,r.output_tokens,r.total_tokens]),
    agent==='pi'?[[64,10,74],[32,5,37]]:[[150,20,170],[30,5,35]]);
  assert.equal(value.total.rounds,2);
  assert.equal(value.total.complete,true);
  assert.deepEqual(value.unresolved,[]);
});
test('all worker publication types close a launch, but unlaunched notes and launch markers do not',()=>{
  for (const role of ['architect','executor','reviewer']) for (const content_type of ['note','checkpoint','decision','review','code_changes']) {
    const first={...delivery(1,1,role),content_type:'note'};
    const done={...delivery(3,30,role),content_type};
    const rounds=extract(task('/tmp/x',[first,launch(2,5,'codex',role),done]),'/tmp/x');
    assert.equal(rounds.length,1);
    assert.deepEqual([rounds[0].launch_version,rounds[0].delivery_version],[2,3]);
  }
});

test('pi caches, multiple calls, duplicate message IDs, cost and post-delivery tail; same-file continuation', async t => {
  const root=await temp(t), rows=[piHead(root),user(10),pi(20),pi(40,'stop'),user(60),pi(80,'stop')];
  rows.splice(3,0,pi(20));
  const s=await session(root,'pi',rows), rounds=extract(task(root,[launch(1,5),delivery(2,30),launch(3,50),delivery(4,70)]),root);
  const results=attribute(rounds,[s]);
  assert.equal(results[0].reason,undefined); assert.equal(results[1].reason,undefined);
  assert.deepEqual(results.map(r=>[r.candidates[0].input_tokens,r.candidates[0].output_tokens,r.candidates[0].total_tokens,r.candidates[0].cost_usd]),[[64,10,74,0.25],[32,5,37,0.125]]);
  assert.equal(results[0].candidates[0].window_end,T(40));
});
test('Codex cumulative snapshots and continuation use differences, unknown cost; resets refused', async t => {
  const root=await temp(t), rows=[codexHead(root),ev(10,'task_started',{turn_id:'a'}),count(20,100,10),count(20,100,10),count(40,150,20),ev(41,'task_complete',{turn_id:'a'}),ev(60,'task_started',{turn_id:'b'}),count(80,180,25),ev(81,'task_complete',{turn_id:'b'})];
  const s=await session(root,'codex',rows), rounds=extract(task(root,[launch(1,5,'codex'),delivery(2,30),launch(3,50,'codex'),delivery(4,70)]),root);
  const results=attribute(rounds,[s]); assert.deepEqual(results.map(r=>r.candidates[0].total_tokens),[170,35]); assert.equal(results[0].candidates[0].cost_usd,null);
  rows[7]=count(80,140,21); const reset=await session(root,'codex',rows); assert.match(attribute(rounds,[reset])[1].reason,/cumulative_reset/);
});
test('unsupported pi schema version fails loud instead of guessing (explicit failure, no invented numbers)',async t=>{
  const root=await temp(t), rows=[{...piHead(root),version:4},user(10),pi(20)];
  const s=await session(root,'pi',rows), rounds=extract(task(root,[launch(1,5),delivery(2,30)]),root);
  assert.throws(()=>measure(s,rounds[0]),/unsupported_pi_schema/);
});
test('stale lock (dead pid) self-heals on startup; live pid still refuses',async t=>{
  const f=await fixture(t);
  const lockFile=lockPath(canonicalRoot(f.root));
  await fs.writeFile(lockFile,JSON.stringify({pid:99999999,root:f.root,started:'2026-01-01T00:00:00Z'}));
  // dead pid -> self-heal: run() takes the lock (collect itself never does) and proceeds
  await run({...f.options, watch:false, timeoutMs:1},{hub:f.hub});
  const v=await loadUsage(path.join(f.root,'.context-hub/tasks',f.id));assert.equal(v.rounds.length,1);
  // live pid -> still refuses
  await fs.writeFile(lockFile,JSON.stringify({pid:process.pid,root:f.root,started:new Date().toISOString()}));
  await assert.rejects(run({...f.options, watch:false, timeoutMs:1},{hub:f.hub}),/audit_locked/);
});
test('successful claim leaves the hardlink single-named (tmp source unlinked, no leak per claim)',async t=>{
  const f=await fixture(t);
  const lockFile=lockPath(canonicalRoot(f.root));
  const release=await lock(f.root);
  assert.equal((await fs.stat(lockFile)).nlink,1);
  await release();
  await assert.rejects(fs.stat(lockFile),{code:'ENOENT'});
});
test('interrupted stale-lock recovery (leftover .reclaim) refuses and names the residue',async t=>{
  const f=await fixture(t);
  const lockFile=lockPath(canonicalRoot(f.root));
  await fs.writeFile(lockFile,JSON.stringify({pid:99999999,root:f.root,started:'2026-01-01T00:00:00Z'}));
  await fs.mkdir(lockFile+'.reclaim');
  await assert.rejects(lock(f.root),e=>e.message.includes(String(lockFile)+'.reclaim')&&/recovery/.test(e.message));
  await fs.rmdir(lockFile+'.reclaim');
});
test('repeated identical pass failures are rate-limited (first, then every 20th)',async t=>{
  const f=await fixture(t);
  let calls=0; const ac=new AbortController(); const lines=[];
  const orig=process.stderr.write.bind(process.stderr); process.stderr.write=b=>{lines.push(String(b));return true;};
  try {
    await run({...f.options,watch:true,intervalMs:1,timeoutMs:Infinity,signal:ac.signal},
      {enabled:async()=>true,lock:async()=>async()=>{},sleep:async()=>{},collect:async()=>{if(++calls>=25)ac.abort();throw new Error('boom');}});
  } finally { process.stderr.write=orig; }
  const fails=lines.filter(l=>l.includes('pass failed'));
  assert.equal(fails.length,2);
  assert.match(fails[0],/pass failed \(boom\); retrying/);
  assert.match(fails[1],/21 consecutive failures/);
});
test('identical pass reports are not repeated every interval; content changes re-emit',async t=>{
  const f=await fixture(t);
  const ac=new AbortController(); const lines=[];
  const orig=process.stdout.write.bind(process.stdout); process.stdout.write=b=>{lines.push(String(b));return true;};
  let pass=0;
  const rep=()=>({task_id:f.id,changed:false,total:{rounds:1,total_tokens:37,cost_usd:0.125,complete:false},
    unresolved:[{delivery_version:2,...(pass>=3?{launch_version:1}:{}),reason:'missing_session_or_end'}]});
  try {
    await run({...f.options,watch:true,intervalMs:1,timeoutMs:Infinity,signal:ac.signal},
      {enabled:async()=>true,lock:async()=>async()=>{},sleep:async()=>{},
       collect:async()=>{if(++pass>=4)ac.abort();return [rep(),{task_id:'other',changed:false,total:{rounds:0,total_tokens:0,cost_usd:0,complete:false},unresolved:[{delivery_version:1,reason:'missing_launch'}]}];}});
  } finally { process.stdout.write=orig; }
  assert.equal(pass,4);
  // identical on passes 1-2 (emitted once), content changes on pass 3 (re-emits), identical on pass 4 (suppressed)
  assert.equal(lines.filter(l=>l.includes(`"${f.id}"`)).length,2);
  assert.equal(lines.filter(l=>l.includes('"other"')).length,1);
});
test('launch without delivery or sessions reports once in watch, without a usage snapshot',async t=>{
  const root=await temp(t),store=new Store(path.join(root,'.context-hub'));await store.whenSwept;
  const {task_id:id}=await store.createTask({title:'No rounds',description:'test',role:'human',creator:'test',flow:'direct'});
  await store.append(id,{role:'human',content_type:'note',payload:{summary:'launch',body:'test',launch:{role:'executor',base_version:0,route:{agent:'pi',args:[]}}}});
  const hub={list:()=>store.listTasks(),read:id=>store.readTask(id)};
  const options={root,piRoot:path.join(root,'pi'),codexRoot:path.join(root,'codex'),intervalMs:1,timeoutMs:Infinity};
  const expected={task_id:id,changed:false,reason:'no_matching_rounds'};
  const ac=new AbortController(),passes=[];
  await run({...options,watch:true,signal:ac.signal},{hub,enabled:async()=>true,sleep:async()=>{},
    report:reports=>{passes.push(reports);if(passes.length===2)ac.abort();}});
  assert.deepEqual(passes,[[expected],[]]);
  assert.deepEqual(await collect({...options,watch:false},{hub}),[expected]);
  assert.deepEqual(await collect({...options,since:Date.now()+10000},{hub}),[expected]);
  assert.deepEqual(await collect({...options,task:'absent'},{hub}),[]);
  const dir=path.join(root,'.context-hub/tasks',id);
  assert.equal(await loadUsage(dir),null);
  // Once delivery arrives, retain the existing missing-session diagnostic.
  await store.append(id,{role:'executor',content_type:'code_changes',payload:{summary:'done',body:'test'}});
  assert.deepEqual(await collect({...options,since:Date.now()+10000},{hub}),[]);
  assert.equal(await loadUsage(dir),null);
  const [report]=await collect(options,{hub});
  assert.equal(report.reason,undefined);
  assert.equal(report.unresolved[0].reason,'missing_session_or_end');
});
test('zero-round task remains visible alongside measured tasks and respects task selection',async t=>{
  const f=await fixture(t);
  const {task_id:id}=await f.store.createTask({title:'Empty',description:'test',role:'human',creator:'test',flow:'direct'});
  const reports=await collect(f.options,{hub:f.hub});
  assert.equal(reports.length,2);
  assert.equal(reports.find(r=>r.task_id===id).reason,'no_matching_rounds');
  assert.equal(reports.find(r=>r.task_id===f.id).total.rounds,1);
  assert.deepEqual(await collect({...f.options,task:id},{hub:f.hub}),[{task_id:id,changed:false,reason:'no_matching_rounds'}]);
  assert.equal(await loadUsage(path.join(f.root,'.context-hub/tasks',id)),null);
});
test('collect writes note-only rounds and a later code round, then replays without double counting',async t=>{
  const root=await temp(t),store=new Store(path.join(root,'.context-hub'));await store.whenSwept;
  const {task_id:id}=await store.createTask({title:'Note rounds',description:'test',role:'human',creator:'test',flow:'direct'});
  const append=(role,content_type,payload={})=>store.append(id,{role,content_type,payload:{summary:'test',body:'test',...payload}});
  const start=()=>append('human','note',{launch:{role:'executor',base_version:0,route:{agent:'pi',args:[]}}});
  const pause=()=>new Promise(resolve=>setTimeout(resolve,5));
  await start();await pause();await append('executor','note');
  const piRoot=path.join(root,'pi'),cwdDir=path.join(piRoot,fixtureCwdDirectory(root));
  await fs.mkdir(cwdDir,{recursive:true});
  const hub={list:()=>store.listTasks(),read:id=>store.readTask(id)};
  const options={root,piRoot,codexRoot:path.join(root,'codex'),watch:false};
  const rows=[piHead(root)];
  const addWindow=async()=>{
    const task=await store.readTask(id),[L,D]=task.versions.slice(-2);
    const kickoff=user(10),end=pi(20,'stop',`a${L.version}`);
    kickoff.timestamp=L.timestamp;end.timestamp=new Date(Date.parse(D.timestamp)+1).toISOString();
    rows.push(kickoff,end);await session(cwdDir,'pi',rows);
  };
  await addWindow();
  const [noteOnly]=await collect(options,{hub});
  assert.deepEqual(noteOnly.total,{rounds:1,total_tokens:37,cost_usd:0.125,complete:true});
  await pause();await start();await pause();await append('executor','code_changes');await addWindow();
  const [both]=await collect(options,{hub});
  assert.deepEqual(both.total,{rounds:2,total_tokens:74,cost_usd:0.25,complete:true});
  const value=await loadUsage(path.join(root,'.context-hub/tasks',id));
  assert.deepEqual(value.rounds.map(r=>[r.launch_version,r.delivery_version,r.input_tokens,r.output_tokens]),[[1,2,32,5],[3,4,32,5]]);
  const [replay]=await collect(options,{hub});assert.equal(replay.changed,false);
  const [since]=await collect({...options,since:Date.parse(value.rounds[1].ts)},{hub});
  assert.deepEqual(since.total,both.total);assert.equal(since.changed,false);
});
test('unchanged session files are not re-read between watch passes; changed ones are',async t=>{
  const f=await fixture(t);
  let reads=0;
  const counting=async(file,agent)=>{reads++;return readSession(file,agent);};
  const options={...f.options,watch:true};
  const deps={hub:f.hub,allowed:async()=>true,readSession:counting};
  await collect(options,deps);
  await collect(options,deps);
  assert.equal(reads,1);
  await fs.appendFile(path.join(f.cwdDir,'session.jsonl'),JSON.stringify(pi(90,'stop','a9'))+'\n');
  await collect(options,deps);
  assert.equal(reads,2);
  await collect(options,deps);
  assert.equal(reads,2);
});
test('concurrent healers racing a stale lock: no double-hold, no errors, residue-free',async t=>{
  const f=await fixture(t);
  const lockFile=lockPath(canonicalRoot(f.root));
  const lib=new URL('../lib/audit.mjs',import.meta.url).href;
  const flag=path.join(path.dirname(lockFile),`tut-usage-audit-holdflag-${process.pid}`);
  const worker=`
    const {lock}=await import(process.argv[1]);
    const fsmod=await import('node:fs/promises');
    try{
      const release=await lock(process.argv[2]);
      const hold=await fsmod.open(process.argv[3],'wx');
      await new Promise(s=>setTimeout(s,5));
      await hold.close();await fsmod.rm(process.argv[3],{force:true});
      await release();console.log('WIN');
    }catch(e){
      if(/audit_locked/.test(e.message))process.exit(0);
      if(e.code==='EEXIST'){console.log('VIOLATION');process.exit(1);}
      console.log('ERR '+e.message);process.exit(1);
    }`;
  for (let round=0;round<5;round++) {
    await fs.rm(flag,{force:true});
    await fs.writeFile(lockFile,JSON.stringify({pid:99999999,root:f.root,started:'2026-01-01T00:00:00Z'}));
    const kids=[...Array(4)].map(()=>spawn(process.execPath,['-e',worker,lib,f.root,flag],{stdio:['ignore','pipe','inherit']}));
    // 'close' (not 'exit'): stdio must flush before the output is complete
    const outs=await Promise.all(kids.map(async k=>{
      let out=''; k.stdout.on('data',d=>out+=d);
      const [code]=await once(k,'close');
      return {code,out};
    }));
    assert.equal(outs.filter(o=>o.out.includes('VIOLATION')).length,0,'two healers held the lock simultaneously');
    assert.equal(outs.filter(o=>o.code===1).length,0,`unexpected worker errors: ${outs.map(o=>o.out.trim()).join('|')}`);
    assert.ok(outs.some(o=>o.out.trim()==='WIN'),'at least one healer must win each round');
  }
  await assert.rejects(fs.stat(lockFile+'.reclaim'),{code:'ENOENT'});
  await fs.rm(flag,{force:true});
});
test('nonmonotonic timestamps inside a measurement window fail loud',async t=>{
  const root=await temp(t);
  // the decreasing pair (T50 → T40) must sit inside the window, i.e. at or
  // before the native end row's line
  const rows=[piHead(root),user(10),pi(50,'toolUse','a1'),pi(40,'stop','a2')];
  const s=await session(root,'pi',rows);
  const rounds=extract(task(root,[launch(1,5),delivery(2,25)]),root);
  assert.throws(()=>measure(s,rounds[0]),/nonmonotonic_session_time/);
});
test('totals that overflow safe-integer aggregation fail loud instead of wrapping',async t=>{
  const big=Number.MAX_SAFE_INTEGER;
  const base={agent:'pi',role:'executor',ts:T(30),input_tokens:0,output_tokens:0,cost_usd:null,session_file:'/x/s.jsonl',window_start:T(5),window_end:T(30),start_line:1,end_line:2};
  const r=(tok,lv,dv)=>({...base,total_tokens:tok,input_tokens:tok,launch_version:lv,delivery_version:dv,round:lv});
  assert.throws(()=>validateUsage({schema_version:1,rounds:[r(big,1,2),r(1,2,3)],unresolved:[],
    total:{rounds:2,total_tokens:big+1,cost_usd:null,complete:true}}),/aggregate_overflow/);
});
test('codex rollout without token events fails loud instead of fabricating zeros',async t=>{
  const root=await temp(t), rows=[codexHead(root),ev(10,'task_started',{turn_id:'a'}),ev(41,'task_complete',{turn_id:'a'})];
  const s=await session(root,'codex',rows), rounds=extract(task(root,[launch(1,5,'codex'),delivery(2,30)]),root);
  assert.throws(()=>measure(s,rounds[0]),/missing_terminal_usage/);
});
test('terminal evidence, partial line, missing baseline and missing cost are visible', async t => {
  const root=await temp(t), r=extract(task(root,[launch(1,5),delivery(2,30)]),root)[0];
  let s=await session(root,'pi',[piHead(root),user(10),pi(20)]); assert.equal(measure(s,r).length,0);
  s=await session(root,'pi',[piHead(root),user(10),pi(40,'stop')],'session.jsonl','{"'); assert.throws(()=>measure(s,r),/partial_jsonl/);
  const end=pi(40,'stop'); delete end.message.usage.cost;
  s=await session(root,'pi',[piHead(root),user(10),end]); assert.equal(measure(s,r)[0].cost_usd,null);
  const bad=pi(40,'stop'); bad.message.usage.input=-1;
  s=await session(root,'pi',[piHead(root),user(10),bad]); assert.throws(()=>measure(s,r),/invalid_pi_usage/);
  const cr={...r,agent:'codex'};
  s=await session(root,'codex',[codexHead(root),ev(1,'task_started',{turn_id:'old'}),ev(2,'task_complete',{turn_id:'old'}),ev(10,'task_started',{turn_id:'new'}),count(40,20,2),ev(41,'task_complete',{turn_id:'new'})]);
  assert.throws(()=>measure(s,cr),/missing_baseline/);
});
test('worktree cwd, unrelated newer sessions, subagents, history and same-millisecond ambiguity',async t=>{
  const root=await temp(t), work=path.join(root,'work'); await fs.mkdir(work);
  const r=extract({...task(root,[launch(1,5,'codex'),delivery(2,30)]),checkout:{kind:'worktree',path:'work'}},root);
  const rows=[codexHead(work),ev(10,'task_started',{turn_id:'a'}),count(40,20,2),ev(41,'task_complete',{turn_id:'a'})];
  const good=await session(root,'codex',rows,'old.jsonl');
  const other=await session(root,'codex',[codexHead(root),...rows.slice(1)],'new.jsonl');
  const subhead=codexHead(work);subhead.payload.parent_thread_id='parent';
  const sub=await session(root,'codex',[subhead,...rows.slice(1)],'sub.jsonl');
  assert.equal(attribute(r,[good,other,sub])[0].reason,undefined);
  const copy=await session(root,'codex',rows,'copy.jsonl'); assert.equal(attribute(r,[good,copy])[0].reason,'ambiguous_sessions');
  const competing=extract(task(root,[launch(1,5,'codex'),delivery(2,30)],'two'),root); competing[0].cwd=work;
  assert.deepEqual(attribute([...r,...competing],[good]).map(x=>x.reason),['overlapping_rounds','overlapping_rounds']);
});
test('missing launch/route, identity conflict and repeated launches never fabricate rounds',()=>{
  const root='/tmp/x', versions=[delivery(1,2),launch(2,3),launch(3,4),delivery(4,5),launch(5,6),{...delivery(6,7),agent:'codex'}];
  assert.deepEqual(extract(task(root,versions),root).map(r=>r.problem),['missing_launch','superseded_launch','agent_conflict']);
  const l=launch(1,1);delete l.payload.launch.route;
  assert.equal(extract(task(root,[l,delivery(2,3)]),root)[0].problem,'missing_route');
});
test('audit agent labels canonicalize registered IDs on both sides, preserving unknown identities',()=>{
  const root='/tmp/x';
  for (const [marker,label,expected] of [['codex','Codex','codex'],['CoDeX','codex','codex'],['PI','Pi','pi']]) {
    for (const legacy of [false,true]) {
      const l=launch(1,5,marker);
      if (legacy) l.payload.launch.route=marker+' --model fixture';
      const [round]=extract(task(root,[l,{...delivery(2,30),agent:label}]),root);
      assert.equal(round.problem,undefined);
      assert.equal(round.agent,expected);
    }
  }
  for (const [marker,label] of [['codex','pi'],['codex','Claude'],['Unknown','unknown'],['/opt/bin/Codex','/opt/bin/codex'],['binding:Worker','binding:worker']]) {
    const [round]=extract(task(root,[launch(1,5,marker),{...delivery(2,30),agent:label}]),root);
    assert.equal(round.problem,'agent_conflict');
    assert.equal(round.agent,marker);
  }
  const [missing]=extract(task(root,[{...delivery(1,30),agent:'Codex'}]),root);
  assert.equal(missing.agent,'codex');assert.equal(missing.problem,'missing_launch');
});
test('audit normalization uses workspace registry IDs and respects invalid overrides',async t=>{
  const root=await temp(t),dir=path.join(root,'.context-hub','agents');await fs.mkdir(dir);
  const {agentProfiles,profileArtifact}=await import('../../../dist/agents/public/transition.js');
  const profile=JSON.parse(profileArtifact(agentProfiles.get('codex')));
  profile.id='custom-meter';profile.match.supported_executable_names=['meter-cli'];profile.match.platform_target_identity=null;
  const history=task(root,[launch(1,5,'custom-meter'),{...delivery(2,30),agent:'Custom-Meter'}]);
  assert.equal(extract(history,root)[0].problem,'agent_conflict');
  const file=path.join(dir,'custom-meter.json');await fs.writeFile(file,JSON.stringify(profile));
  const [round]=extract(history,root);assert.equal(round.problem,undefined);assert.equal(round.agent,'custom-meter');
  history.versions[1].agent='METER-CLI';
  assert.equal(extract(history,root)[0].problem,'agent_conflict'); // executable aliases are not profile IDs
  await fs.writeFile(file,JSON.stringify({id:'custom-meter'}));history.versions[1].agent='Custom-Meter';
  assert.equal(extract(history,root)[0].problem,'agent_conflict');
});
test('case-insensitive agent label replay counts both Codex reviewer deliveries and clears prior agent conflicts',async t=>{
  const root=await temp(t),store=new Store(path.join(root,'.context-hub'));await store.whenSwept;
  const {task_id:id}=await store.createTask({title:'agent label replay reviewer',description:'Protocol regression.',creator:'test',role:'human',flow:'direct'});
  const history=task(root,[launch(8,5,'codex','reviewer'),{...delivery(9,30,'reviewer'),agent:'Codex'},
    launch(14,50,'codex','reviewer'),{...delivery(15,70,'reviewer'),agent:'Codex'}],id);
  const before=structuredClone(history),rounds=extract(history,root);
  await writeUsage(root,id,merge(null,rounds.map(round=>({round,reason:'agent_conflict',candidates:[]}))));
  const dir=path.join(root,'codex');await fs.mkdir(dir);
  await session(dir,'codex',[codexHead(root),ev(10,'task_started',{turn_id:'first'}),count(40,150,20),ev(41,'task_complete',{turn_id:'first'}),
    ev(60,'task_started',{turn_id:'second'}),count(80,180,25),ev(81,'task_complete',{turn_id:'second'})]);
  const options={root,codexRoot:dir,piRoot:path.join(root,'no-pi')},deps={allowed:async()=>true,hub:{list:async()=>[{task_id:id}],read:async()=>history}};
  const [report]=await collect(options,deps);
  assert.deepEqual(report.total,{rounds:2,total_tokens:205,cost_usd:null,complete:true});
  const ledger=await loadUsage(path.join(root,'.context-hub','tasks',id));
  assert.deepEqual(ledger.rounds.map(r=>[r.delivery_version,r.agent,r.total_tokens]),[[9,'codex',170],[15,'codex',35]]);
  assert.deepEqual(ledger.unresolved,[]);assert.equal(ledger.schema_version,1);
  assert.equal((await collect({...options,watch:true},deps))[0].changed,false);
  assert.deepEqual(history,before);
});
const hlaunch=(v,n,agent='pi',role='executor')=>({...launch(v,n,agent,role),payload:{launch:{role,base_version:v-1,launch_mode:'headless',route:{agent,args:[]}}}});
test('headless supersession: delivering round stays measurable, replaced launches anchored unaccounted (tui unchanged)',async t=>{
  const root=await temp(t);
  const rounds=extract(task(root,[hlaunch(1,5),hlaunch(2,6),delivery(3,30)]),root);
  assert.equal(rounds[0].problem,undefined);
  assert.deepEqual(rounds[0].superseded_versions,[1]);
  // rescue chain: two replaced launches, newest launch delivers
  assert.deepEqual(extract(task(root,[hlaunch(1,5),hlaunch(2,6),hlaunch(3,7),delivery(4,30)]),root)[0].superseded_versions,[1,2]);
  // tui marker (no launch_mode): conservative whole-round diagnostic, zero change
  assert.equal(extract(task(root,[launch(1,5),launch(2,6),delivery(3,30)]),root)[0].problem,'superseded_launch');
  const s=await session(root,'pi',[piHead(root),user(10),pi(40,'stop')]);
  const [m]=attribute(rounds,[s]);
  assert.equal(m.reason,undefined);
  const value=validateUsage(merge(null,[m]));
  assert.equal(value.rounds.length,1);
  assert.equal(value.rounds[0].launch_version,2);
  assert.equal(value.rounds[0].total_tokens,37);
  assert.deepEqual(value.unresolved,[{delivery_version:3,launch_version:1,reason:'superseded_launch'}]);
  assert.equal(value.total.complete,false);// the replaced launch's work stays unaccounted
});
test('headless unmeasured delivering round still anchors its replaced launches',async t=>{
  const root=await temp(t);
  const rounds=extract(task(root,[hlaunch(1,5),hlaunch(2,6),delivery(3,30)]),root);
  const [m]=attribute(rounds,[]);// no sessions at all
  assert.equal(m.reason,'missing_session_or_end');
  const value=merge(null,[m]);
  assert.equal(value.rounds.length,0);
  assert.deepEqual(value.unresolved,[{delivery_version:3,launch_version:2,reason:'missing_session_or_end'},
    {delivery_version:3,launch_version:1,reason:'superseded_launch'}]);
});
test('only a launch before publication is superseded; note publication ends the replacement chain',async t=>{
  const root=await temp(t);
  const note=(v,n)=>({...delivery(v,n),content_type:'note'});
  const rounds=extract(task(root,[hlaunch(1,5),hlaunch(2,6),note(3,30),hlaunch(4,50),note(5,70)]),root);
  const s=await session(root,'pi',[piHead(root),user(10),pi(40,'stop'),user(60),pi(80,'stop')]);
  const value=validateUsage(merge(null,attribute(rounds,[s])));
  assert.deepEqual(value.rounds.map(r=>[r.launch_version,r.delivery_version,r.total_tokens]),[[2,3,37],[4,5,37]]);
  assert.deepEqual(value.unresolved,[{delivery_version:3,launch_version:1,reason:'superseded_launch'}]);
  assert.equal(value.total.complete,false);
});
test('cross-task shared-cwd concurrency and same-session double claim stay honestly unattributed',async t=>{
  const root=await temp(t);
  // 2026-10-18 shape: two headless tasks launched seconds apart in the SAME
  // rig-root cwd; each round sees both concurrent executor sessions.
  const a=extract(task(root,[hlaunch(1,5),delivery(2,70)],'task-a'),root);
  const b=extract(task(root,[hlaunch(1,6),delivery(2,60)],'task-b'),root);
  const sA=await session(root,'pi',[piHead(root),user(10),pi(80,'stop')],'a.jsonl');
  const sB=await session(root,'pi',[piHead(root),user(11),pi(81,'stop')],'b.jsonl');
  assert.deepEqual(attribute([...a,...b],[sA,sB]).map(x=>x.reason),['overlapping_rounds','overlapping_rounds']);
  // same-file shape: one session, two deliveries, both windows claim it
  const single=await session(root,'pi',[piHead(root),user(10),user(12),pi(50,'stop')],'c.jsonl');
  const two=extract(task(root,[hlaunch(1,5),delivery(2,30),hlaunch(3,11),delivery(4,40)],'task-c'),root);
  assert.deepEqual(attribute(two,[single]).map(x=>x.reason),['overlapping_rounds','overlapping_rounds']);
});
test('headless early exit without a native end: honest unresolved, ledger still lands (no completeness gating)',async t=>{
  const root=await temp(t),store=new Store(path.join(root,'.context-hub'));await store.whenSwept;
  const {task_id:id}=await store.createTask({title:'Early exit',description:'test',role:'human',creator:'test',flow:'direct'});
  await store.append(id,{role:'human',content_type:'note',payload:{summary:'launch',body:'test',launch:{role:'executor',base_version:0,launch_mode:'headless',route:{agent:'pi',args:[]}}}});
  await store.append(id,{role:'executor',content_type:'code_changes',payload:{summary:'done',body:'test'}});
  const task=await store.readTask(id),Lts=Date.parse(task.versions[0].timestamp),D=Date.parse(task.versions[1].timestamp);
  const piRoot=path.join(root,'pi'),cwdDir=path.join(piRoot,fixtureCwdDirectory(root));await fs.mkdir(cwdDir,{recursive:true});
  // executor died mid-work: kickoff covered, no assistant stop covering the delivery
  const rows=[piHead(root),user(10),pi(20,'toolUse')];
  rows[0].timestamp=new Date(Lts-100).toISOString();rows[1].timestamp=new Date(Lts).toISOString();rows[2].timestamp=new Date(D-1000).toISOString();
  await session(cwdDir,'pi',rows);
  const options={root,piRoot,codexRoot:path.join(root,'codex'),watch:false,intervalMs:5,timeoutMs:1000};
  const hub={list:()=>store.listTasks(),read:id=>store.readTask(id)};
  const [report]=await collect(options,{hub});
  assert.equal(report.total.rounds,0);
  assert.equal(report.unresolved[0].reason,'missing_session_or_end');
  // 写盘条件：有归账轮即写——zero resolved rounds never drops the whole ledger
  const v=await loadUsage(path.join(root,'.context-hub/tasks',id));
  assert.equal(v.rounds.length,0);
  assert.deepEqual(v.unresolved,[{delivery_version:2,launch_version:1,reason:'missing_session_or_end'}]);
  assert.equal(v.total.complete,false);
});
async function headlessFixture(t) {
  const root=await temp(t),lockFile=lockPath(canonicalRoot(root));
  t.after(async()=>{await fs.rm(lockFile,{force:true});await fs.rm(lockFile+'.reclaim',{recursive:true,force:true});});
  const store=new Store(path.join(root,'.context-hub'));await store.whenSwept;
  const {task_id:id}=await store.createTask({title:'Headless',description:'test',role:'human',creator:'test',flow:'direct'});
  await store.append(id,{role:'human',content_type:'note',payload:{summary:'rescue launch',body:'test',launch:{role:'executor',base_version:0,launch_mode:'headless',route:{agent:'pi',args:[]}}}});
  await store.append(id,{role:'human',content_type:'note',payload:{summary:'launch',body:'test',launch:{role:'executor',base_version:1,launch_mode:'headless',route:{agent:'pi',args:[]}}}});
  await store.append(id,{role:'executor',content_type:'code_changes',payload:{summary:'done',body:'test'}});
  const task=await store.readTask(id),Lts=Date.parse(task.versions[1].timestamp),D=Date.parse(task.versions[2].timestamp);
  const piRoot=path.join(root,'pi'),cwdDir=path.join(piRoot,fixtureCwdDirectory(root));await fs.mkdir(cwdDir,{recursive:true});
  // real headless session shape: header cwd at the rig root, one kickoff user
  // message at the (winning) launch, assistant stop after the delivery
  const rows=[piHead(root),user(10),pi(40,'stop')];
  rows[0].timestamp=new Date(Lts-100).toISOString();rows[1].timestamp=new Date(Lts).toISOString();rows[2].timestamp=new Date(D+100).toISOString();
  await session(cwdDir,'pi',rows);
  const options={root,piRoot,codexRoot:path.join(root,'codex'),watch:false,intervalMs:5,timeoutMs:1000};
  return {root,id,options,hub:{list:()=>store.listTasks(),read:id=>store.readTask(id)},store};
}
test('headless session fixture: usage.json lands with the resolved rescue round plus honest superseded entry',async t=>{
  const f=await headlessFixture(t);
  const [report]=await collect(f.options,{hub:f.hub});
  assert.equal(report.changed,true);
  assert.equal(report.total.rounds,1);
  assert.equal(report.total.total_tokens,37);
  assert.deepEqual(report.unresolved,[{delivery_version:3,launch_version:1,reason:'superseded_launch'}]);
  const v=await loadUsage(path.join(f.root,'.context-hub/tasks',f.id));
  assert.equal(v.rounds[0].launch_version,2);
  assert.deepEqual(v.unresolved,[{delivery_version:3,launch_version:1,reason:'superseded_launch'}]);
  assert.equal(v.total.complete,false);
  // idempotent re-pass: byte and coverage stable
  const file=path.join(f.root,'.context-hub/tasks',f.id,'usage.json'),bytes=await fs.readFile(file,'utf8');
  await collect(f.options,{hub:f.hub});
  assert.equal(await fs.readFile(file,'utf8'),bytes);
});
test('--since replay keeps the superseded disclosure beside preserved successes',async t=>{
  const root=await temp(t);
  const rounds=extract(task(root,[hlaunch(1,5),hlaunch(2,6),delivery(3,30),hlaunch(4,50),delivery(5,70)]),root);
  const s=await session(root,'pi',[piHead(root),user(10),pi(40,'stop'),user(60),pi(80,'stop')]);
  const matches=attribute(rounds,[s]);
  assert.deepEqual(matches.map(m=>m.reason),[undefined,undefined]);
  const full=merge(null,matches);
  assert.equal(full.rounds.length,2);assert.equal(full.total.total_tokens,74);
  assert.deepEqual(full.unresolved,[{delivery_version:3,launch_version:1,reason:'superseded_launch'}]);
  assert.equal(full.total.complete,false);
  // cutoff between D3 and D5: the older rescue round stays preserved; its
  // replaced launch's disclosure must survive and complete must stay false
  const later=merge(full,matches,Date.parse(T(50)));
  assert.equal(later.rounds.length,2);assert.equal(later.total.total_tokens,74);
  assert.deepEqual(later.unresolved,[{delivery_version:3,launch_version:1,reason:'superseded_launch'}]);
  assert.equal(later.total.complete,false);
  assert.deepEqual(merge(full,matches,Date.parse(T(50))),later);// repeated runs stable
});
test('cross-mode shared session leaves tui attribution identical to the parent; the headless rescue absorbs the conflict',async t=>{
  const root=await temp(t);
  const s=await session(root,'pi',[piHead(root),user(10),pi(40,'stop')]);
  const headless=extract(task(root,[hlaunch(1,5),hlaunch(2,6),delivery(3,30)],'task-h'),root);
  const tui=extract(task(root,[launch(1,5),delivery(2,30)],'task-t'),root);
  const [h,m]=attribute([...headless,...tui],[s]);
  // tui keeps the parent commit's exact outcome: unique candidate, measured
  assert.equal(m.reason,undefined);
  assert.equal(m.candidates.length,1);
  assert.equal(m.candidates[0].total_tokens,37);
  // the newly measurable headless rescue round absorbs the collision alone
  assert.equal(h.reason,'overlapping_rounds');
  const tuiValue=validateUsage(merge(null,[m]));
  assert.equal(tuiValue.total.rounds,1);assert.equal(tuiValue.total.total_tokens,37);
  assert.deepEqual(tuiValue.unresolved,[]);assert.equal(tuiValue.total.complete,true);
  const headlessValue=merge(null,[h]);
  assert.equal(headlessValue.rounds.length,0);// no fabricated accounting
  assert.deepEqual(headlessValue.unresolved,[{delivery_version:3,launch_version:2,reason:'overlapping_rounds'},
    {delivery_version:3,launch_version:1,reason:'superseded_launch'}]);
  assert.equal(headlessValue.total.complete,false);
});
test('configuration default is off, key-preserving on/off writes and invalid explicit values',async t=>{
  const root=await temp(t), storage=path.join(root,'.context-hub');
  assert.equal(await enabled(root),false); assert.equal((await readConfigFile(storage)).status,'missing');
  assert.equal(parseConfigValue('usage_audit','yes').ok,false);
  await writeConfigKey(storage,{key:'usage_audit',value:'on'}); assert.equal(await enabled(root),true);
  await writeConfigKey(storage,{key:'auto.remediate',value:'off'});assert.equal(await enabled(root),true);
  await writeConfigKey(storage,{key:'usage_audit',value:'off'});assert.equal(await enabled(root),false);
  await fs.writeFile(path.join(storage,'config.json'),'{'); await assert.rejects(enabled(root),/invalid_config/);
});
test('watch off performs zero measurement calls, no lock; on→off halts before collecting',async t=>{
  const root=await temp(t);let calls=0;
  await run({root,watch:true},{lock:()=>{calls++;throw Error('lock');},collect:()=>{calls++;}});
  assert.equal(calls,0); await assert.rejects(fs.stat(lockPath(root)),{code:'ENOENT'});
  let checks=0,released=0;
  await run({root,watch:true},{enabled:async()=>++checks===1,lock:async()=>async()=>released++,collect:async()=>{calls++;}});
  assert.equal(calls,0);assert.equal(released,1);
});
async function fixture(t) {
  const root=await temp(t);
  const lockFile=lockPath(canonicalRoot(root));
  t.after(async () => {
    await fs.rm(lockFile,{force:true});
    await fs.rm(lockFile+'.cursor.json',{force:true});
    await fs.rm(lockFile+'.reclaim',{recursive:true,force:true});
  });
  const store=new Store(path.join(root,'.context-hub'));await store.whenSwept;
  const {task_id:id}=await store.createTask({title:'One',description:'test',role:'human',creator:'test',flow:'direct'});
  await store.append(id,{role:'human',content_type:'note',payload:{summary:'launch',body:'test',launch:{role:'executor',base_version:0,route:{agent:'pi',args:[]}}}});
  await store.append(id,{role:'executor',content_type:'code_changes',payload:{summary:'done',body:'test'}});
  const task=await store.readTask(id),Lts=Date.parse(task.versions[0].timestamp),D=Date.parse(task.versions[1].timestamp);
  const piRoot=path.join(root,'pi'),cwdDir=path.join(piRoot,fixtureCwdDirectory(root));await fs.mkdir(cwdDir,{recursive:true});
  const rows=[piHead(root),user(10),pi(40,'stop')]; rows[0].timestamp=new Date(Lts-100).toISOString();rows[1].timestamp=new Date(Lts).toISOString();rows[2].timestamp=new Date(D+100).toISOString();
  const s=await session(cwdDir,'pi',rows);
  const options={root,piRoot,codexRoot:path.join(root,'codex'),watch:false,intervalMs:5,timeoutMs:1000};
  const hub={list:()=>store.listTasks(),read:id=>store.readTask(id)};
  return {root,store,id,options,hub,s,rows,cwdDir};
}
test('first poll sees existing delivery; restart/backfill is byte and mtime stable; Store never consumes usage',async t=>{
  const f=await fixture(t),before=await f.store.readTask(f.id),state=await f.store.listTasks();
  await collect(f.options,{hub:f.hub});
  const dir=path.join(f.root,'.context-hub/tasks',f.id),file=path.join(dir,'usage.json');
  const bytes=await fs.readFile(file,'utf8'),mtime=(await fs.stat(file)).mtimeMs;
  assert.equal(JSON.parse(bytes).total.total_tokens,37);
  await collect(f.options,{hub:f.hub});assert.equal(await fs.readFile(file,'utf8'),bytes);assert.equal((await fs.stat(file)).mtimeMs,mtime);
  await collect({...f.options,since:Date.now()+10000},{hub:f.hub});assert.equal(await fs.readFile(file,'utf8'),bytes);
  assert.deepEqual(await f.store.readTask(f.id),before);assert.deepEqual(await f.store.listTasks(),state);
  await fs.writeFile(file,'broken usage'); assert.deepEqual(await f.store.readTask(f.id),before);assert.deepEqual(await f.store.listTasks(),state);
  await assert.rejects(collect(f.options,{hub:f.hub}));assert.equal(await fs.readFile(file,'utf8'),'broken usage');
  assert.deepEqual((await f.store.snapshotTasks()).degraded,[]); // usage.json sidecar: Store stays degrade-free (contract)
});
test('half-line completes on next poll; missing file preserves old cost with unresolved diagnostic',async t=>{
  const f=await fixture(t);await fs.appendFile(f.s.file,'{"');
  await collect(f.options,{hub:f.hub});let v=await loadUsage(path.join(f.root,'.context-hub/tasks',f.id));assert.equal(v.rounds.length,0);
  await session(f.cwdDir,'pi',f.rows);await collect(f.options,{hub:f.hub});v=await loadUsage(path.join(f.root,'.context-hub/tasks',f.id));assert.equal(v.rounds.length,1);
  await fs.unlink(f.s.file);await collect(f.options,{hub:f.hub});v=await loadUsage(path.join(f.root,'.context-hub/tasks',f.id));assert.equal(v.rounds.length,1);assert.equal(v.total.complete,false);assert.equal(v.unresolved[0].preserved,true);
});
test('atomic rename failure and shutdown before commit preserve original, clean only own tmp; symlinks refused',async t=>{
  const f=await fixture(t);await collect(f.options,{hub:f.hub});const dir=path.join(f.root,'.context-hub/tasks',f.id),file=path.join(dir,'usage.json');
  const bytes=await fs.readFile(file,'utf8'),v=JSON.parse(bytes);v.rounds[0].cost_usd=0.5;v.total.cost_usd=0.5;
  await assert.rejects(writeUsage(f.root,f.id,v,async()=>true,async()=>{throw Error('rename injected');}),/rename injected/);
  assert.equal(await fs.readFile(file,'utf8'),bytes);assert.deepEqual((await fs.readdir(dir)).filter(x=>x.endsWith('.tmp')),[]);
  let checks=0; await writeUsage(f.root,f.id,v,async()=>++checks===1);assert.equal(await fs.readFile(file,'utf8'),bytes);
  await fs.rename(file,path.join(dir,'saved'));await fs.symlink(path.join(dir,'saved'),file);await assert.rejects(writeUsage(f.root,f.id,v),/unsafe_usage_file/);
});
test('since retains other successful rounds while backfill corrects selected rounds and null total costs',()=>{
  const r={round:1,role:'executor',agent:'pi',launch_version:1,delivery_version:2,ts:T(30)};
  const a={round:r,candidates:[{input_tokens:1,output_tokens:1,total_tokens:2,cost_usd:1}]};
  const b={round:{...r,round:2,launch_version:3,delivery_version:4,ts:T(60)},candidates:[{input_tokens:2,output_tokens:2,total_tokens:4,cost_usd:null}]};
  const previous=merge(null,[a],undefined),v=merge(previous,[a,b],Date.parse(T(50)));assert.equal(v.rounds.length,2);assert.equal(v.total.total_tokens,6);assert.equal(v.total.cost_usd,null);
});
test('real Hub root identity required; HTTP read remains state-neutral with usage',async t=>{
  const f=await fixture(t),server=await startServer({root:path.join(f.root,'.context-hub'),port:0});t.after(()=>server.close());
  const hub=await source(server.url,f.root);const before=await hub.read(f.id);
  await assert.rejects(source(server.url,path.join(f.root,'foreign')),/hub_root_mismatch/);
  await collect({...f.options,url:server.url});assert.deepEqual(await hub.read(f.id),before);
});
test('watch process owns shared lock; second backfill process fails; SIGTERM releases lock',async t=>{
  const f=await fixture(t),server=await startServer({root:path.join(f.root,'.context-hub'),port:0});t.after(()=>server.close());
  await writeConfigKey(path.join(f.root,'.context-hub'),{key:'usage_audit',value:'on'});
  const args=['scripts/usage-audit/run.mjs','--root',f.root,'--url',server.url,'--pi-root',f.options.piRoot,'--codex-root',f.options.codexRoot];
  const child=spawn(process.execPath,[...args,'--watch','--interval-ms','20'],{stdio:['ignore','pipe','pipe']});t.after(()=>child.kill());
  await once(child.stdout,'data');
  const second=spawn(process.execPath,[...args,'--backfill'],{stdio:['ignore','pipe','pipe']});let stderr='';second.stderr.on('data',b=>stderr+=b);const [code]=await once(second,'exit');assert.equal(code,1);assert.match(stderr,/audit_locked/);
  const exited=once(child,'exit');
  // Windows kill() is force termination, not delivery of POSIX SIGTERM.
  // Exercise normal watcher shutdown via its real on→off config instead.
  if(process.platform==='win32')await writeConfigKey(path.join(f.root,'.context-hub'),{key:'usage_audit',value:'off'});
  else child.kill('SIGTERM');
  const [exitCode]=await exited;if(process.platform==='win32')assert.equal(exitCode,0);
  await assert.rejects(fs.stat(lockPath(f.root)),{code:'ENOENT'});
});
test('CLI rejects bad modes, unknown options and invalid dates',()=>{
  for (const args of [[],['--wat'],['--watch','--backfill'],['--since','yesterday'],['--since','2026-02-30T00:00:00Z'],['--watch','--interval-ms','0']]) assert.throws(()=>parse(args));
  assert.equal(parse(['--since',T(1)]).since,Date.parse(T(1)));
});

// A minimal HTTP peer lets each wait (including an unfinished response body)
// fail independently. The rescue closes old-code hangs so red runs finish.
async function auditPeer(t, root, intercept = () => false, tasks = []) {
  const server=createServer(async (req,res)=>{
    if (req.method==='GET' && req.url!=='/state') { res.writeHead(405).end(); return; }
    let body=''; for await (const chunk of req) body+=chunk;
    const message=body ? JSON.parse(body) : {};
    const phase=req.url==='/state' ? 'state' : message.params?.name ?? message.method;
    if (intercept(phase,res)) return;
    if (phase==='state') { res.setHeader('Content-Type','application/json');res.end(JSON.stringify({hub_root:root}));return; }
    if (phase==='notifications/initialized') { res.writeHead(202).end();return; }
    const result=phase==='initialize'
      ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}
      : {content:[{type:'text',text:JSON.stringify(phase==='context.list' ? {tasks} : {task_id:'one',versions:[]})}]};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}

test('audit request timeout defaults to 30s, accepts env override and rejects unsafe timer values',()=>{
  assert.equal(parse(['--backfill'],{}).requestTimeoutMs,30000);
  assert.equal(parse(['--watch'],{TUT_USAGE_AUDIT_TIMEOUT_MS:'45'}).requestTimeoutMs,45);
  for (const value of ['', '0','-1','NaN','1.5','2147483648']) {
    assert.throws(()=>parse(['--backfill'],{TUT_USAGE_AUDIT_TIMEOUT_MS:value}),/TUT_USAGE_AUDIT_TIMEOUT_MS/);
  }
});

for (const phase of ['state','initialize','notifications/initialized','context.list','context.read']) {
  // Notifications have no reply body: the SDK cancels it without reading.
  for (const partial of phase==='notifications/initialized' ? [false] : [false,true]) test(`audit timeout aborts ${phase} waiting for ${partial?'body':'headers'}`,async t=>{
    const root=await temp(t),states=[];
    const url=await auditPeer(t,root,(current,res)=>{
      if(current!==phase)return false;
      if(partial){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');}
      const rescue=setTimeout(()=>res.destroy(),700);res.on('close',()=>clearTimeout(rescue));
      return true;
    });
    const start=Date.now();
    await assert.rejects(async()=>{
      const hub=await source(url,root,{requestTimeoutMs:60,onRequest:value=>states.push(value)});
      if(phase==='context.read')await hub.read('one');else await hub.list();
    },/HUB_TIMEOUT.*60ms/);
    assert.ok(Date.now()-start<500,'request must finish at the audit deadline');
    assert.equal(states[0],true);assert.equal(states.at(-1),false);
  });
}

test('audit timeout aborts an MCP SSE response that never delivers its RPC result',async t=>{
  const root=await temp(t);
  const url=await auditPeer(t,root,(phase,res)=>{
    if(phase!=='context.list')return false;
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': still waiting\n\n');
    const rescue=setTimeout(()=>res.destroy(),700);res.on('close',()=>clearTimeout(rescue));return true;
  });
  const hub=await source(url,root,{requestTimeoutMs:60});
  await assert.rejects(hub.list(),/HUB_TIMEOUT.*60ms/);
});

for (const entry of ['collect', 'run']) for (const phase of ['context.list', 'context.read']) {
  for (const response of ['headers', 'body', 'sse']) test(`${entry} preserves Hub timeout classification and aborts ${phase} stalled at ${response}`, async t => {
    const root = await temp(t), ac = new AbortController(), lines = [], progress = [];
    let intercepted = false, rescued = false, closed;
    const disconnected = new Promise(resolve => { closed = resolve; });
    const url = await auditPeer(t, root, (current, res) => {
      if (current !== phase || intercepted) return false;
      intercepted = true;
      if (response === 'body') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); }
      if (response === 'sse') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': waiting\n\n'); }
      const rescue = setTimeout(() => { rescued = true; res.destroy(); }, 1000);
      res.on('close', () => { clearTimeout(rescue); closed(); });
      return true;
    }, [{ task_id: 'one' }]);
    const options = { root, url, watch: entry === 'run', requestTimeoutMs: 60, intervalMs: 5, timeoutMs: 2000,
      signal: ac.signal, onProgress: value => progress.push(value) };
    const expected = `HUB_TIMEOUT:${url}/mcp: read exceeded 60ms`;
    if (entry === 'collect') {
      await assert.rejects(collect(options), error => { assert.equal(error.message, expected); return true; });
      assert.ok(progress.includes(phase === 'context.list' ? 'hub-list' : 'hub-read'));
    } else {
      const original = process.stderr.write;
      process.stderr.write = text => { lines.push(String(text)); return true; };
      let passes = 0;
      try {
        await run(options, { enabled: async () => true, report: () => { passes++; ac.abort(); } });
      } finally { process.stderr.write = original; }
      assert.equal(passes, 1, 'watch must retry the failed Hub read and complete a later pass');
      assert.ok(lines.some(line => line.includes(`pass failed (${expected})`)));
      assert.ok(lines.every(line => !line.includes('LOCAL_IO_TIMEOUT')), 'network waits must not be diagnosed as local filesystem waits');
    }
    await disconnected;
    assert.equal(rescued, false, 'the Hub deadline must close the underlying network read before test rescue');
  });
}

test('watch survives HTTP timeouts, retries at its interval and later completes a pass',async t=>{
  const root=await temp(t),ac=new AbortController(),lines=[],waits=[];let attempts=0,passes=0;
  const url=await auditPeer(t,root,(phase,res)=>{
    if(phase!=='state'||++attempts>2)return false;
    const rescue=setTimeout(()=>res.destroy(),700);res.on('close',()=>clearTimeout(rescue));return true;
  });
  const original=process.stderr.write;process.stderr.write=b=>{lines.push(String(b));return true;};
  try {
    await run({root,url,watch:true,requestTimeoutMs:40,intervalMs:7,timeoutMs:3000,signal:ac.signal},
      {enabled:async()=>true,sleep:async ms=>{waits.push(ms);},report:()=>{passes++;ac.abort();}});
  } finally {process.stderr.write=original;}
  assert.equal(passes,1);assert.equal(attempts,3);assert.equal(waits.length,2);assert.ok(waits.every(ms=>ms>=30&&ms<3000));
  assert.equal(lines.filter(l=>l.includes('pass failed')).length,1);
  assert.match(lines.join(''),/HUB_TIMEOUT/);
  await assert.rejects(fs.stat(lockPath(root)),{code:'ENOENT'});
});

test('ten consecutive HTTP read timeouts reach the same terminal threshold with endpoint evidence',async t=>{
  const root=await temp(t),lines=[];let attempts=0;
  const url=await auditPeer(t,root,(phase,res)=>{
    if(phase!=='state')return false;
    attempts++;
    const rescue=setTimeout(()=>res.destroy(),700);res.on('close',()=>clearTimeout(rescue));return true;
  });
  const original=process.stderr.write;process.stderr.write=b=>{lines.push(String(b));return true;};
  try {
    await assert.rejects(run({root,url,watch:true,requestTimeoutMs:40,intervalMs:1},
      {enabled:async()=>true}),{code:'WATCHER_TIMEOUT_LIMIT'});
  } finally {process.stderr.write=original;}
  assert.equal(attempts,10);
  const events=lines.filter(l=>l.startsWith('{')).map(JSON.parse);
  const stalls=events.filter(e=>e.event==='IO_STALLED');
  assert.equal(stalls.length,10);
  assert.ok(stalls.every(e=>e.code==='HUB_TIMEOUT'&&e.target===`${url}/state`&&e.elapsed_ms>=39));
  assert.equal(events.at(-1).event,'WATCHER_TIMEOUT_LIMIT');
  await assert.rejects(fs.stat(lockPath(root)),{code:'ENOENT'});
});

test('watch heartbeat runs every 60s during a pending request and reports success and consecutive failures',async t=>{
  const root=await temp(t),ac=new AbortController(),lines=[];let tick,cleared=0,passes=0;
  const original=process.stderr.write;process.stderr.write=b=>{lines.push(String(b));return true;};
  try {
    await run({root,watch:true,intervalMs:1,timeoutMs:Infinity,signal:ac.signal},{
      logHeartbeat:line=>lines.push(line),enabled:async()=>true,report:()=>{},
      setInterval:(fn,ms)=>{assert.equal(ms,60000);tick=fn;return 42;},
      clearInterval:id=>{assert.equal(id,42);cleared++;},
      collect:async options=>{
        assert.equal(typeof tick,'function');
        options.onRequest(true);tick();await Promise.resolve();options.onRequest(false);
        if(++passes===1)throw Error('first failure');
        if(passes===2)throw Error('different failure');
        return [];
      },
      sleep:async()=>{tick();if(passes===3)ac.abort();},
    });
  } finally {process.stderr.write=original;}
  const beats=lines.filter(l=>l.startsWith('{')).map(JSON.parse).filter(b=>b.event==='heartbeat');
  assert.equal(beats.length,6);assert.equal(cleared,1);
  assert.deepEqual(beats.map(b=>b.in_request),[true,false,true,false,true,false]);
  assert.deepEqual(beats.map(b=>b.consecutive_failures),[0,1,1,2,2,0]);
  assert.ok(beats.every(b=>b.event==='heartbeat'&&Number.isFinite(Date.parse(b.timestamp))));
  assert.equal(beats[0].last_successful_pass,null);
  assert.ok(Number.isFinite(Date.parse(beats.at(-1).last_successful_pass)));
});

test('healthy heartbeats accumulate in the managed file for three simulated minutes without terminal output', async t => {
  const root = await temp(t), ac = new AbortController(), terminal = [];
  let tick, clock = Date.now(), sleeps = 0;
  t.mock.method(Date, 'now', () => clock);
  const original = process.stderr.write;
  process.stderr.write = line => { terminal.push(String(line)); return true; };
  const close = installServiceLog(path.join(root, '.context-hub'), 'usage-audit.log');
  try {
    await run({ root, watch: true, intervalMs: 60_000, signal: ac.signal }, {
      enabled: async () => true, collect: async () => [], report: () => {},
      setInterval: (fn, ms) => { assert.equal(ms, 60_000); tick = fn; },
      sleep: async () => { clock += 60_000; tick(); if (++sleeps === 3) ac.abort(); },
    });
  } finally { await close(); process.stderr.write = original; }
  assert.deepEqual(terminal, []);
  const events = (await fs.readFile(path.join(root, '.context-hub/logs/diagnostics/usage-audit.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 3);
  assert.ok(events.every(e => e.event === 'heartbeat' && !e.stalled && !e.success_overdue && e.consecutive_failures === 0));
  assert.equal(Date.parse(events.at(-1).timestamp) - Date.parse(events[0].timestamp), 120_000);
});

test('heartbeat alarms deduplicate health flags, combine simultaneous anomalies and rearm after recovery', async t => {
  const root = await temp(t), ac = new AbortController(), terminal = [], beats = [];
  const now = Date.now(); let clock = now, tick, passes = 0, progress;
  t.mock.method(Date, 'now', () => clock);
  const original = process.stderr.write;
  process.stderr.write = line => { terminal.push(String(line)); return true; };
  try {
    await run({ root, watch: true, intervalMs: 1, signal: ac.signal }, {
      enabled: async () => true, report: () => {}, logHeartbeat: line => beats.push(JSON.parse(line)),
      setInterval: fn => { tick = fn; },
      collect: async options => {
        passes++; progress = options.onProgress;
        if (passes === 5) {
          progress('hub-read'); clock += 180_000; tick(); tick();
          // Recovery starts a new success clock before the next failure.
          clock = now;
        }
        if ([2, 3, 4, 6].includes(passes)) throw Error('same transient failure');
        return [];
      },
      sleep: async () => {
        if (passes === 4) { clock += 180_000; progress('scan'); }
        tick(); tick();
        if (passes === 6) ac.abort();
      },
    });
  } finally { process.stderr.write = original; }
  const alarms = terminal.filter(l => l.startsWith('{')).map(JSON.parse);
  assert.deepEqual(alarms.map(e => e.event), ['PASS_FAILED', 'PASS_SUCCESS_OVERDUE', 'PASS_STALLED', 'PASS_FAILED']);
  assert.equal(alarms[2].stalled, true); assert.equal(alarms[2].success_overdue, true);
  assert.deepEqual(alarms.map(e => e.consecutive_failures), [1, 3, 3, 1]);
  assert.ok(beats.length > alarms.length);
  assert.ok(beats.every(e => e.event === 'heartbeat'));
  assert.ok(!terminal.some(l => l.includes('"event":"heartbeat"')));
});

test('report failure does not claim a successful pass or reset failure telemetry; releases heartbeat and lock',async t=>{
  const root=await temp(t),lines=[];let tick,passes=0,cleared=0;
  const original=process.stderr.write;process.stderr.write=b=>{lines.push(String(b));return true;};
  try {
    await assert.rejects(run({root,watch:true,intervalMs:1,timeoutMs:Infinity},{
      logHeartbeat:line=>lines.push(line),enabled:async()=>true,
      setInterval:fn=>{tick=fn;return 42;},
      clearInterval:id=>{assert.equal(id,42);tick();cleared++;},
      collect:async()=>{if(++passes===1)throw Error('collect failed');return [];},
      sleep:async()=>{},
      report:()=>{throw Error('EPIPE');},
    }),/EPIPE/);
  } finally {process.stderr.write=original;}
  const beat=JSON.parse(lines.find(l=>l.startsWith('{')&&JSON.parse(l).event==='heartbeat'));
  assert.equal(beat.last_successful_pass,null);
  assert.equal(beat.consecutive_failures,1);
  assert.equal(cleared,1);
  await assert.rejects(fs.stat(lockPath(root)),{code:'ENOENT'});
});

test('heartbeat timer is absent outside enabled watch and cleared on fatal configuration failure',async t=>{
  const root=await temp(t);let timers=0,clears=0,checks=0;
  const deps={setInterval:()=>++timers,clearInterval:()=>clears++,collect:async()=>[],report:()=>{}};
  await run({root,watch:false},deps);
  await run({root,watch:true},{...deps,enabled:async()=>false});
  assert.equal(timers,0);
  await assert.rejects(run({root,watch:true},{...deps,enabled:async()=>{if(++checks>1)throw Error('bad config');return true;}}),/bad config/);
  assert.equal(timers,1);assert.equal(clears,1);
  await assert.rejects(fs.stat(lockPath(root)),{code:'ENOENT'});
});

async function auditCommand(args, env={}) {
  const child=spawn(process.execPath,['scripts/usage-audit/run.mjs',...args],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const [code]=await once(child,'close');return {code,stdout,stderr};
}
test('recover reports dead owner, backfills selected task while off, then recommends watch; no-lock rerun is stable',async t=>{
  const f=await fixture(t),server=await startServer({root:path.join(f.root,'.context-hub'),port:0});t.after(()=>server.close());
  const {task_id:other}=await f.store.createTask({title:'Other',description:'test',role:'human',creator:'test'});
  const file=lockPath(f.root);t.after(()=>fs.rm(file,{force:true}));
  await fs.writeFile(file,JSON.stringify({pid:99999999,root:f.root}));
  const args=['--recover','--task',f.id,'--root',f.root,'--url',server.url,'--pi-root',f.options.piRoot,'--codex-root',f.options.codexRoot];
  const first=await auditCommand(args);assert.equal(first.code,0,first.stderr);
  assert.match(first.stderr,/99999999/);assert.match(first.stderr,/dead/);assert.match(first.stderr,/--watch/);
  assert.deepEqual(first.stdout.trim().split('\n').map(JSON.parse).map(r=>r.task_id),[f.id]);
  const dir=path.join(f.root,'.context-hub/tasks',f.id),snapshot=await loadUsage(dir);
  assert.equal(snapshot.schema_version,1);assert.equal(snapshot.total.total_tokens,37);
  assert.equal(await loadUsage(path.join(f.root,'.context-hub/tasks',other)),null);
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
  const mtime=(await fs.stat(path.join(dir,'usage.json'))).mtimeMs;
  const again=await auditCommand(args);assert.equal(again.code,0,again.stderr);assert.match(again.stderr,/absent/);
  assert.equal((await fs.stat(path.join(dir,'usage.json'))).mtimeMs,mtime);
});
test('recover refuses live and unidentifiable owners without touching lock or reading Hub',async t=>{
  const root=await temp(t),file=lockPath(root);t.after(()=>fs.rm(file,{force:true}));
  for(const bytes of [JSON.stringify({pid:process.pid,root}),'{',JSON.stringify({pid:-1})]){
    await fs.writeFile(file,bytes);
    const result=await auditCommand(['--recover','--root',root,'--url','http://127.0.0.1:1']);
    assert.equal(result.code,1);assert.match(result.stderr,/audit_locked/);
    assert.match(result.stderr,/alive|unknown/);assert.doesNotMatch(result.stderr,/backfill complete/);
    if(bytes.includes(String(process.pid)))assert.match(result.stderr,new RegExp(String(process.pid)));
    assert.equal(await fs.readFile(file,'utf8'),bytes);assert.equal(result.stdout,'');
  }
});
test('recover releases its lock and emits no success advice when backfill fails',async t=>{
  const root=await temp(t),file=lockPath(root);t.after(()=>fs.rm(file,{force:true}));
  await fs.writeFile(file,JSON.stringify({pid:99999999,root}));
  const url=await auditPeer(t,root,(_phase,res)=>{
    const rescue=setTimeout(()=>res.destroy(),700);res.on('close',()=>clearTimeout(rescue));return true;
  });
  const result=await auditCommand(['--recover','--root',root,'--url',url],{TUT_USAGE_AUDIT_TIMEOUT_MS:'60'});
  assert.equal(result.code,1);assert.match(result.stderr,/dead/);assert.doesNotMatch(result.stderr,/backfill complete/);
  assert.match(result.stderr,/HUB_TIMEOUT.*60ms/);
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
test('recover is an exclusive CLI mode and accepts optional task filtering',()=>{
  const options=parse(['--recover','--task','one']);assert.equal(options.recover,true);assert.equal(options.watch,false);assert.equal(options.task,'one');
  for(const other of [['--watch'],['--backfill'],['--since',T(1)],['--recover']])assert.throws(()=>parse(['--recover',...other]));
});

test('on→off during a pass stops measurement reads before session discovery',async t=>{
  const f=await fixture(t);let on=true,scans=0;
  await collect({...f.options,watch:true},{allowed:async()=>on,hub:{list:f.hub.list,read:async id=>{const value=await f.hub.read(id);on=false;return value;}},files:async()=>{scans++;return [];}});
  assert.equal(scans,0);await assert.rejects(fs.stat(path.join(f.root,'.context-hub/tasks',f.id,'usage.json')),{code:'ENOENT'});
});
test('unknown schema, null switch, invalid cost, unreadable candidates and unselected task competition fail visibly',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.root,'.context-hub/config.json'),JSON.stringify({flow_mode:'manual',usage_audit:null}));await assert.rejects(enabled(f.root),/invalid_usage_audit/);
  await fs.writeFile(path.join(f.cwdDir,'broken.jsonl'),'bad\n');await collect(f.options,{hub:f.hub});let v=await loadUsage(path.join(f.root,'.context-hub/tasks',f.id));assert.equal(v.unresolved[0].reason,'unreadable_session_candidate');
  await fs.unlink(path.join(f.cwdDir,'broken.jsonl'));
  const other={...await f.hub.read(f.id),task_id:'competitor'};
  await collect({...f.options,task:f.id},{hub:{list:async()=>[{task_id:f.id},{task_id:'competitor'}],read:async id=>id==='competitor'?other:f.hub.read(id)}});
  v=await loadUsage(path.join(f.root,'.context-hub/tasks',f.id));assert.equal(v.unresolved[0].reason,'overlapping_rounds');
  const file=path.join(f.root,'.context-hub/tasks',f.id,'usage.json');await fs.writeFile(file,'{"schema_version":2}');await assert.rejects(collect(f.options,{hub:f.hub}),/invalid_usage_schema/);assert.equal(await fs.readFile(file,'utf8'),'{"schema_version":2}');
});
test('default-off create→start-next→delivery uses normal product files and zero private-session/measurement I/O',async t=>{
  const root=await temp(t),server=await startServer({root:path.join(root,'.context-hub'),port:0});t.after(()=>server.close());
  const preload=path.join(root,'count.cjs'),log=path.join(root,'forbidden-io');
  await fs.writeFile(preload,`const fs=require('node:fs');const p=require('node:fs/promises');const append=fs.appendFileSync.bind(fs);const log=${JSON.stringify(log)};
for(const api of [fs,p])for(const key of ['readFile','readFileSync','readdir','readdirSync','open','openSync','writeFile','writeFileSync','stat','statSync','lstat','lstatSync','access','accessSync','rename','renameSync','mkdir','mkdirSync'])if(typeof api[key]==='function'){const original=api[key];api[key]=function(...args){const s=String(args[0]);if(/\\.(pi|codex)[/\\\\].*sessions|usage\\.json|tut-usage-audit-|\\.usage-/.test(s)){append(log,s+'\\n');throw Error('unexpected measurement I/O');}return original.apply(this,args);};}require('node:module').syncBuiltinESMExports();`);
  const cli=path.resolve('dist/cli.js'),bin=path.resolve('test/bin');
  // This dry-run has no Notifier; pin a dead fixture endpoint rather than
  // inherit a live event address or depend on discovery from its random Hub port.
  const env={...process.env,NODE_OPTIONS:`--require=${preload}`,PATH:`${bin}${path.delimiter}${process.env.PATH}`,TUT_HUB_ROOT:root,TUT_PROJECT_ROOT:root,TUT_USER_CONFIG_DIR:path.join(root,'user-config'),TUT_HUB_URL:server.url,TUT_EVENT_PORT_URL:'http://127.0.0.1:1/agent-event',TUT_HERDR_EXECUTABLE:path.join(bin,'herdr'),TUT_HERDR_PANES:'[]',TUT_DRY_RUN:'1'};
  async function command(args) {const child=spawn(process.execPath,[cli,...args],{cwd:root,env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const [code]=await once(child,'exit');assert.equal(code,0,err);return out;}
  await command(['create','--title','Off normal flow','--description','Isolated test','--creator','test','--role','human','--flow','direct','--cast','executor=pi','--url',server.url]);
  const hub=await source(server.url,root),entries=await hub.list(),id=entries.find(e=>e.task_id!=='project').task_id;
  await command(['start-next',id,'--url',server.url]);
  await command(['publish',id,'--role','executor','--content-type','code_changes','--summary','done','--body','Isolated test delivery','--url',server.url]);
  const result=await hub.read(id);assert.equal(result.versions.length,2);assert.equal(result.status,'reviewing');
  assert.deepEqual((await fs.readdir(path.join(root,'.context-hub/tasks',id))).sort(),['meta.json','v001.note.json','v002.code_changes.json']);
  await assert.rejects(fs.stat(log),{code:'ENOENT'});await assert.rejects(fs.stat(lockPath(root)),{code:'ENOENT'});
});

// Exercise the real read port and watcher with a mixed exact source. Only the
// bundled catalog selection and the native run-log I/O failure are substituted.
async function mixedRunLogFixture(t, failure) {
  const { agentProfiles, profileArtifact } = await import('../../../dist/agents/public/transition.js');
  const { RunStore } = await import('../../../dist/core/run/store.js');
  const root=await temp(t),store=new Store(path.join(root,'.context-hub'));await store.whenSwept;
  const bad=await store.createTask({title:'Mixed exact source',description:'test',creator:'test',role:'human',flow:'direct'});
  const other=await store.createTask({title:'Overlap source',description:'test',creator:'test',role:'human',flow:'direct'});
  const value=JSON.parse(profileArtifact(agentProfiles.get('codex')));
  value.usage.attribution='exact-session-window-v1';value.usage.source.header.id=['payload','id'];
  value.usage.source.roots.push({kind:'run-log',via:'RunStore',run_id:'round.run_id'});value.usage.capability.spec=structuredClone(value.usage.source);
  const peer=structuredClone(value);peer.id='pi';peer.match.supported_executable_names=['pi'];peer.match.platform_target_identity.win32='pi';peer.usage.attribution='legacy-cwd-window-v1';peer.usage.source.roots.pop();peer.usage.capability.spec=structuredClone(peer.usage.source);
  await fs.mkdir(path.join(root,'.context-hub','agents'),{recursive:true});
  for(const profile of [value,peer])await fs.writeFile(path.join(root,'.context-hub','agents',profile.id+'.json'),JSON.stringify(profile));
  const attempt='0ec82a6a-a166-4b1e-afc1-17667c629d30',runStore=new RunStore(root),runId=runStore.create();
  const route={agent:'codex',args:[]};
  await runStore.initialize(runId,{run_id:runId,task_id:bad.task_id,pid:2147483000,pgid:2147483000,supervisor_pid:2147482999,argv:['codex'],cwd:root,started_at:T(0),ended_at:T(40),status:'exited',exit_code:0,agent_session_id:'native',headless:{schema:1,role:'executor',attempt_id:attempt,base_version:0,trigger_version:0,route,route_source:'task-cast',session_reason:'test'}});
  const marker=launch(1,5,'codex');marker.payload.launch.attempt_id=attempt;
  const histories=[task(root,[marker,delivery(2,20)],bad.task_id)];
  const hub={list:async()=>histories.map(h=>({task_id:h.task_id})),read:async id=>histories.find(h=>h.task_id===id)};
  const dir=path.join(root,'native');await fs.mkdir(dir);
  await session(dir,'codex',[{...codexHead(root),payload:{...codexHead(root).payload,id:'native'}},ev(10,'task_started',{turn_id:'turn'}),count(20,7,3),ev(30,'task_complete',{turn_id:'turn'})]);
  let reads=0;const originalLog=RunStore.prototype.openLog;
  RunStore.prototype.openLog=function(){reads++;throw failure;};t.after(()=>{RunStore.prototype.openLog=originalLog;});
  return {root,bad,other,histories,hub,runId,reads:()=>reads,options:{root,codexRoot:dir},deps:{hub,runs:async()=>[runStore.read(runId)]},ledger:id=>loadUsage(path.join(root,'.context-hub','tasks',id))};
}
for(const code of ['EACCES','EIO'])test(`a later run-log ${code} keeps the file claim for overlap checks and prevents sole-candidate accounting`,async t=>{
  const failure=Object.assign(Error('native run-log unreadable'),{code}),f=await mixedRunLogFixture(t,failure);
  const reports=await collect(f.options,f.deps);assert.equal(f.reads(),1);
  const ledger=await f.ledger(f.bad.task_id);assert.equal(ledger.rounds.length,0);assert.equal(ledger.total.complete,false);
  assert.equal(ledger.unresolved[0].reason,'unreadable_session_candidate');
  assert.ok(reports.some(r=>r.diagnostic?.agent==='codex'&&r.diagnostic.reason===failure.message));
  f.histories.push(task(f.root,[launch(1,5,'pi'),delivery(2,20)],f.other.task_id));
  await collect(f.options,f.deps);assert.equal(f.reads(),2);
  // The unreadable Codex log cannot erase its valid file claim and let this
  // other profile account for the very same native window.
  const peer=await f.ledger(f.other.task_id);assert.equal(peer.rounds.length,0);assert.equal(peer.unresolved[0].reason,'overlapping_rounds');
});
test('a later run-log timeout preserves the original error and never writes a partial ledger',async t=>{
  const failure=Object.assign(Error('native run-log deadline'),{code:'LOCAL_IO_TIMEOUT',phase:'run-log-read',target:'native run-log',elapsed_ms:25,timeout_ms:25});
  const f=await mixedRunLogFixture(t,failure);
  await assert.rejects(collect(f.options,f.deps),e=>e===failure&&e.phase==='run-log-read'&&e.target==='native run-log'&&e.timeout_ms===25&&e.elapsed_ms===25);
  assert.equal(f.reads(),1);assert.equal(await f.ledger(f.bad.task_id),null);
});


test('a later round discovers its new session without reparsing historical files outside its window',async t=>{
  const f=await fixture(t),options={...f.options,watch:true};let reads=0;
  const deps={hub:{list:f.hub.list,read:(id,since)=>f.store.readTask(id,since)},allowed:async()=>true,
    readSession:async(...args)=>{reads++;return readSession(...args);}};
  await collect(options,deps);assert.equal(reads,1);
  await new Promise(resolve=>setTimeout(resolve,5));
  await f.store.append(f.id,{role:'human',content_type:'note',payload:{summary:'launch',body:'test',launch:{role:'executor',base_version:2,route:{agent:'pi',args:[]}}}});
  await f.store.append(f.id,{role:'executor',content_type:'revision',payload:{summary:'done',body:'test'}});
  const task=await f.store.readTask(f.id),[L,D]=task.versions.slice(-2);
  const start={...user(10),timestamp:L.timestamp},end={...pi(40,'stop','new'),timestamp:new Date(Date.parse(D.timestamp)+1).toISOString()};
  await session(f.cwdDir,'pi',[piHead(f.root),start,end],'later.jsonl');
  await collect(options,deps);assert.equal(reads,2);
  const dir=path.join(f.root,'.context-hub/tasks',f.id),incremental=await loadUsage(dir);
  assert.equal(incremental.rounds.length,2);
  await collect({...f.options,cache:new Map()},deps);assert.deepEqual(await loadUsage(dir),incremental);
});

test('incremental task cursors use inclusive Hub deltas, compact bodies, and cold calibration after restart',async t=>{
  const f=await fixture(t),options={...f.options,watch:true},reads=[],deps={allowed:async()=>true,hub:{
    list:f.hub.list,read:async(id,since)=>{reads.push([id,since]);return f.store.readTask(id,since);}
  }};
  await collect(options,deps);await collect(options,deps);
  assert.deepEqual(reads,[[f.id,undefined]]);
  await f.store.append(f.id,{role:'human',content_type:'note',payload:{summary:'metadata',body:'x'.repeat(100000)}});
  await collect(options,deps);assert.deepEqual(reads.at(-1),[f.id,3]);
  const snapshot=options.incremental.tasks.get(f.id).task;
  assert.equal(snapshot.versions.length,3);assert.equal(snapshot.versions.at(-1).payload.body,undefined);
  const ledger=await loadUsage(path.join(f.root,'.context-hub/tasks',f.id));
  await collect({...f.options,watch:true},deps);assert.deepEqual(reads.at(-1),[f.id,undefined]);
  assert.deepEqual(await loadUsage(path.join(f.root,'.context-hub/tasks',f.id)),ledger);
});

test('incremental outcomes equal full scans through append, partial tails, corruption, replacement, ambiguity and removal',async t=>{
  const f=await fixture(t),options={...f.options,watch:true},deps={hub:f.hub,allowed:async()=>true};
  const ledger=()=>loadUsage(path.join(f.root,'.context-hub/tasks',f.id));
  const check=async()=>{await collect(options,deps);const incremental=await ledger();
    await collect({...f.options,cache:new Map()},deps);assert.deepEqual(await ledger(),incremental);};
  await check();await fs.appendFile(f.s.file,'{');await check();
  await fs.writeFile(f.s.file,f.rows.map(JSON.stringify).join('\n')+'\n');await check();
  await fs.writeFile(f.s.file,'broken\n');await check();
  const replacement=f.s.file+'.new';await fs.writeFile(replacement,f.rows.map(JSON.stringify).join('\n')+'\n');
  await fs.rename(replacement,f.s.file);await check();
  const copy=path.join(f.cwdDir,'copy.jsonl');await fs.copyFile(f.s.file,copy);await check();
  await fs.unlink(copy);await check();await fs.unlink(f.s.file);await check();
  await fs.writeFile(f.s.file,f.rows.map(JSON.stringify).join('\n')+'\n');await check();
  assert.equal((await ledger()).total.complete,true);
});

test('new task collisions invalidate attribution of unchanged tasks and match a full scan',async t=>{
  const f=await fixture(t),options={...f.options,watch:true},deps={hub:f.hub,allowed:async()=>true};
  await collect(options,deps);
  const {task_id:other}=await f.store.createTask({title:'Collision',description:'test',creator:'test',role:'human',flow:'direct'});
  const history=await f.store.readTask(f.id),newHistory=history.versions.map(r=>({...r,task_id:other}));
  deps.hub={list:f.hub.list,read:async(id,since)=>id===other?{task_id:other,versions:newHistory.filter(r=>since===undefined||r.version>=since)}:f.store.readTask(id,since)};
  await collect(options,deps);
  const ledgers=()=>Promise.all([f.id,other].map(id=>loadUsage(path.join(f.root,'.context-hub/tasks',id))));
  const snapshots=await ledgers();await collect({...f.options,cache:new Map()},deps);
  assert.deepEqual(await ledgers(),snapshots);assert.ok(snapshots.every(v=>v.unresolved[0].reason==='overlapping_rounds'));
});

test('watch persists compact cursors outside usage output and ignores them on cold startup',async t=>{
  const f=await fixture(t),file=lockPath(canonicalRoot(f.root))+'.cursor.json';t.after(()=>fs.rm(file,{force:true}));
  for(let restart=0;restart<2;restart++) {
    const ac=new AbortController();let reads=0;
    await run({...f.options,watch:true,signal:ac.signal},{enabled:async()=>true,
      hub:{list:f.hub.list,read:async(...args)=>{reads++;return f.store.readTask(...args);}},report:()=>ac.abort()});
    assert.equal(reads,1);const cursor=JSON.parse(await fs.readFile(file,'utf8'));
    assert.deepEqual(cursor.tasks,[[f.id,2]]);assert.equal(cursor.sessions.length,1);
    assert.equal(cursor.sessions[0].length,2);assert.equal(cursor.rounds,undefined);
  }
});

test('slow watch passes back off by their duration and fast passes retain the configured floor',async t=>{
  const f=await fixture(t),ac=new AbortController(),waits=[];let pass=0;
  await run({...f.options,watch:true,intervalMs:10,timeoutMs:Infinity,signal:ac.signal},{
    enabled:async()=>true,lock:async()=>async()=>{},collect:async()=>{
      if(++pass===1)await new Promise(resolve=>setTimeout(resolve,45));if(pass===3)ac.abort();return [];
    },sleep:async ms=>{waits.push(ms);},report:()=>{}
  });
  assert.equal(waits.length,2);assert.ok(waits[0]>=35);assert.equal(waits[1],10);
});

test('copied watcher coordination belongs to the new root and cannot steal the source owner', async t => {
  const root = await temp(t), target = await temp(t);
  const release = await lock(root);
  const original = await fs.readFile(lockPath(root), 'utf8');
  await fs.cp(path.join(root, '.context-hub'), path.join(target, '.context-hub'), { recursive: true });
  try {
    const releaseCopy = await lock(target);
    assert.equal(JSON.parse(await fs.readFile(lockPath(target), 'utf8')).root, canonicalRoot(target));
    assert.equal(await fs.readFile(lockPath(root), 'utf8'), original);
    await releaseCopy();
  } finally { await release(); }
});
test('a peer change during native I/O stays in the old pass and invalidates the next source cache',async t=>{
 const root=await temp(t),dir=path.join(root,'native'),profiles=path.join(root,'.context-hub','agents');
 await fs.mkdir(dir);await fs.mkdir(profiles,{recursive:true});
 const file=path.join(dir,'session.jsonl');
 await fs.writeFile(file,[piHead(root),ev(10,'task_started',{turn_id:'t'}),count(20,7,3),ev(30,'task_complete',{turn_id:'t'})].map(x=>JSON.stringify(x)).join('\n')+'\n');
 const store=new Store(path.join(root,'.context-hub'));await store.whenSwept;
 const created=await store.createTask({title:'peer cache',description:'test',creator:'test',role:'human',flow:'direct'});
 const history=task(root,[launch(1,5,'codex'),delivery(2,20)],created.task_id);
 const hub={list:async()=>[{task_id:created.task_id}],read:async()=>history};
 const options={root,codexRoot:dir,piRoot:path.join(root,'no-pi-files'),watch:true};let reads=0;
 const deps={hub,allowed:async()=>true,readSession:async(file,agent,opts)=>{
  reads++;if(reads===1)await fs.writeFile(path.join(profiles,'pi.json'),JSON.stringify({id:'pi'}));
  return readSession(file,agent,opts);
 }};
 const [first]=await collect(options,deps);assert.equal(first.total.total_tokens,10);
 await collect(options,deps);assert.equal(reads,2);
 await collect(options,deps);assert.equal(reads,2);
});

test('basic capability is unmetered without native I/O; a pass freezes its binding snapshot',async t=>{
 const root=await temp(t),store=new Store(path.join(root,'.context-hub'));await store.whenSwept;
 const created=await store.createTask({title:'basic usage',description:'Protocol fixture.',creator:'test',role:'human',flow:'direct'});
 const config=path.join(root,'.context-hub','config.json');
 const binding={executable:'worker-x',args:[],prompt:{kind:'argv',index:0}};
 await fs.writeFile(config,JSON.stringify({flow_mode:'manual',agent_bindings:{'worker-x':binding}}));
 const history=task(root,[launch(1,5,'binding:worker-x'),delivery(2,20)],created.task_id);
 let reads=0;
 const hub={list:async()=>[{task_id:created.task_id}],read:async()=>{reads++;await fs.writeFile(config,JSON.stringify({flow_mode:'manual',agent_bindings:{'worker-x':{broken:true}}}));return history;}};
 const deps={hub,files:async()=>{throw Error('basic must not discover native sources');}};
 const {collectStats}=await import('../../../dist/core/stats.js');
 for(const record of history.versions)await store.append(created.task_id,{role:record.role,content_type:record.content_type,payload:record.payload.summary?record.payload:{...record.payload,summary:'fixture',body:'fixture'}});
 const missing=await collectStats(path.join(root,'.context-hub'));
 assert.equal(missing.tasks[0].usage.status,'missing');
 assert.deepEqual(missing.tasks[0].usage.unmetered,[{agent:'binding:worker-x',reason:'not-declared'}]);
 const [first]=await collect({root},deps);
 assert.equal(first.total.rounds,0);assert.equal(first.total.complete,false);
 assert.deepEqual(first.unresolved[0],{delivery_version:2,launch_version:1,reason:'usage_unavailable',agent:'binding:worker-x',reason_code:'not-declared',capability:'unavailable'});
 const [next]=await collect({root},deps);
 assert.match(next.unresolved[0].reason,/agent binding\.agent/);
 assert.equal(next.unresolved[0].capability,'invalid');assert.equal(reads,2);
 await fs.writeFile(config,JSON.stringify({flow_mode:'manual',agent_bindings:{'worker-x':binding}}));
 await collect({root},{...deps,hub:{...hub,read:async()=>history}});
 const stats=await collectStats(path.join(root,'.context-hub'));
 assert.deepEqual(stats.tasks[0].usage.by_agent,{});
 assert.deepEqual(stats.tasks[0].usage.unmetered,[{agent:'binding:worker-x',reason:'not-declared'}]);
 assert.equal(stats.tasks[0].usage.unsupported,undefined);
});

for(const routeAgent of ['/opt/fixture/codex','meter-cli'])test(`resolved route ${routeAgent} keeps full/watch attribution and other tasks alive`,async t=>{
 const f=await fixture(t);
 if(routeAgent==='meter-cli') {
  const {agentProfiles,profileArtifact}=await import('../../../dist/agents/public/transition.js');
  const profile=JSON.parse(profileArtifact(agentProfiles.get('codex')));
  profile.id='custom-meter';profile.match.supported_executable_names=['meter-cli'];profile.match.platform_target_identity=null;
  await fs.mkdir(path.join(f.root,'.context-hub','agents'),{recursive:true});
  await fs.writeFile(path.join(f.root,'.context-hub','agents','custom-meter.json'),JSON.stringify(profile));
 }
 const {task_id:id}=await f.store.createTask({title:'Resolved meter route',description:'Protocol regression.',creator:'test',role:'human',flow:'direct'});
 const route={agent:routeAgent,args:['--fixed','kept']};
 await f.store.append(id,{role:'human',content_type:'note',payload:{summary:'launch',body:'fixture',launch:{role:'executor',base_version:0,route}}});
 await f.store.append(id,{role:'executor',content_type:'code_changes',payload:{summary:'done',body:'fixture'}});
 const history=await f.store.readTask(id),[L,D]=history.versions;
 const options={...f.options,watch:true},deps={hub:f.hub,allowed:async()=>true};
 const ledger=()=>loadUsage(path.join(f.root,'.context-hub/tasks',id));
 await collect(options,deps);
 assert.equal((await ledger()).unresolved[0].reason,'missing_session_or_end');
 assert.equal((await loadUsage(path.join(f.root,'.context-hub/tasks',f.id))).total.total_tokens,37);
 let expected=await ledger();await collect({...f.options,cache:new Map()},deps);assert.deepEqual(await ledger(),expected);
 await fs.mkdir(f.options.codexRoot);
 await fs.writeFile(path.join(f.options.codexRoot,'native.jsonl'),[
  codexHead(f.root),
  {...ev(10,'task_started',{turn_id:'resolved'}),timestamp:L.timestamp},
  {...count(20,7,3),timestamp:new Date(Date.parse(D.timestamp)+10).toISOString()},
  {...ev(30,'task_complete',{turn_id:'resolved'}),timestamp:new Date(Date.parse(D.timestamp)+100).toISOString()}
 ].map(JSON.stringify).join('\n')+'\n');
 await collect(options,deps);expected=await ledger();
 assert.deepEqual(expected.total,{rounds:1,total_tokens:10,cost_usd:null,complete:true});
 assert.equal(expected.rounds[0].agent,routeAgent);assert.deepEqual(expected.unresolved,[]);
 await collect(options,deps);assert.deepEqual(await ledger(),expected);
 await collect({...f.options,watch:true},deps);assert.deepEqual(await ledger(),expected);
 await collect({...f.options,cache:new Map()},deps);assert.deepEqual(await ledger(),expected);
 const {collectStats}=await import('../../../dist/core/stats.js');
 const stats=await collectStats(path.join(f.root,'.context-hub'));
 assert.equal(stats.tasks.find(t=>t.task_id===id).usage.by_agent[routeAgent].total_tokens,10);
 assert.equal((await f.store.readTask(id)).versions[0].payload.launch.route.agent,routeAgent);
 await fs.writeFile(path.join(f.options.codexRoot,'native.jsonl'),'broken\n');
 await collect(options,deps);assert.equal((await ledger()).unresolved[0].reason,'unreadable_session_candidate');
 assert.equal((await ledger()).total.total_tokens,10);
 assert.equal((await loadUsage(path.join(f.root,'.context-hub/tasks',f.id))).total.total_tokens,37);
});

test('merge never treats an empty candidate list as a successful measurement',()=>{
 const round={task_id:'one',round:1,agent:'meter-cli',role:'executor',launch_version:1,delivery_version:2,ts:T(20)};
 const value=merge(null,[{round,candidates:[]}]);
 assert.equal(value.rounds.length,0);assert.equal(value.unresolved[0].reason,'missing_session_or_end');
});

test('exact file sources have identical cold watch, full and stationary results with stable opaque callbacks',async t=>{
 const root=await temp(t),store=new Store(path.join(root,'.context-hub'));await store.whenSwept;
 const {task_id:id}=await store.createTask({title:'Exact file usage',description:'Protocol regression.',creator:'test',role:'human',flow:'direct'});
 const {agentProfiles,profileArtifact}=await import('../../../dist/agents/public/transition.js');
 const profile=JSON.parse(profileArtifact(agentProfiles.get('codex')));
 profile.usage.attribution='exact-session-window-v1';profile.usage.source.header.id=['payload','id'];profile.usage.capability.spec=structuredClone(profile.usage.source);
 await fs.mkdir(path.join(root,'.context-hub','agents'),{recursive:true});
 await fs.writeFile(path.join(root,'.context-hub','agents','codex.json'),JSON.stringify(profile));
 const dir=path.join(root,'native');await fs.mkdir(dir);
 const file=path.join(dir,'native.jsonl');
 await fs.writeFile(file,[{...codexHead(root),payload:{...codexHead(root).payload,id:'native'}},ev(10,'task_started',{turn_id:'exact'}),count(20,7,3),ev(30,'task_complete',{turn_id:'exact'})].map(JSON.stringify).join('\n')+'\n');
 const attempt='0ec82a6a-a166-4b1e-afc1-17667c629d30',marker=launch(1,5,'codex');marker.payload.launch.attempt_id=attempt;
 const history=task(root,[marker,delivery(2,20)],id),route=marker.payload.launch.route;
 const run={run_id:'exact-run',task_id:id,cwd:root,argv:['codex'],agent_session_id:'native',headless:{role:'executor',attempt_id:attempt,base_version:0,route}};
 let reads=0;
 const options={root,codexRoot:dir,watch:true},deps={allowed:async()=>true,hub:{list:async()=>[{task_id:id,version:2}],read:async()=>history},runs:async()=>[run],readSession:async(...args)=>{reads++;return readSession(...args);}};
 const ledger=()=>loadUsage(path.join(root,'.context-hub/tasks',id));
 await collect(options,deps);const expected=await ledger();
 assert.deepEqual(expected.total,{rounds:1,total_tokens:10,cost_usd:null,complete:true});assert.deepEqual(expected.unresolved,[]);assert.equal(reads,1);
 await collect(options,deps);assert.deepEqual(await ledger(),expected);assert.equal(reads,1);
 await collect({root,codexRoot:dir},deps);assert.deepEqual(await ledger(),expected);assert.equal(reads,2);
 await collect(options,deps);assert.deepEqual(await ledger(),expected);assert.equal(reads,2);
 const {resolveContract,contractSource}=await import('../../../dist/agents/public/index.js');
 const {bindUsage,bindUsageRun,readUsage}=await import('../../../dist/agents/public/usage.js');
 const selected=resolveContract({agent:'codex'},contractSource(root),'posix');assert.equal(selected.status,'resolved');
 // This direct adapter assertion selects a POSIX contract on every host;
 // its cwd/home must be POSIX facts too, independent of the physical fixture.
 const adapterRun={...run,cwd:'/contract-checkout'};
 const facts={task_id:id,role:'executor',agent:'codex',route,cwd:adapterRun.cwd,launch_version:1,delivery_version:2,launch_ts:T(5),delivery_ts:T(20),attempt_id:attempt};
 const bound=bindUsageRun(selected.handle,facts,[adapterRun]);
 const extra=bindUsage(selected.handle,{...facts,run_id:run.run_id,native_session_id:'native'},{run_id:run.run_id,native_session_id:'native',identity_source:'observed',profile:{value:'private'},round:{},attribution:'wrong'});
 assert.equal(extra.status,'bound');assert.equal(extra.ref.key,bound.ref.key);
 assert.equal(bound.status,'bound');let calls=0;
 await readUsage(bound.ref,{facts:{home:'/contract-home',auditCwd:adapterRun.cwd,platform:'posix',codexRoot:'/contract-native',piEnv:{}},list:async()=>['/contract-native/native.jsonl'],readRun:async()=>adapterRun,readSource:async(_file,callback)=>{
  calls++;assert.equal(callback,bound.ref);assert.equal(callback.key,bound.ref.key);
  const identity=JSON.parse(callback.key)[2];assert.deepEqual(Object.keys(identity).sort(),['identity_source','native_session_id','run_id']);
  assert.equal(identity.profile,undefined);return {candidates:[],sourceEvidence:[],problems:[]};
 }});
 assert.equal(calls,1);
});
