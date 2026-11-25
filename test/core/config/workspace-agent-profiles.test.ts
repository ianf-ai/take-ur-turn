import { mkdtemp, mkdir, writeFile, symlink, rm, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentProfiles, loadAgentProfiles, withAgentProfileSnapshot } from '../../../src/agents/registry.js';
import { parseArgs } from '../../../src/core/cli/args.js';
import { buildHeadlessPlan } from '../../../src/standalone/launcher-detached/plan.js';
import { AgentSetupStore } from '../../../src/core/agents/setup-store.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function rig(){const root=await mkdtemp(path.join(os.tmpdir(),'tut-workspace-profiles-'));roots.push(root);await mkdir(path.join(root,'.context-hub','agents'),{recursive:true});return root;}
function candidate(id='sample-agent'){const p=structuredClone(agentProfiles.get('opencode')!.value);p.id=id;p.match.supported_executable_names=[id];return p;}
async function put(root:string,file:string,value:unknown){await writeFile(path.join(root,'.context-hub','agents',file),JSON.stringify(value));}

describe('workspace profile catalogs',()=>{
 it('shares the builtin registry for both absent and empty directories',async()=>{
  const root=await rig(),empty=loadAgentProfiles(root);
  await rm(path.join(root,'.context-hub','agents'),{recursive:true});
  expect(loadAgentProfiles(root)).toBe(empty);
 });
 it('reuses unchanged content, invalidates changed/removed/invalid profiles, and keeps a pass snapshot',async()=>{
  const root=await rig(),file=path.join(root,'.context-hub','agents','sample.json'),value=candidate();
  await put(root,'sample.json',value);const first=loadAgentProfiles(root);
  expect(loadAgentProfiles(root)).toBe(first);
  await put(root,'sample.json',value);expect(loadAgentProfiles(root)).toBe(first);
  await withAgentProfileSnapshot(root,async()=>{
   const before=await stat(file);value.revision='new-revision';await put(root,'sample.json',value);
   await utimes(file,before.atime,before.mtime);
   await Promise.resolve();
   expect(loadAgentProfiles(root)).toBe(first);
   expect(agentProfiles.get(value.id,'posix',root)?.revision).toBe(first.get(value.id)?.revision);
  });
  const changed=loadAgentProfiles(root);expect(changed).not.toBe(first);expect(changed.get(value.id)?.revision).toBe('new-revision');
  await writeFile(file,'{');expect(loadAgentProfiles(root).get(value.id)).toBeUndefined();
  expect(loadAgentProfiles(root).diagnostics.length).toBeGreaterThan(0);
  await rm(file);expect(loadAgentProfiles(root).get(value.id)).toBeUndefined();
  await put(root,'sample.json',value);expect(loadAgentProfiles(root).get(value.id)?.revision).toBe('new-revision');
 });
 it('atomically installs one complete profile and refuses concurrent overwrite and duplicate ids',async()=>{
  const root=await rig(),store=new AgentSetupStore(root),p=candidate();
  const results=await Promise.allSettled([store.install(p),store.install(p)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(loadAgentProfiles(root).get(p.id)?.value).toEqual(new (await import('../../../src/agents/registry.js')).ProfileRegistry([p]).get(p.id)?.value);
  await expect(store.install(p)).rejects.toThrow(/已存在/u);
  const duplicate=candidate('different');await put(root,'arbitrary.json',duplicate);
  await expect(store.install(duplicate)).rejects.toThrow(/PROFILE_AMBIGUOUS/u);
 });
 it('serializes different ids sharing an executable while independent installs both remain usable',async()=>{
  const root=await rig(),a=candidate('first'),b=candidate('second');
  a.match.supported_executable_names=b.match.supported_executable_names=['brandnew'];
  const outcomes=await Promise.allSettled([new AgentSetupStore(root).install(a),new AgentSetupStore(root).install(b)]);
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const failure=outcomes.find(r=>r.status==='rejected') as PromiseRejectedResult;expect(failure.reason.message).toContain('PROFILE_AMBIGUOUS');
  const registry=loadAgentProfiles(root),winner=registry.match('brandnew')!;
  expect(['first','second']).toContain(winner.id);expect(registry.diagnostics).toEqual([]);
  const independent=[candidate('independent-one'),candidate('independent-two')];
  await Promise.all(independent.map(p=>new AgentSetupStore(root).install(p)));
  for(const p of independent)expect(loadAgentProfiles(root).get(p.id)).toBeDefined();
 });
 it('merges a drop-in and preserves all bundled platform digests; an override wins by id',async()=>{
  const root=await rig();await put(root,'anything.json',candidate());
  const registry=loadAgentProfiles(root);
  expect(registry.match('/bin/sample-agent')?.id).toBe('sample-agent');expect(registry.diagnostics).toEqual([]);
  for(const platform of ['posix','win32'] as const)for(const id of ['codex','pi','opencode'])expect(registry.get(id,platform)?.digest).toBe(agentProfiles.get(id,platform)?.digest);
  const override=candidate('opencode');override.revision='workspace';override.match.supported_executable_names=['workspace-opencode'];await put(root,'override.json',override);
  expect(loadAgentProfiles(root).get('opencode')?.revision).toBe('workspace');expect(loadAgentProfiles(root).match('opencode')).toBeUndefined();
 });
 it('isolates invalid JSON, schema, duplicate ids, executable ambiguity and nonregular files',async()=>{
  const root=await rig();await put(root,'good.json',candidate('healthy'));
  await writeFile(path.join(root,'.context-hub','agents','codex.json'),'{');
  await put(root,'bad.json',{id:'bad'});await put(root,'one.json',candidate('duplicate'));await put(root,'two.json',candidate('duplicate'));
  const collision=candidate('collision');collision.match.supported_executable_names=['pi'];await put(root,'collision.json',collision);
  await mkdir(path.join(root,'.context-hub','agents','directory.json'));
  if(process.platform!=='win32')await symlink(path.join(root,'.context-hub','agents','good.json'),path.join(root,'.context-hub','agents','link.json'));
  const registry=loadAgentProfiles(root);
  expect(registry.get('healthy')).toBeDefined();for(const id of ['codex','bad','duplicate','pi','collision'])expect(registry.get(id)).toBeUndefined();
  expect(registry.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({id:'codex',code:'PROFILE_INVALID'}),expect.objectContaining({id:'duplicate',code:'PROFILE_AMBIGUOUS'}),expect.objectContaining({id:'pi',code:'PROFILE_AMBIGUOUS'})]));
 });
 it('keeps roots independent and notices new declarations on the next lookup',async()=>{
  const a=await rig(),b=await rig();expect(loadAgentProfiles(a).get('sample-agent')).toBeUndefined();await put(a,'sample.json',candidate());
  expect(loadAgentProfiles(a).get('sample-agent')).toBeDefined();expect(loadAgentProfiles(b).get('sample-agent')).toBeUndefined();
 });
 it.skipIf(process.platform==='win32')('plans against the owning Hub even with a foreign cwd and a worktree checkout',async()=>{
  const root=await rig(),checkout=await rig(),bin=path.join(root,'sample-agent');
  await put(root,'sample.json',candidate());await writeFile(bin,'#!/bin/sh\nexit 0\n',{mode:0o700});
  const plan=await buildHeadlessPlan({task:{task_id:'probe',title:'probe',version:0,flow:'direct',cast:{executor:{agent:bin,args:['--auto']}},checkout:{kind:'worktree',path:checkout}},role:'executor',records:[],hubRoot:root,hubUrl:'http://127.0.0.1:1',eventUrl:'http://127.0.0.1:1',env:{},launchCheckout:'rig'});
  expect(plan.profile?.id).toBe('sample-agent');expect(plan.env.PWD).toBe(checkout);expect(plan.argv[0]).toBe(bin);
 });
});
it('only adds the agent probe command form',()=>{
 expect(parseArgs(['agent','probe','sample-agent'])).toEqual({command:'agent',action:'probe',id:'sample-agent'});
 for(const argv of [['agent'],['agent','list'],['agent','probe'],['agent','probe','../bad'],['agent','probe','sample','--json']])expect(parseArgs(argv).command).toBe('usage');
});

