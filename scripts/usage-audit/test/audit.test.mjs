import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../../../dist/hub/store.js';
import { startServer } from '../../../dist/hub/server.js';
import { readConfigFile, writeConfigKey, parseConfigValue } from '../../../dist/common/config.js';
import { extract, attribute } from '../lib/rounds.mjs';
import { measure, readSession } from '../lib/sessions.mjs';
import { run, collect, enabled, lock, lockPath, merge, writeUsage, loadUsage, source, validateUsage } from '../lib/audit.mjs';
import { canonicalRoot } from '../../../dist/hub/rig-discovery.js';
import { parse } from '../run.mjs';
const T = n => new Date(Date.UTC(2026,0,1,0,0,0,n)).toISOString();
async function temp(t) { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'usage-test-'))); t.after(() => fs.rm(dir,{recursive:true,force:true})); return dir; }
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
  const root=await temp(t),store=new Store(path.join(root,'.context-hub'));await store.whenSwept;
  const {task_id:id}=await store.createTask({title:'One',description:'test',role:'human',creator:'test',flow:'direct'});
  await store.append(id,{role:'human',content_type:'note',payload:{summary:'launch',body:'test',launch:{role:'executor',base_version:0,route:{agent:'pi',args:[]}}}});
  await store.append(id,{role:'executor',content_type:'code_changes',payload:{summary:'done',body:'test'}});
  const task=await store.readTask(id),Lts=Date.parse(task.versions[0].timestamp),D=Date.parse(task.versions[1].timestamp);
  const piRoot=path.join(root,'pi'),cwdDir=path.join(piRoot,`--${root.slice(1).replaceAll('/','-')}--`);await fs.mkdir(cwdDir,{recursive:true});
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
  const exited=once(child,'exit');child.kill('SIGTERM');await exited;await assert.rejects(fs.stat(lockPath(f.root)),{code:'ENOENT'});
});
test('CLI rejects bad modes, unknown options and invalid dates',()=>{
  for (const args of [[],['--wat'],['--watch','--backfill'],['--since','yesterday'],['--since','2026-02-30T00:00:00Z'],['--watch','--interval-ms','0']]) assert.throws(()=>parse(args));
  assert.equal(parse(['--since',T(1)]).since,Date.parse(T(1)));
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
  const env={...process.env,NODE_OPTIONS:`--require=${preload}`,PATH:`${bin}${path.delimiter}${process.env.PATH}`,TUT_HUB_ROOT:root,TUT_PROJECT_ROOT:root,TUT_USER_CONFIG_DIR:path.join(root,'user-config'),TUT_HUB_URL:server.url,TUT_HERDR_EXECUTABLE:path.join(bin,'herdr'),TUT_HERDR_PANES:'[]',TUT_DRY_RUN:'1'};
  async function command(args) {const child=spawn(process.execPath,[cli,...args],{cwd:root,env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const [code]=await once(child,'exit');assert.equal(code,0,err);return out;}
  await command(['create','--title','Off normal flow','--description','Isolated test','--creator','test','--role','human','--flow','direct','--cast','executor=pi','--url',server.url]);
  const hub=await source(server.url,root),entries=await hub.list(),id=entries.find(e=>e.task_id!=='project').task_id;
  await command(['start-next',id,'--url',server.url]);
  await command(['publish',id,'--role','executor','--content-type','code_changes','--summary','done','--body','Isolated test delivery','--url',server.url]);
  const result=await hub.read(id);assert.equal(result.versions.length,2);assert.equal(result.status,'reviewing');
  assert.deepEqual((await fs.readdir(path.join(root,'.context-hub/tasks',id))).sort(),['meta.json','v001.note.json','v002.code_changes.json']);
  await assert.rejects(fs.stat(log),{code:'ENOENT'});await assert.rejects(fs.stat(lockPath(root)),{code:'ENOENT'});
});
