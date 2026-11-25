import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { Store } from '../../../src/hub/store.js';
import { startServer } from '../../../src/hub/server.js';
import { agentProfiles } from '../../../src/agents/registry.js';
const exec=promisify(execFile),cli=path.resolve('dist/cli.js'),audit=path.resolve('scripts/usage-audit/run.mjs');

it('keeps explicit stats/audit owner A independent of caller cwd/env and absent or invalid profiles in B',async()=>{
 const a=await realpath(await mkdtemp(path.join(os.tmpdir(),'tut-usage-owner-'))),b=await realpath(await mkdtemp(path.join(os.tmpdir(),'tut-usage-foreign-')));
 for(const root of [a,b])await mkdir(path.join(root,'.context-hub','agents'),{recursive:true});
 const readable=structuredClone(agentProfiles.get('codex')!.value);readable.id='root-reader';readable.match.supported_executable_names=[readable.id];readable.match.platform_target_identity=null;
 const unsupported=structuredClone(agentProfiles.get('opencode')!.value);unsupported.id='root-unmeasured';unsupported.match.supported_executable_names=[unsupported.id];unsupported.match.platform_target_identity=null;
 for(const p of [readable,unsupported])await writeFile(path.join(a,'.context-hub','agents',p.id+'.json'),JSON.stringify(p));
 const store=new Store(path.join(a,'.context-hub'));
 async function task(agent:string) {
  const t=await store.createTask({title:agent,description:'Protocol fixture for profile root isolation.',creator:'test',role:'executor',flow:'direct'});
  await store.append(t.task_id,{role:'human',content_type:'note',payload:{summary:'protocol fixture launch',body:'No model run or authorization claim.',launch:{role:'executor',base_version:0,route:{agent,args:[]}}}});
  await store.append(t.task_id,{role:'executor',agent,content_type:'code_changes',payload:{summary:'protocol fixture delivery',body:'No model run.'}});
  return store.readTask(t.task_id);
 }
 const measured=await task(readable.id),unmeasured=await task(unsupported.id),native=path.join(a,'native');await mkdir(native);
 const start=measured.versions[0]!.timestamp,end=measured.versions[1]!.timestamp;
 await writeFile(path.join(native,'session.jsonl'),[
  {type:'session_meta',payload:{cwd:a}},
  {timestamp:start,type:'event_msg',payload:{type:'task_started',turn_id:'turn'}},
  {timestamp:end,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:2,output_tokens:1,total_tokens:3}}}},
  {timestamp:end,type:'event_msg',payload:{type:'task_complete',turn_id:'turn'}}
 ].map(row=>JSON.stringify(row)).join('\n')+'\n');
 await writeFile(path.join(a,'legacy-pi.jsonl'),JSON.stringify({type:'session',id:'legacy',cwd:a,version:3})+'\n');
 const server=await startServer({root:path.join(a,'.context-hub'),port:0});
 try {
  let baseline:unknown;
  for(const scenario of ['owner','foreign-missing','foreign-invalid','owner-with-foreign-env']) {
   if(scenario==='foreign-invalid')for(const id of [readable.id,unsupported.id,'codex','pi'])await writeFile(path.join(b,'.context-hub','agents',id+'.json'),'{');
   const cwd=scenario.startsWith('foreign')?b:a,env={...process.env,TUT_HUB_ROOT:scenario==='owner'?a:b,TUT_PROJECT_ROOT:b};
   const result=await exec(process.execPath,[audit,'--backfill','--root',a,'--url',server.url,'--codex-root',native],{cwd,env,timeout:15000});
   const reports=result.stdout.trim().split('\n').map(line=>JSON.parse(line));
   expect(reports.find(r=>r.task_id===measured.task_id).total.total_tokens).toBe(3);
   expect(reports.find(r=>r.task_id===unmeasured.task_id).unresolved[0]).toMatchObject({agent:unsupported.id,reason_code:'usage-source-unverified',capability:'unsupported'});
   const stats=JSON.parse((await exec(process.execPath,[cli,'stats','--root',path.join(a,'.context-hub'),'--json'],{cwd,env,timeout:15000})).stdout);
   const usage=stats.tasks.find((t:{task_id:string})=>t.task_id===measured.task_id).usage;
   expect(usage.status).toBe('complete');expect(usage.by_agent[readable.id].total_tokens).toBe(3);
   const ledger=await store.readUsage(measured.task_id);
   if(baseline===undefined)baseline=ledger;else expect(ledger).toEqual(baseline);
  }
  // The same explicit owner reaches extraction and validator APIs without
  // changing process-global cwd/env, without altering either caller setting.
  const script=`
   import {extract} from ${JSON.stringify(new URL('../../../scripts/usage-audit/lib/rounds.mjs',import.meta.url).href)};
   import {validateUsage,loadUsage} from ${JSON.stringify(new URL('../../../scripts/usage-audit/lib/audit.mjs',import.meta.url).href)};
   import {Store} from ${JSON.stringify(pathToFileURL(path.resolve('dist/hub/store.js')).href)};
   import {readSession} from ${JSON.stringify(new URL('../../../scripts/usage-audit/test/helpers.mjs',import.meta.url).href)};
   const [a,b,id]=process.argv.slice(1),store=new Store(a+'/.context-hub',{readOnly:true});
   const task=await store.readTask(id),value=await loadUsage(a+'/.context-hub/tasks/'+id);
   if(extract(task,a)[0].problem)throw Error('wrong owner during extraction');
   validateUsage(value,{root:a});
   const legacy=await readSession(a+'/legacy-pi.jsonl','codex',{root:a});
   if(legacy.excluded||legacy.header.cwd!==a)throw Error('wrong legacy header profile owner');
   validateUsage(value,{root:b}); // Preserved v1 evidence does not depend on today's installed profiles.
   console.log(JSON.stringify({tokens:value.total.total_tokens,root:process.env.TUT_HUB_ROOT,cwd:process.cwd()}));`;
  const direct=JSON.parse((await exec(process.execPath,['--input-type=module','-e',script,a,b,measured.task_id],{cwd:b,env:{...process.env,TUT_HUB_ROOT:b,TUT_PROJECT_ROOT:b},timeout:15000})).stdout);
  expect(direct).toEqual({tokens:3,root:b,cwd:b});
  await writeFile(path.join(a,'.context-hub','agents',readable.id+'.json'),'{');
  await exec(process.execPath,[audit,'--backfill','--root',a,'--url',server.url,'--codex-root',native],{cwd:b,env:{...process.env,TUT_HUB_ROOT:b},timeout:15000});
  const preserved=await store.readUsage(measured.task_id) as {rounds:unknown[];unresolved:{preserved?:boolean}[]};
  expect(preserved.rounds).toEqual((baseline as {rounds:unknown[]}).rounds);expect(preserved.unresolved[0]!.preserved).toBe(true);
  const after=JSON.parse((await exec(process.execPath,[cli,'stats','--root',path.join(a,'.context-hub'),'--json'],{cwd:b,env:{...process.env,TUT_HUB_ROOT:b},timeout:15000})).stdout);
  expect(after.tasks.find((t:{task_id:string})=>t.task_id===measured.task_id).usage).toMatchObject({status:'incomplete',by_agent:{[readable.id]:{total_tokens:3}}});
 }finally{await server.close();}
},60000);