describe('real rig binding compiler snapshot',()=>{
 it('reads through config authority and freezes bindings independently of future edits and other rigs',async()=>{
  const {writeAgentBinding}=await import('../../../src/core/common/config.js');
  const {readContractSource}=await import('../../../src/core/agents/profile-source.js');
  const api=await import('../../../src/agents/public/index.js');
  const root=await rig(),other=await rig();
  const binding={schema_version:1 as const,id:'worker-x',command:{executable:'worker-cli',argv:[{slot:'prompt' as const}]},input:{kind:'argv' as const}};
  await writeAgentBinding(path.join(root,'.context-hub'),'worker-x',binding);
  const snapshot=await readContractSource(root),selected=api.resolveContract({agent:'binding:worker-x'},snapshot,'posix');
  expect(selected.status).toBe('resolved');expect(Object.isFrozen(snapshot.bindings)).toBe(true);
  await writeAgentBinding(path.join(root,'.context-hub'),'worker-x',{...binding,command:{...binding.command,executable:'other-cli'}});
  const next=api.resolveContract({agent:'binding:worker-x'},await readContractSource(root),'posix');
  if(selected.status!=='resolved'||next.status!=='resolved')throw Error('missing binding contract');
  expect(selected.handle.digest).not.toBe(next.handle.digest);
  expect(api.resolveContract({agent:'binding:worker-x'},await readContractSource(other),'posix').status).toBe('invalid');
  await writeFile(path.join(root,'.context-hub','config.json'),'{');
  expect(api.resolveContract({agent:'binding:worker-x'},await readContractSource(root),'posix')).toMatchObject({status:'invalid',code:'BINDING_SOURCE_INVALID'});
  await writeFile(path.join(root,'.context-hub','config.json'),JSON.stringify({flow_mode:'manual',agent_bindings:{'worker-x':binding}}));
  await put(root,'broken-native.json',{id:'existing-native',match:{supported_executable_names:['worker-cli']}});
  expect(api.resolveContract({agent:'binding:worker-x'},await readContractSource(root),'posix')).toMatchObject({status:'invalid',reason:expect.stringContaining('existing-native')});
  const restored=api.decodeContract(api.encodeContract(selected.handle));
  const facts={mode:'run' as const,origin:'managed' as const,entry:'auto' as const,route:{agent:'binding:worker-x',args:[]},checkoutRoot:'/checkout',prompt:'hello',environmentFacts:{home:'/home',env:{}}};
  const ready=await api.prepareInvocation(restored,facts);expect(ready.status).toBe('ready');if(ready.status==='ready')expect(ready.invocation.executable).toBe('worker-cli');
 });
});
