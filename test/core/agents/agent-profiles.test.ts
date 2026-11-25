import vm from 'node:vm';
import { parseUsageSession } from '../../../src/agents/usage-session.js';
import { BOARD_UI_SCRIPT } from '../../../src/hub/board-client.js';
import { describe, expect, it, vi } from 'vitest';
import { agentProfiles, ProfileRegistry } from '../../../src/agents/registry.js';
import { invoke, captureSession, renderInvocation } from '../../../src/agents/interpreter.js';
import { inferProfile, parseCommandSample } from '../../../src/agents/setup.js';
import type { InvokeInput } from '../../../src/agents/runtime-contract.js';
import type { ReadServices, UsageSessionRef } from '../../../src/agents/usage.js';
import { readUsage } from '../../../src/agents/usage.js';
import { validateProfile } from '../../../src/agents/schema.js';
const request=(profile:NonNullable<ReturnType<typeof agentProfiles.get>>,agent=profile.value.match.supported_executable_names[0]!,cwd='/checkout'):InvokeInput=>({profile,mode:'run',origin:'managed',entry:'auto',platform:profile.platform,route:{agent,args:['--auto']},checkoutRoot:cwd,prompt:'hello',environmentFacts:{home:cwd,env:{}}});
const candidate = () => structuredClone(agentProfiles.get('opencode')!.value);

describe('sample-derived onboarding contracts',()=>{
 it.each([
  {id:'codex',run:'@codex codex {root} exec {nonroot} {json} TUT_PROMPT',resume:'codex {root} exec {parent} resume {shared} {json} TUT_SESSION TUT_PROMPT',cases:[['--search'],['-m','model','-c','model_reasoning_effort=high','--color','never','--ephemeral'],['--model=model','-cfirst=1','exec','--color=never','--output-schema=schema.json','--json'],['--json','--json'],['--unknown']]},
  {id:'pi',run:'@pi pi {args} {print} {mode} --session-id TUT_SESSION -- TUT_PROMPT',resume:'pi {args} {print} {mode} --session-id TUT_SESSION -- TUT_PROMPT',cases:[['--model','model','--thinking','high'],['--system-prompt','--model','--print','--mode=json'],['--session','foreign'],['--mode','text']]},
  {id:'opencode',run:'@opencode opencode run {args} {json} -- TUT_PROMPT',resume:'opencode run {args} {json} --session TUT_SESSION -- TUT_PROMPT',cases:[['--auto'],['--auto','--model','provider/model','--thinking','--title','two words'],['run','--auto','--format=json','--file','one path'],['--auto','--session','foreign'],['--auto','--format','text'],[]]}
 ])('keeps explicitly declared $id option boundaries and rejection rules with nonempty routes',({id,run,resume,cases})=>{
  const hand=agentProfiles.get(id)!,declared=inferProfile(id,parseCommandSample(run,'run'),parseCommandSample(resume,'resume'),'{"id":"TUT_SESSION"}');
  const generated=new ProfileRegistry([declared]).get(id)!;
  expect(generated.value.invoke.route).toBe(id);
  for(const mode of ['run','resume'] as const)for(const args of cases) {
   const facts={mode,checkoutRoot:'/checkout',prompt:'a prompt with spaces',sessionId:id==='opencode'?'ses_sample':'12345678-1234-1234-1234-123456789abc',route:{agent:id,args}};
   const actual=renderInvocation({...facts,profile:generated}),expected=renderInvocation({...facts,profile:hand});
   expect(actual.status).toBe(expected.status);
   if(actual.status==='ready'&&expected.status==='ready')expect(actual.invocation.argv).toEqual(expected.invocation.argv);
   else if(actual.status!=='ready'&&expected.status!=='ready')expect(actual.code).toBe(expected.code);
  }
 });
 it('requires the operator to declare a policy and parameter positions without recognizing executable names',()=>{
  const run=parseCommandSample('@codex brandnew {root} exec {nonroot} {json} TUT_PROMPT','run');
  expect(inferProfile('unrelated',run,parseCommandSample('brandnew {root} exec {parent} resume {shared} {json} TUT_SESSION TUT_PROMPT','resume'),'{"id":"TUT_SESSION"}').invoke.route).toBe('codex');
  expect(()=>parseCommandSample('@codex brandnew exec TUT_PROMPT','run')).toThrow(/分组位置/u);
  expect(()=>parseCommandSample('@unknown brandnew {args} TUT_PROMPT','run')).toThrow(/没看懂 run/u);
  expect(()=>inferProfile('unrelated',run,parseCommandSample('@pi brandnew {args} --id TUT_SESSION TUT_PROMPT','resume'),'{"id":"TUT_SESSION"}')).toThrow(/一致/u);
 });
 it.each([
  {id:'codex',run:'codex exec --json TUT_PROMPT',resume:'codex exec resume --json session-sample TUT_PROMPT',sample:'{"type":"thread.started","thread_id":"session-sample"}',args:[]},
  {id:'pi',run:'pi --print --mode json --session-id TUT_SESSION -- TUT_PROMPT',resume:'pi --print --mode json --session-id TUT_SESSION -- TUT_PROMPT',sample:'{"type":"session","id":"TUT_SESSION"}',args:[]},
  {id:'opencode',run:'opencode run --auto --format json -- TUT_PROMPT',resume:'opencode run --auto --format json --session session-sample -- TUT_PROMPT',sample:'{"type":"step_start","sessionID":"session-sample"}',args:['--auto']}
 ])('preserves the handwritten $id sample invocation in both modes without modifying bundled profiles',({id,run,resume,sample,args})=>{
  const hand=agentProfiles.get(id)!,before=hand.digest;
  const generated=new ProfileRegistry([inferProfile(id,parseCommandSample(run,'run'),parseCommandSample(resume,'resume'),sample)]).get(id)!;
  for(const mode of ['run','resume'] as const) {
   const facts={mode,checkoutRoot:'/checkout',prompt:'a prompt\nwith {literal} symbols',sessionId:id==='pi'?'12345678-1234-1234-1234-123456789abc':id==='opencode'?'ses_sample':'session-sample'};
   const actual=renderInvocation({...facts,profile:generated,route:{agent:id,args:[]}}),expected=renderInvocation({...facts,profile:hand,route:{agent:id,args}});
   expect(actual.status).toBe('ready');expect(expected.status).toBe('ready');
   if(actual.status==='ready'&&expected.status==='ready')expect(actual.invocation.argv).toEqual(expected.invocation.argv);
  }
  expect(agentProfiles.get(id)?.digest).toBe(before);
 });
 it('infers a nested session field and preserves quoted native arguments and prompt boundaries',()=>{
  const run=parseCommandSample('new-cli exec --label "two words" --empty "" -- TUT_PROMPT','run');
  const resume=parseCommandSample('new-cli continue --id session-abc -- TUT_PROMPT','resume');
  const sample='{"type":"connected","meta":{"id":"session-abc"}}';
  const value=inferProfile('new-cli',run,resume,sample),p=new ProfileRegistry([value]).get('new-cli')!;
  expect(value.invoke.route).toBe('passthrough');expect(value.usage.capability.tier).toBe('unsupported');
  expect(captureSession(p,sample)).toBe('session-abc');
  expect(captureSession(p,'{"type":"unrelated","meta":{"id":"session-abc"}}')).toBeUndefined();
  const prompt='spaces\n{literal} $HOME 😀';
  const result=renderInvocation({profile:p,mode:'run',route:{agent:'/bin/new-cli',args:['--option','one value']},checkoutRoot:'/checkout',prompt});
  expect(result.status).toBe('ready');
  if(result.status==='ready')expect(result.invocation.argv).toEqual(['exec','--label','two words','--empty','','--option','one value','--',prompt]);
  const continued=renderInvocation({profile:p,mode:'resume',route:{agent:'new-cli',args:[]},checkoutRoot:'/checkout',prompt,sessionId:'different-id'});
  expect(continued.status).toBe('ready');if(continued.status==='ready')expect(continued.invocation.argv).toEqual(['continue','--id','different-id','--',prompt]);
 });
 it('uses an explicit marker to resolve ambiguous output without inferring an agent by name',()=>{
  const run=parseCommandSample('brandnew --json TUT_PROMPT','run'),resume=parseCommandSample('brandnew --id TUT_SESSION TUT_PROMPT','resume');
  const p=inferProfile('brandnew',run,resume,'{"other":"not-a-session","nested":{"session":"TUT_SESSION"}}');
  expect(p.session.capture).toMatchObject({tier:'declarative',spec:{path:['nested','session']}});
  expect(p.invoke.model.tier).toBe('unsupported');
  const observed=inferProfile('brandnew',run,parseCommandSample('brandnew --id abc TUT_PROMPT','resume'),'{"session":"abc","part":{"session":"abc"}}');
  expect(observed.session.capture).toMatchObject({tier:'declarative',spec:{path:['session']}});
 });
 it('rejects malformed/partial templates, shell syntax and ambiguous session output with actionable explanations',()=>{
  for(const command of ['new-cli "TUT_PROMPT','new-cli hello','new-cli --prompt=TUT_PROMPT','new-cli TUT_PROMPT | cat','TOKEN=x new-cli TUT_PROMPT','new-cli --session=TUT_SESSION TUT_PROMPT','new-cli {args} {args} TUT_PROMPT','new-cli {json} TUT_PROMPT'])expect(()=>parseCommandSample(command,'run')).toThrow(/没看懂 run/u);
  const run=parseCommandSample('new-cli TUT_PROMPT','run'),resume=parseCommandSample('new-cli --id abc --other def TUT_PROMPT','resume');
  expect(()=>inferProfile('new-cli',run,resume,'not json')).toThrow(/一行完整 JSON/u);
  expect(()=>inferProfile('new-cli',run,resume,'{"id":"abc","other":"def"}')).toThrow(/2 个会话 ID 候选/u);
  expect(()=>inferProfile('new-cli',run,parseCommandSample('new-cli --id=abc TUT_PROMPT','resume'),'{"id":"abc"}')).toThrow(/独立参数/u);
 });
});

describe('bundled agent contracts', () => {
  it('uses frozen historical peer headers without registry reads while preserving later header rows',()=>{
    const profile=agentProfiles.get('codex')!,peer=agentProfiles.get('pi')!;
    const lookup=vi.spyOn(agentProfiles,'get');
    try {
      const text=[{type:peer.value.usage.source!.header.type,cwd:'/peer',version:3,id:'peer'},...Array.from({length:1000},()=>({type:'ordinary'})),{type:'session_meta',payload:{cwd:'/own'}}].map(value=>JSON.stringify(value)).join('\n')+'\n';
      const session=parseUsageSession(text,'sample.jsonl',profile);
      expect(lookup).not.toHaveBeenCalled();
      expect(session.header?.cwd).toBe('/peer');expect(session.rows.at(-1)?.header?.cwd).toBe('/own');
      lookup.mockClear();
      const custom=structuredClone(profile);Object.assign(custom,{id:'custom'});
      parseUsageSession(text,'sample.jsonl',custom);expect(lookup).not.toHaveBeenCalled();
    } finally {lookup.mockRestore();}
  });
  it('validates, expands and freezes profiles without changing native defaults', () => {
    expect(agentProfiles.diagnostics).toEqual([]);
    for (const p of agentProfiles.all()) {
      expect(p.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(Object.isFrozen(p.value.invoke)).toBe(true);
      expect(p.value.platform_overrides).toEqual({});
    }
    expect(agentProfiles.match('cli.js', 'win32')).toBeUndefined();
    expect(agentProfiles.match('cli.js', 'win32', 'pi')?.id).toBe('pi');
    expect(agentProfiles.get('opencode', 'win32')).toBeUndefined();
  });

  it('onboards a different executable using data and preserves the single prompt argument', async () => {
    const value = candidate();
    value.id = 'sample-agent';
    value.match.supported_executable_names = ['sample-agent'];
    const registry = new ProfileRegistry([value]);
    const p = registry.match('/opt/bin/sample-agent')!;
    const prompt = '空 格\n$HOME `literal` 😀';
    const result = await invoke({...request(p,'/opt/bin/sample-agent'),prompt});
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw Error(result.reason);
    expect(result.invocation.argv.at(-1)).toBe(prompt);
    expect(result.invocation.envPatch.PWD).toBe('/checkout');
    expect(result.invocation.cwd).toBe('/checkout');
    expect(result.invocation.sessionPlan.identity_source).toBe('observed');
    expect(registry.get('sample-agent')?.digest).toBe(new ProfileRegistry([value]).get('sample-agent')?.digest);
  });

  it('isolates bad profiles and disables every ambiguous executable match', () => {
    const a = candidate(), b = candidate();
    b.id = 'collision';
    const registry = new ProfileRegistry([a,b,agentProfiles.get('pi')!.value]);
    expect(registry.match('opencode')).toBeUndefined();
    expect(registry.get('pi')).toBeDefined();
    const duplicated = new ProfileRegistry([a,a,agentProfiles.get('codex')!.value]);
    expect(duplicated.get('opencode')).toBeUndefined();
    expect(duplicated.get('codex')).toBeDefined();
    const bad = new ProfileRegistry([{id:'broken'},agentProfiles.get('pi')!.value]);
    expect(bad.diagnostics[0]?.code).toBe('PROFILE_INVALID');
    expect(bad.get('pi')).toBeDefined();
  });

  it('rejects unsafe paths, regexes, hook names, unknown keys and contradictory usage', () => {
    const mutate = (fn:(p:ReturnType<typeof candidate>)=>void) => {const p=candidate();fn(p);return ()=>validateProfile(p);};
    expect(mutate(p=>{p.session.id_validation.pattern='^(a+)+$';})).toThrow();
    expect(mutate(p=>{p.session.id_validation.pattern='^.*$';})).toThrow();
    expect(mutate(p=>{if(p.session.capture.tier==='declarative'&&p.session.capture.spec.kind==='json-line')p.session.capture.spec.path=['__proto__','id'];})).toThrow();
    expect(mutate(p=>{Object.assign(p.invoke.run,{tier:'assisted',hook:'arbitrary-module'});})).toThrow();
    expect(mutate(p=>{Object.assign(p,{unexpected:true});})).toThrow();
    expect(mutate(p=>{p.usage.readable_formats=['task-usage-v1'];})).toThrow();
    expect(mutate(p=>{p.platform_overrides.posix={invoke:{run:{tier:'unsupported',reason:'not verified'}}};Object.assign(p.platform_overrides.posix,{unknown:true});})).toThrow();
  });

  it('requires guarded complete JSON evidence and keeps unsupported usage read-only', async () => {
    const p = agentProfiles.get('opencode')!;
    const native = {type:'step_start',timestamp:1,sessionID:'ses_ABC123'};
    expect(captureSession(p,JSON.stringify(native))).toBe(native.sessionID);
    expect(captureSession(p,JSON.stringify({...native,timestamp:'1'}))).toBeUndefined();
    expect(captureSession(p,JSON.stringify({...native,type:'unrecognized'}))).toBeUndefined();
    expect(captureSession(p,'{"type":')).toBeUndefined();
    let reads=0;
    const ref:UsageSessionRef={profile:p,attribution:'legacy-cwd-window-v1',round:{task_id:'sample',role:'executor',agent:p.id,route:{agent:'opencode',args:['--auto']},launch_version:1,delivery_version:2,launch_ts:'2026-01-01T00:00:00Z',delivery_ts:'2026-01-01T00:00:01Z',cwd:'/checkout'}};
    const services:ReadServices={facts:{platform:'posix',home:'/home',auditCwd:'/checkout',codexRoot:'/sessions',piEnv:{}},list:async()=>{reads++;return [];},readLines:async()=>({lines:[],partial:false}),readSettings:async()=>undefined,readHead:async()=>'',readRun:async()=>{throw Error('unexpected read');},readRunLog:async()=>{throw Error('unexpected read');}};
    const result=await readUsage(ref,services);
    expect(result.status).toBe('unsupported');
    expect(reads).toBe(0);
    const unsupported = candidate();
    unsupported.evidence.platforms.push('win32');
    unsupported.platform_overrides.win32={invoke:{run:{tier:'unsupported',reason:'platform-unverified'}}};
    const windows = new ProfileRegistry([unsupported]).get('opencode','win32')!;
    expect((await invoke(request(windows,'opencode','C:\\checkout'))).status).toBe('unsupported');
  });
  it('shows unsupported and mixed usage without turning unknown measurements into zero', () => {
    const browser=vm.createContext({setTimeout,clearTimeout,AbortController,Date});
    vm.runInContext(BOARD_UI_SCRIPT.slice(BOARD_UI_SCRIPT.indexOf('function tokenTotal('),BOARD_UI_SCRIPT.indexOf('let hubRoot=')),browser);
    const unsupported={delivery_version:2,reason:'unsupported_agent',agent:'opencode',reason_code:'usage-source-unverified',capability:'unsupported'};
    const mixed=browser.tokenTotal({schema_version:1,rounds:[{total_tokens:7,cost_usd:null}],unresolved:[unsupported,{reason:'missing_session_or_end'}]});
    expect(mixed).toContain('7 tok · partial · 2 未计轮');expect(mixed).toContain('usage-source-unverified');expect(mixed).toContain('missing_session_or_end');
    expect(browser.tokenTotal({schema_version:1,rounds:[],unresolved:[unsupported]})).toContain('usage: 不支持');
    expect(browser.tokenTotal({schema_version:1,rounds:[{total_tokens:7}],unresolved:[unsupported]})).toContain('7 tok · partial · 1 未计轮');
    expect(browser.tokenTotal({schema_version:1,rounds:[],unresolved:[{reason:'missing_session_or_end'}]})).toContain('unknown');
    expect(browser.tokenTotal({schema_version:1,rounds:[],unresolved:[unsupported,{reason:'missing_session_or_end'}]})).toContain('unknown');
  });

});

describe('flat command profiles',()=>{
  it('expands named values once without splitting or evaluating their contents',async()=>{
    const value=structuredClone(agentProfiles.get('codex')!.value);
    value.invoke.run={tier:'declarative',spec:'codex exec --model {model} --effort {effort} --cwd {cwd} "literal words" {prompt}'};
    const profile=new ProfileRegistry([value]).get('codex')!;
    const prompt='空 格\n$HOME `literal` {session} 😀',cwd='/checkout with space';
    const result=await invoke({...request(profile,'codex',cwd),prompt,route:{agent:'codex',args:['-m','native-model','-c','model_reasoning_effort=high']}});
    expect(result.status).toBe('ready');
    if(result.status==='ready')expect(result.invocation.argv).toEqual(['exec','--model','native-model','--effort','high','--cwd',cwd,'literal words',prompt]);
    expect((await invoke({...request(profile),route:{agent:'codex',args:[]}}))).toMatchObject({status:'invalid',code:'TEMPLATE_VALUE_REQUIRED'});
  });

  it.each([
    {slot:'model',flag:'--model',args:['--model','actual-model','--system-prompt','--model=prompt-text'],expected:'actual-model'},
    {slot:'effort',flag:'--thinking',args:['--thinking','low','--system-prompt','--thinking=high'],expected:'low'},
    {slot:'model',flag:'--model',args:['--system-prompt','--model','--print'],expected:null},
    {slot:'effort',flag:'--thinking',args:['--append-system-prompt','--thinking','--print'],expected:null},
    {slot:'model',flag:'--model',args:['--model','first','--system-prompt','--model=prompt-text','--model','last'],expected:'last'},
    {slot:'effort',flag:'--thinking',args:['--thinking','low','--system-prompt','--thinking=high','--thinking','medium'],expected:'medium'},
    {slot:'model',flag:'--model',args:['--model','first','--model=last','--system-prompt','--model=prompt-text'],expected:'last'},
    {slot:'effort',flag:'--thinking',args:['--thinking','low','--thinking=medium','--append-system-prompt','--thinking=high'],expected:'medium'},
    {slot:'effort',flag:'--thinking',args:['--model','--thinking=high','--thinking','low'],expected:'low'},
    {slot:'model',flag:'--model',args:['--thinking','--model=prompt-text','--model','actual-model'],expected:'actual-model'},
  ])('uses only actual Pi option positions for $slot: $args',async({slot,flag,args,expected})=>{
    const value=structuredClone(agentProfiles.get('pi')!.value);
    value.invoke.run={tier:'declarative',spec:`pi ${flag} {${slot}} --session-id {session} -- {prompt}`};
    const profile=new ProfileRegistry([value]).get('pi')!;
    const result=await invoke({...request(profile),route:{agent:'pi',args},environmentFacts:{home:'/home',env:{},designated_id:'96b72f6c-e9c0-4d5d-94fa-a91611f02198'}});
    if(expected===null)expect(result).toMatchObject({status:'invalid',code:'TEMPLATE_VALUE_REQUIRED'});
    else {
      expect(result.status).toBe('ready');
      if(result.status==='ready')expect(result.invocation.argv).toEqual([flag,expected,'--session-id','96b72f6c-e9c0-4d5d-94fa-a91611f02198','--','hello']);
    }
  });

  it('accepts a new command without a route grammar or native plain parser',async()=>{
    const value=candidate();value.id='simple';value.match.supported_executable_names=['simple'];
    value.invoke.run={tier:'declarative',spec:'simple exec --json {args} {prompt}'};
    value.invoke.resume={tier:'declarative',spec:'simple exec --json --session {session} {args} {prompt}'};
    value.session.legacy_plain_argv={tier:'unsupported',reason:'no historical argv contract'};
    const {route,...withoutRoute}=value.invoke;const raw={...value,invoke:withoutRoute};
    const registry=new ProfileRegistry([raw]),profile=registry.get('simple')!;
    expect(registry.diagnostics).toEqual([]);
    const result=await invoke({...request(profile,'simple'),route:{agent:'simple',args:['--native-option','a value']}});
    expect(result.status).toBe('ready');
    if(result.status==='ready')expect(result.invocation.argv).toEqual(['exec','--json','--native-option','a value','hello']);
  });

  it('fails closed on retired schemas and malformed or contradictory command templates',()=>{
    expect(()=>validateProfile({...candidate(),schema_version:1})).toThrow(/v1 token grammar is retired/u);
    for(const command of ['opencode run {unknown} {prompt}','opencode run prefix{prompt}','opencode run "unfinished {prompt}','opencode {args} {options} {prompt}','opencode {prompt} {prompt}','opencode run','{prompt} run','opencode {executable} {prompt}','opencode {session} {prompt}']) {
      const value=candidate();value.invoke.run={tier:'declarative',spec:command};
      expect(()=>validateProfile(value)).toThrow();
    }
    const value=candidate();value.invoke.resume={tier:'declarative',spec:'opencode run {prompt}'};
    expect(()=>validateProfile(value)).toThrow(/resume command needs/u);
    const override=candidate();override.platform_overrides.posix={invoke:{run:{tier:'declarative',spec:'opencode {prompt} {prompt}'}}};
    expect(new ProfileRegistry([override]).get('opencode')).toBeUndefined();
  });
});

describe('opaque agents capability facade',()=>{
 it('preserves all three invocation/capture contracts without exposing profile trees',async()=>{
  const api=await import('../../../src/agents/public/index.js');
  const snapshot={values:[],diagnostics:[],overridden:[]};
  for(const id of ['codex','pi','opencode'] as const) {
   const result=api.resolveContract({agent:id},snapshot,'posix');expect(result.status).toBe('resolved');if(result.status!=='resolved')throw Error('missing contract');
   const handle=result.handle,p=agentProfiles.get(id)!;
   expect('value' in handle).toBe(false);expect(Object.isFrozen(handle)).toBe(true);
   const input={...request(p,id),route:{agent:id,args:id==='opencode'?['--auto']:[]},environmentFacts:{home:'/home',env:{},designated_id:'12345678-1234-1234-1234-123456789abc'}};
   const {profile:_,platform:__,...facts}=input;
   const actual=await api.prepareInvocation(handle,facts),baseline=await invoke(input);
   expect(actual.status).toBe(baseline.status);
   if(actual.status==='ready'&&baseline.status==='ready') {
    const {input,key,logicalArgv,...invocation}=actual.invocation;
    expect(logicalArgv).toEqual([baseline.invocation.executable,...baseline.invocation.argv]);
    expect(invocation).toEqual(baseline.invocation);expect(input.kind).toBe('none');expect(key).toEqual(handle.key);
   }
   const decoded=api.decodeContract(api.encodeContract(handle));
   expect(decoded).toEqual(handle);expect('value' in decoded).toBe(false);
   const line=id==='codex'?JSON.stringify({type:'thread.started',thread_id:'observed'}):id==='opencode'?JSON.stringify({type:'step_start',timestamp:1,sessionID:'ses_ABC'}):'native output';
   expect(api.observeSession(decoded,line)).toBe(captureSession(p,line));
   const tampered=JSON.parse(api.encodeContract(handle));tampered.key.digest='other';expect(()=>api.decodeContract(JSON.stringify(tampered))).toThrow('CONTRACT_CODEC_INVALID');
  }
 });
 it('round-trips every schema-valid profile without introducing a transport size refusal',async()=>{
  const api=await import('../../../src/agents/public/index.js');
  const profile=structuredClone(agentProfiles.get('codex')!.value);profile.evidence.note='x'.repeat(1024*1024+1);
  const resolved=api.resolveContract({agent:'codex'},{values:[profile],diagnostics:[],overridden:['codex']},'posix');
  if(resolved.status!=='resolved')throw Error('valid profile refused');
  expect(api.decodeContract(api.encodeContract(resolved.handle))).toEqual(resolved.handle);
 });
 it('freezes an injected snapshot and refuses a bad override instead of falling back',async()=>{
  const api=await import('../../../src/agents/public/index.js');
  const raw=structuredClone(agentProfiles.get('opencode')!.value);raw.id='other';raw.match.supported_executable_names=['different'];
  const snapshot={values:[raw],diagnostics:[],overridden:[]};const result=api.resolveContract({agent:'different'},snapshot,'posix');
  expect(result.status).toBe('resolved');if(result.status!=='resolved')return;
  raw.invoke.run={tier:'unsupported',reason:'changed'};
  expect(result.handle.capabilities.invoke).toBe(true);
  expect(api.resolveContract({agent:'opencode'},{values:[{id:'opencode'}],diagnostics:[],overridden:['opencode']},'posix').status).toBe('invalid');
 });
 it('selects exact sessions and keeps native store verification inside agents',async()=>{
  const api=await import('../../../src/agents/public/index.js');
  const resolved=api.resolveContract({agent:'pi'},{values:[],diagnostics:[],overridden:[]},'posix');if(resolved.status!=='resolved')throw Error('missing pi');
  const id='12345678-1234-1234-1234-123456789abc',run={run_id:'source',cwd:'/checkout',argv:['pi','--print','--mode','json','--session-id',id,'--','old'],headless:{role:'executor',route:{agent:'pi',args:[]},designated_session_id:id}};
  const selected=api.selectSession(resolved.handle,run);expect(selected.status).toBe('selected');if(selected.status!=='selected')return;
  const reads={nativeSessionBase:'/sessions',entries:async(directory:string)=>{expect(directory).toBe('/sessions/--checkout--');return ['one.jsonl'];},readHead:async(_file:string,max:number)=>{expect(max).toBe(8192);return JSON.stringify({type:'session',id,cwd:'/checkout'})+'\n';}};
  expect((await api.verifySession(resolved.handle,selected.session,reads)).status).toBe('verified');
  expect((await api.verifySession(resolved.handle,selected.session,{...reads,readHead:async()=>JSON.stringify({type:'session',id,cwd:'/wrong'})+'\n'})).status).toBe('invalid');
  expect((await api.verifySession(resolved.handle,selected.session,{...reads,entries:async()=>[]})).status).toBe('invalid');
  expect(api.occupiedSessions(resolved.handle,run)).toContainEqual({agent:'pi',session_id:id});
 });
 it('binds usage as an opaque reference and preserves unavailable outcomes',async()=>{
  const api=await import('../../../src/agents/public/index.js');
  const snapshot={values:[],diagnostics:[],overridden:[]};
  const a=api.resolveContract({agent:'codex'},snapshot,'posix'),b=api.resolveContract({agent:'opencode'},snapshot,'posix');
  if(a.status!=='resolved'||b.status!=='resolved')throw Error('missing profiles');
  const round={task_id:'task',role:'executor',agent:'codex',route:{agent:'codex',args:[]},cwd:'/checkout',launch_version:1,delivery_version:2,launch_ts:'2026-01-01T00:00:00Z',delivery_ts:'2026-01-01T00:01:00Z'};
  const bound=api.bindUsage(a.handle,round);expect(bound.status).toBe('bound');if(bound.status!=='bound')return;
  expect(Object.keys(bound.ref)).toEqual(['key']);expect(Object.isFrozen(bound.ref)).toBe(true);
  const services={facts:{home:'/home',auditCwd:'/checkout',platform:'posix' as const,codexRoot:'/native',piEnv:{}},list:async()=>[],readLines:async()=>({lines:[],partial:false}),readSettings:async()=>undefined,readHead:async()=>'',readRun:async()=>{throw Error('not needed');},readRunLog:async()=>{throw Error('not needed');}};
  expect((await api.readUsage(bound.ref,services)).status).toBe('pending');
  expect(api.bindUsage(b.handle,{...round,agent:'opencode'}).status).toBe('unavailable');
 });
});

describe('public usage snapshot closure',()=>{
 const emptySnapshot=()=>({values:[] as unknown[],diagnostics:[],overridden:[] as string[]});
 const round={task_id:'task',role:'executor',agent:'codex',route:{agent:'codex',args:[]},cwd:'/checkout',launch_version:1,delivery_version:2,launch_ts:'2026-01-01T00:00:00Z',delivery_ts:'2026-01-01T00:00:20Z'};
 const rows=(header:unknown)=>[header,{type:'event_msg',timestamp:'2026-01-01T00:00:10Z',payload:{type:'task_started',turn_id:'t'}},{type:'event_msg',timestamp:'2026-01-01T00:00:20Z',payload:{type:'token_count',info:{total_token_usage:{input_tokens:7,output_tokens:3,total_tokens:10}}}},{type:'event_msg',timestamp:'2026-01-01T00:00:30Z',payload:{type:'task_complete',turn_id:'t'}}].map(x=>JSON.stringify(x));
 function services(lines:string[],duringRead=()=>{}) {
  return {facts:{home:'/home',auditCwd:'/checkout',profileRoot:'/rig-a',platform:'posix' as const,codexRoot:'/native',piEnv:{}},list:async()=>['/native/file.jsonl'],readLines:async()=>{duringRead();return {lines,partial:false};},readSettings:async()=>undefined,readHead:async()=>'',readRun:async()=>{throw Error('not needed');},readRunLog:async()=>{throw Error('not needed');}};
 }
 it.each(['disabled','unavailable','other-rig'] as const)('keeps a bound reference stable when live configuration becomes %s during I/O',async change=>{
  const api=await import('../../../src/agents/public/index.js');
  const {configureProfileSource}=await import('../../../src/agents/public/configuration.js');
  const source=await import('../../../src/core/agents/profile-source.js');
  let loads=0,changed=false;
  const invalidPeer={values:[{id:'pi'}],diagnostics:[],overridden:['pi']};
  configureProfileSource({load(){loads++;if(changed&&change==='unavailable')throw Error('live loader unavailable');return changed?invalidPeer:emptySnapshot();},withSnapshot:(_root,action)=>action()});
  try {
   const selected=api.resolveContract({agent:'codex'},emptySnapshot(),'posix');if(selected.status!=='resolved')throw Error('missing contract');
   const bound=api.bindUsage(selected.handle,round);if(bound.status!=='bound')throw Error('missing usage');
   const io=services(rows({type:'session',cwd:'/checkout',version:3,id:'peer'}));
   const before=await api.readUsage(bound.ref,io);expect(before.status).toBe('measured');
   const after=await api.readUsage(bound.ref,{...io,facts:{...io.facts,profileRoot:change==='other-rig'?'/rig-b':'/rig-a'},readLines:async()=>{changed=true;return {lines:rows({type:'session',cwd:'/checkout',version:3,id:'peer'}),partial:false};}});
   expect(after).toEqual(before);expect(loads).toBe(0);
   const next=api.resolveContract({agent:'codex'},invalidPeer,'posix');if(next.status!=='resolved')throw Error('missing next contract');
   expect(next.handle.digest).toBe(selected.handle.digest);expect(next.handle.sourceKey).not.toBe(selected.handle.sourceKey);
   const nextBound=api.bindUsage(next.handle,round);if(nextBound.status!=='bound')throw Error('missing next usage');
   expect(nextBound.ref.key).not.toBe(bound.ref.key);expect((await api.readUsage(nextBound.ref,io)).status).toBe('pending');
   const decoded=api.decodeContract(api.encodeContract(selected.handle));expect(decoded.sourceKey).toBe(selected.handle.sourceKey);
   const restored=api.bindUsage(decoded,round);if(restored.status!=='bound')throw Error('missing restored usage');
   expect(await api.readUsage(restored.ref,io)).toEqual(before);expect(loads).toBe(0);
  }finally{configureProfileSource({load:source.loadProfileSource,withSnapshot:source.withAgentProfileSnapshot});}
 });
 it('separates two rigs by peer rules and reuses two stationary reads under the complete source key',async()=>{
  const api=await import('../../../src/agents/public/index.js'),usage=await import('../../../src/agents/public/usage.js');
  const handles:import('../../../src/agents/public/index.js').ContractHandle[]=[];
  for(const key of ['a','b']) {
   const peer=structuredClone(agentProfiles.get('pi')!.value),source=peer.usage.source!;
   source.header.cwd=[key,'cwd'];source.header.version=[key,'version'];
   peer.usage.capability={tier:'declarative',spec:structuredClone(source)};
   const selected=api.resolveContract({agent:'codex'},{values:[peer],diagnostics:[],overridden:['pi']},'posix');if(selected.status!=='resolved')throw Error('missing rig');
   handles.push(selected.handle);
  }
  expect(handles[0]!.digest).toBe(handles[1]!.digest);expect(handles[0]!.sourceKey).not.toBe(handles[1]!.sourceKey);
  const lines=rows({type:'session',a:{cwd:'/checkout',version:3}}),cache=new Map<string,ReturnType<typeof usage.parseUsageSource>>();let parses=0;
  const io={...services(lines),loadSource:async(file:string,handle:typeof handles[number])=>{
   if(!cache.has(handle.sourceKey)){parses++;cache.set(handle.sourceKey,usage.parseUsageSource(lines.join('\n')+'\n',file,handle));}
   return cache.get(handle.sourceKey)!;
  }};
  for(const [index,handle] of handles.entries()) {
   const bound=api.bindUsage(handle,round);if(bound.status!=='bound')throw Error('missing usage');
   expect((await api.readUsage(bound.ref,io)).status).toBe(index===0?'measured':'pending');
   expect((await api.readUsage(bound.ref,io)).status).toBe(index===0?'measured':'pending');
   expect(parses).toBe(index+1);
  }
 });
});

describe('resume capability and snapshot closure',()=>{
 const snapshot={values:[],diagnostics:[],overridden:[]};
 it('distinguishes basic, capture-only, resumable and invalid session contracts',async()=>{
  const api=await import('../../../src/agents/public/index.js');
  const basic=api.resolveContract({agent:'binding:worker-x'},{...snapshot,bindings:{'worker-x':{schema_version:1,id:'worker-x',command:{executable:'worker-x',argv:[{slot:'prompt'}]},input:{kind:'argv'}}}},'posix');
  expect(basic.status).toBe('resolved');if(basic.status!=='resolved')throw Error('basic missing');
  const run={run_id:'source',cwd:'/checkout',argv:['worker-x','old'],agent_session_id:'ses_CAPTURED'};
  expect(api.selectSession(basic.handle,run)).toMatchObject({status:'unavailable',reason:'RESUME_UNAVAILABLE'});
  expect(api.occupiedSessions(basic.handle,run)).toEqual([]);
  const raw=structuredClone(agentProfiles.get('opencode')!.value);raw.invoke.resume={tier:'unsupported',reason:'not configured'};
  const capture=api.resolveContract({agent:'opencode'},{values:[raw],diagnostics:[],overridden:['opencode']},'posix');
  if(capture.status!=='resolved')throw Error('capture contract missing');
  expect(api.observeSession(capture.handle,JSON.stringify({type:'step_start',timestamp:1,sessionID:'ses_CAPTURED'}))).toBe('ses_CAPTURED');
  expect(api.selectSession(capture.handle,{...run,argv:['opencode','run','--auto','--','old']})).toMatchObject({status:'unavailable'});
  const full=api.resolveContract({agent:'opencode'},snapshot,'posix');if(full.status!=='resolved')throw Error('native missing');
  const selected=api.selectSession(full.handle,{...run,argv:['opencode','run','--auto','--','old']});
  expect(selected.status).toBe('selected');if(selected.status!=='selected')throw Error('not selected');
  const io={entries:async()=>[],readHead:async()=>undefined};
  expect(await api.verifySession(full.handle,selected.session,io)).toMatchObject({status:'verified'});
  expect(await api.verifySession(full.handle,{...selected.session,evidence:{...selected.session.evidence,run_id:'other'}},io)).toMatchObject({status:'invalid',code:'SESSION_SOURCE_INVALID'});
  expect(api.resolveContract({agent:'opencode'},{values:[{id:'opencode'}],diagnostics:[],overridden:['opencode']},'posix')).toMatchObject({status:'invalid'});
 });
 it('projects aliases into the same native occupancy namespace and rejects conflicting evidence',async()=>{
  const api=await import('../../../src/agents/public/index.js');
  const aliases=['native-a','native-b'].map(id=>{const raw=structuredClone(agentProfiles.get('opencode')!.value);raw.id=id;raw.match.supported_executable_names=[id];return raw;});
  const source={values:aliases,diagnostics:[],overridden:[]};
  for(const id of ['native-a','native-b']) {
   const contract=api.resolveContract({agent:id},source,'posix');if(contract.status!=='resolved')throw Error('alias missing');
   expect(contract.handle.identity).toBe('opencode');
   const run={run_id:'source',cwd:'/checkout',argv:[id,'run','--auto','--','old'],agent_session_id:'ses_SAME'};
   expect(api.runSessionIdentities({...run,contract:api.encodeContract(contract.handle)},snapshot)).toEqual([{agent:'opencode',session_id:'ses_SAME'}]);
   expect(api.selectSession(contract.handle,{...run,resume:{agent:id,session_id:'ses_DIFFERENT'}})).toMatchObject({status:'invalid',code:'SESSION_IDENTITY_CONFLICT'});
  }
 });
 it('decodes a frozen run without consulting live configuration and refuses corrupt snapshots',async()=>{
  const api=await import('../../../src/agents/public/index.js');
  const selected=api.resolveContract({agent:'codex'},snapshot,'posix');if(selected.status!=='resolved')throw Error('native missing');
  const run={run_id:'source',cwd:'/checkout',argv:['codex','exec','old'],agent_session_id:'thread-snapshot',contract:api.encodeContract(selected.handle)};
  const unavailable=()=>{throw Error('live configuration unavailable');};
  expect(api.resolveRunContract(run,unavailable,'posix')).toMatchObject({status:'resolved',handle:selected.handle});
  expect(api.resolveRunContract({...run,contract:'broken'},snapshot,'posix')).toMatchObject({status:'invalid',code:'CONTRACT_INVALID'});
  expect(api.resolveRunContract({...run,contract:null},snapshot,'posix')).toMatchObject({status:'invalid',code:'CONTRACT_INVALID'});
  expect(api.resolveRunContract({...run,argv:['sh','-c','codex']},snapshot,'posix')).toMatchObject({status:'invalid',code:'unsupported-agent'});
 });
});

it('binds usage from persisted minimal intent without rewriting or weakening protected native declarations',async()=>{
 const api=await import('../../../src/agents/public/index.js');
 const intent={executable:'worker-x',args:['exec','fixed'],prompt:{kind:'argv',index:1}},before=JSON.stringify(intent);
 const snapshot={values:[],diagnostics:[],overridden:[],bindings:{'worker-x':intent}};
 const selected=api.resolveContract({agent:'binding:worker-x'},snapshot,'posix');expect(selected.status).toBe('resolved');
 if(selected.status!=='resolved')throw Error('persisted intent not resolved');
 const round={task_id:'task',role:'executor',agent:'worker-x',route:{agent:'binding:worker-x',args:[]},cwd:'/checkout',launch_version:1,delivery_version:2,launch_ts:'2026-01-01T00:00:00Z',delivery_ts:'2026-01-01T00:01:00Z'};
 expect(api.bindUsage(selected.handle,round)).toEqual({status:'unavailable',reason:'not-declared'});
 expect(JSON.stringify(intent)).toBe(before);
 const native={...snapshot,bindings:{'worker-x':{...intent,executable:'pi'}}};
 expect(api.resolveContract({agent:'binding:worker-x'},native,'posix')).toMatchObject({status:'invalid',reason:expect.stringContaining('BINDING_NATIVE_CONFLICT')});
 expect(api.resolveContract({agent:'binding:worker-x'},{...snapshot,bindings:{'worker-x':{...intent,prompt:{kind:'argv',index:99}}}},'posix')).toMatchObject({status:'invalid'});
});

it('shares the compiled source registry when adding a frozen binding view',async()=>{
 const api=await import('../../../src/agents/public/index.js');
 const source={values:[],diagnostics:[],overridden:[]};
 const before=api.resolveContract({agent:'codex'},source,'posix');
 const view=api.withContractBindings(source,{'worker-x':{executable:'worker-x',args:[],prompt:{kind:'stdin'}}});
 const during=api.resolveContract({agent:'codex'},view,'posix');
 if(before.status!=='resolved'||during.status!=='resolved')throw Error('missing profile');
 expect(during.handle).toBe(before.handle);
 expect(api.resolveContract({agent:'binding:worker-x'},view,'posix').status).toBe('resolved');
 expect(api.resolveContract({agent:'binding:worker-x'},source,'posix').status).toBe('invalid');
});

describe('minimal invocation declaration schema',()=>{
 const binding={schema_version:1,id:'worker-x',command:{executable:'/apps/worker x/cli',argv:['run',{slot:'args'},{slot:'prompt'}]},input:{kind:'argv'}};
 it('keeps argv order and spaces and renders instructions from runtime schemas',async()=>{
  const {validateInvocationBinding,renderAgentOnboarding,authoringSchemas}=await import('../../../src/agents/public/configuration.js');
  expect(validateInvocationBinding(binding,'worker-x')).toEqual(binding);
  const {readFileSync}=await import('node:fs');
  expect(readFileSync('skills/agent-onboarding.md','utf8')).toBe(renderAgentOnboarding());
  expect(authoringSchemas().binding).toHaveProperty('properties.command');
 });
 it.each([
  [{...binding,id:'../bad'},'id'],
  [{...binding,command:{...binding.command,executable:''}},'command.executable'],
  [{...binding,command:{...binding.command,executable:'bash'}},'command.executable'],
  [{...binding,command:{...binding.command,argv:[{slot:'args'},{slot:'args'},{slot:'prompt'}]}},'command.argv.1'],
  [{...binding,command:{...binding.command,argv:[{slot:'args'}]}},'command.argv'],
  [{...binding,input:{kind:'stdin',encoding:'utf8'}},'command.argv.2'],
  [{...binding,command:{...binding.command,argv:['bad\0value',{slot:'prompt'}]}},'command.argv.0'],
  [{...binding,command:{...binding.command,argv:['${code}',{slot:'prompt'}]}},'command.argv.0'],
  [{...binding,command:{...binding.command,argv:['--prompt={prompt}',{slot:'prompt'}]}},'command.argv.0'],
 ])('rejects malformed declarations at the exact field',async(raw,field)=>{
  const {validateInvocationBinding}=await import('../../../src/agents/public/configuration.js');
  expect(()=>validateInvocationBinding(raw)).toThrow(field);
 });
 it('requires an args slot only when route args are supplied, and never falls back',async()=>{
  const {resolveBindingReference}=await import('../../../src/agents/public/configuration.js');
  const noArgs={...binding,command:{...binding.command,argv:[{slot:'prompt'}]}};
  expect(resolveBindingReference('ordinary-cli',[],{})).toBeUndefined();
  expect(resolveBindingReference('binding:worker-x',[],{'worker-x':noArgs})).toEqual(noArgs);
  expect(()=>resolveBindingReference('binding:worker-x',['--extra'],{'worker-x':noArgs})).toThrow('command.argv');
  expect(()=>resolveBindingReference('binding:codex',[],{})).toThrow('binding not found');
  expect(()=>resolveBindingReference('binding:worker-x',[],{'worker-x':{...binding,input:{kind:'bad'}}})).toThrow('input');
 });
});

describe('basic contracts through the shared public facade',()=>{
 const declaration=(kind:'argv'|'stdin'='argv')=>({schema_version:1,id:'worker-x',command:{executable:'/tools/worker x',argv:['/scripts/one.js',{slot:'args'},...(kind==='argv'?[{slot:'prompt'}]:[])]},input:kind==='argv'?{kind:'argv'}:{kind:'stdin',encoding:'utf8'}});
 const snapshot=(raw:unknown)=>({values:[],diagnostics:[],overridden:[],bindings:{'worker-x':raw}});
 const facts=():import('../../../src/agents/public/index.js').InvocationFacts=>({mode:'run',route:{agent:'binding:worker-x',args:['--model','first','--model','second','literal $HOME']},checkoutRoot:'/checkout path',prompt:'原样\nprompt $HOME',environmentFacts:{home:'/home',env:{PWD:'/old',TUT_HUB_URL:'http://127.0.0.1:3001'}},entry:'auto',origin:'managed'});
 it.each(['argv','stdin'] as const)('compiles %s and round-trips its frozen opaque contract without a generated profile',async kind=>{
  const api=await import('../../../src/agents/public/index.js');
  const raw=declaration(kind),source=snapshot(raw),selected=api.resolveContract({agent:'binding:worker-x'},source,'posix');
  expect(selected.status).toBe('resolved');if(selected.status!=='resolved')throw Error('missing basic contract');
  const handle=selected.handle,request=facts(),before=structuredClone(request);
  expect(handle).toMatchObject({source:'binding',identity:'binding:worker-x',capabilities:{invoke:true,resume:false,observe:false,usage:false}});
  expect('value' in handle).toBe(false);expect('binding' in handle).toBe(false);
  raw.command.executable='/changed';raw.command.argv.length=0;
  const ready=await api.prepareInvocation(handle,request);expect(ready.status).toBe('ready');if(ready.status!=='ready')throw Error('not ready');
  expect(ready.invocation.executable).toBe('/tools/worker x');
  expect(ready.invocation.argv).toEqual(['/scripts/one.js',...request.route.args,...(kind==='argv'?[request.prompt]:[])]);
  expect(ready.invocation).toMatchObject({cwd:request.checkoutRoot,envPatch:{PWD:request.checkoutRoot},key:handle.key,sessionPlan:{identity_source:'none',admission:{agent:'binding:worker-x',selectors:null}}});
  expect(ready.invocation.input).toEqual(kind==='argv'?{kind:'none'}:{kind:'stdin',encoding:'utf8',text:request.prompt});
  expect(request).toEqual(before);request.route.args[0]='changed';
  expect(ready.invocation.argv).toContain('--model');expect(Object.isFrozen(ready.invocation.argv)).toBe(true);expect(Object.isFrozen(ready.invocation.sessionPlan)).toBe(true);
  const token=api.encodeContract(handle),decoded=api.decodeContract(token);
  expect(JSON.parse(token).profile).toBeUndefined();expect(token).not.toContain('TUT_HUB_URL');
  expect(decoded).toEqual(handle);expect(await api.prepareInvocation(decoded,before)).toEqual(ready);
  expect(api.observeSession(decoded,'{"sessionID":"ses_guess"}')).toBeUndefined();
  expect(api.occupiedSessions(decoded,{run_id:'r',cwd:'/checkout',argv:['tool','resume','guess'],agent_session_id:'guess'})).toEqual([]);
  expect(api.selectSession(decoded,{run_id:'r',cwd:'/checkout',argv:[]})).toMatchObject({status:'unavailable'});
  expect(await api.verifySession(decoded,{} as never,{} as never)).toMatchObject({status:'unavailable'});
  expect(api.bindUsage(decoded,{} as never)).toMatchObject({status:'unavailable'});
  expect(await api.prepareInvocation(decoded,{...before,mode:'resume'})).toMatchObject({status:'unavailable',reason:'resume-unavailable'});
 });
 it('checks source/route/slots/NUL/UTF-8 bounds and never borrows a profile for an explicit reference',async()=>{
  const api=await import('../../../src/agents/public/index.js');
  for(const bindings of [{},{'worker-x':{id:'bad'}},{'worker-x':{...declaration(),id:'other'}}])expect(api.resolveContract({agent:'binding:worker-x'},{values:[],diagnostics:[],overridden:[],bindings},'posix').status).toBe('invalid');
  expect(api.resolveContract({agent:'binding:codex'},snapshot(declaration()),'posix').status).toBe('invalid');
  expect(api.resolveContract({agent:'binding:worker-x'},{...snapshot(declaration()),bindingError:'config broken'},'posix')).toMatchObject({status:'invalid',code:'BINDING_SOURCE_INVALID'});
  const raw=declaration('stdin');raw.command.argv=['only-fixed'];
  const selected=api.resolveContract({agent:'binding:worker-x'},snapshot(raw),'posix');if(selected.status!=='resolved')throw Error('missing contract');
  expect(await api.prepareInvocation(selected.handle,facts())).toMatchObject({status:'invalid',code:'BINDING_ARGS_SLOT_REQUIRED'});
  const noArgs={...facts(),route:{agent:'binding:worker-x',args:[]}};
  expect((await api.prepareInvocation(selected.handle,{...noArgs,prompt:'é'.repeat(32768)})).status).toBe('ready');
  expect(await api.prepareInvocation(selected.handle,{...noArgs,prompt:'é'.repeat(32769)})).toMatchObject({status:'invalid',code:'BINDING_INPUT_TOO_LARGE'});
  expect((await api.prepareInvocation(selected.handle,{...noArgs,route:{agent:'unprefixed',args:[]}})).status).toBe('invalid');
  expect((await api.prepareInvocation(selected.handle,{...noArgs,prompt:'nul\0'})).status).toBe('invalid');
  expect((await api.prepareInvocation(selected.handle,{...noArgs,checkoutRoot:'relative'})).status).toBe('invalid');
 });
 it('uses host-verified Windows facts without name admission or re-reading live config',async()=>{
  const api=await import('../../../src/agents/public/index.js');
  const raw=declaration('stdin');raw.command.executable='worker-launcher';
  const selected=api.resolveContract({agent:'binding:worker-x'},snapshot(raw),'win32');if(selected.status!=='resolved')throw Error('missing contract');
  const request={...facts(),checkoutRoot:'C:\\checkout path',environmentFacts:{home:'C:\\Users\\test',env:{},windows_target:{agent:'worker-launcher',executable:'C:\\Program Files\\node.exe',prefix_args:['C:\\worker dir\\entry.js']}}};
  const result=await api.prepareInvocation(selected.handle,request);expect(result.status).toBe('ready');if(result.status!=='ready')throw Error('not ready');
  expect(result.invocation.executable).toBe('C:\\Program Files\\node.exe');expect(result.invocation.argv).toEqual(['C:\\worker dir\\entry.js','/scripts/one.js',...request.route.args]);
  expect(await api.prepareInvocation(api.decodeContract(api.encodeContract(selected.handle)),request)).toEqual(result);
  expect((await api.prepareInvocation(selected.handle,{...request,environmentFacts:{home:'C:\\Users\\test',env:{}}})).status).toBe('invalid');
  for(const executable of ['C:\\Windows\\cmd.exe','C:\\native\\pi.exe'])expect((await api.prepareInvocation(selected.handle,{...request,environmentFacts:{...request.environmentFacts,windows_target:{...request.environmentFacts.windows_target,executable}}})).status).toBe('invalid');
  request.environmentFacts.windows_target.agent='another';expect((await api.prepareInvocation(selected.handle,request)).status).toBe('invalid');
 });
 it('refuses native safety downgrades and tampered/incompatible codec payloads',async()=>{
  const api=await import('../../../src/agents/public/index.js');
  for(const executable of ['codex','/bin/pi','opencode']) {
   const raw=declaration();raw.command.executable=executable;
   expect(api.resolveContract({agent:'binding:worker-x'},snapshot(raw),'posix')).toMatchObject({status:'invalid',reason:expect.stringContaining('native contract')});
  }
  expect(api.resolveContract({agent:'binding:worker-x',verifiedTarget:'pi'},snapshot(declaration()),'win32').status).toBe('invalid');
  const badNative={id:'declared-native',match:{supported_executable_names:['worker x']}};
  expect(api.resolveContract({agent:'binding:worker-x'},{...snapshot(declaration()),values:[badNative],overridden:['declared-native']},'posix')).toMatchObject({status:'invalid',reason:expect.stringContaining('declared-native')});
  const duplicate={...agentProfiles.get('opencode')!.value,id:'declared-native',match:{supported_executable_names:['worker x'],platform_target_identity:null}};
  expect(api.resolveContract({agent:'binding:worker-x'},{...snapshot(declaration()),values:[badNative,duplicate]},'posix').status).toBe('invalid');
  const selected=api.resolveContract({agent:'binding:worker-x'},snapshot(declaration()),'posix');if(selected.status!=='resolved')throw Error('missing contract');
  const token=JSON.parse(api.encodeContract(selected.handle));
  for(const change of [(x:typeof token)=>x.key.digest='wrong',(x:typeof token)=>x.key.id='other',(x:typeof token)=>x.interpreter='future',(x:typeof token)=>x.platform='other',(x:typeof token)=>x.sourceKey='other',(x:typeof token)=>x.binding.command.argv[0]='changed']) {
   const raw=structuredClone(token);change(raw);expect(()=>api.decodeContract(JSON.stringify(raw))).toThrow('CONTRACT_CODEC_INVALID');
  }
 });
});

it('substitutes equivalent contract ids across invocation, resume and usage consumers',async()=>{
 const api=await import('../../../src/agents/public/index.js');
 const results=[];
 for(const id of ['alternate-a','alternate-b']) {
  const raw=structuredClone(agentProfiles.get('opencode')!.value);
  raw.id=id;raw.match.supported_executable_names=['worker'];
  raw.usage=structuredClone(agentProfiles.get('codex')!.value.usage);
  const selected=api.resolveContract({agent:'worker'},{values:[raw],diagnostics:[],overridden:[]},'posix');
  if(selected.status!=='resolved')throw Error('equivalent contract missing');
  const handle=selected.handle,route={agent:'worker',args:['--auto']};
  const invocation=await api.prepareInvocation(handle,{mode:'run',origin:'managed',entry:'auto',route,checkoutRoot:'/checkout',prompt:'literal prompt',environmentFacts:{home:'/home',env:{}}});
  expect(invocation.status).toBe('ready');if(invocation.status!=='ready')throw Error('not ready');
  const run={run_id:'source',cwd:'/checkout',argv:['worker','run','--auto','--','old'],agent_session_id:'ses_SAME',headless:{role:'executor',route}};
  const session=api.selectSession(handle,run);expect(session.status).toBe('selected');if(session.status!=='selected')throw Error('session missing');
  expect((await api.verifySession(handle,session.session,{entries:async()=>[],readHead:async()=>undefined})).status).toBe('verified');
  const resumed=await api.prepareInvocation(handle,{mode:'resume',origin:'managed',entry:'auto',route,checkoutRoot:'/checkout',prompt:'next',sessionRef:session.session,environmentFacts:{home:'/home',env:{}}});
  expect(resumed.status).toBe('ready');if(resumed.status!=='ready')throw Error('resume missing');
  const round={task_id:'task',role:'executor',agent:id,route,cwd:'/checkout',launch_version:1,delivery_version:2,launch_ts:'2026-01-01T00:00:00Z',delivery_ts:'2026-01-01T00:00:20Z'};
  const bound=api.bindUsage(handle,round);expect(bound.status).toBe('bound');if(bound.status!=='bound')throw Error('usage missing');
  const usage=await api.readUsage(bound.ref,{facts:{home:'/home',auditCwd:'/checkout',platform:'posix',codexRoot:'/native',piEnv:{}},list:async()=>[],readLines:async()=>({lines:[],partial:false}),readSettings:async()=>undefined,readHead:async()=>'',readRun:async()=>{throw Error('unexpected run read');},readRunLog:async()=>{throw Error('unexpected log read');}});
  results.push({invoke:invocation.invocation.argv,resume:resumed.invocation.argv,occupied:api.occupiedSessions(handle,run),usage});
  raw.invoke.resume={tier:'unsupported',reason:'disabled'};raw.usage={...raw.usage,capability:{tier:'unsupported',reason:'disabled'},source:null,accounting:null,readable_formats:[]};
  const changed=api.resolveContract({agent:'worker'},{values:[raw],diagnostics:[],overridden:[]},'posix');if(changed.status!=='resolved')throw Error('changed contract missing');
  expect(api.selectSession(changed.handle,run).status).toBe('unavailable');expect(api.bindUsage(changed.handle,round).status).toBe('unavailable');
  expect(api.selectSession(handle,run).status).toBe('selected'); // in-flight snapshot is unchanged
 }
 expect(results[0]).toEqual(results[1]);
});

it('reads pre-integration basic run snapshots without granting native capabilities',async()=>{
 const api=await import('../../../src/agents/public/index.js');
 const binding={schema_version:1,id:'worker-x',command:{executable:'worker-x',argv:[{slot:'prompt'}]},input:{kind:'argv'}};
 const selected=api.resolveContract({agent:'binding:worker-x'},{values:[],diagnostics:[],overridden:[],bindings:{'worker-x':binding}},'posix');
 if(selected.status!=='resolved')throw Error('missing binding');
 const decoded=api.decodeContract(JSON.stringify({schema:1,key:selected.handle.key,platform:'posix',basic:binding}));
 expect(decoded.capabilities).toEqual({invoke:true,resume:false,observe:false,usage:false});
 expect(api.observeSession(decoded,'{"sessionID":"guess"}')).toBeUndefined();
});

it('protects native targets on their declared platform while allowing Windows OpenCode basic snapshots',async()=>{
 const api=await import('../../../src/agents/public/index.js');
 const {contentKey}=await import('../../../src/agents/content-key.js');
 const binding=(executable:string)=>({schema_version:1 as const,id:'worker-x',command:{executable,argv:['run',{slot:'args' as const},{slot:'prompt' as const}]},input:{kind:'argv' as const}});
 const source=(raw:unknown)=>({values:[],diagnostics:[],overridden:[],bindings:{'worker-x':raw}});
 for(const executable of ['C:\\apps\\opencode.exe','C:/apps/OPENCODE.EXE']) {
  const raw=binding(executable),selected=api.resolveContract({agent:'binding:worker-x',verifiedTarget:'opencode'},source(raw),'win32');
  expect(selected.status).toBe('resolved');if(selected.status!=='resolved')throw Error(selected.reason);
  const facts={mode:'run' as const,origin:'managed' as const,entry:'auto' as const,route:{agent:'binding:worker-x',args:['--auto']},checkoutRoot:'C:\\checkout path',prompt:'中文 prompt',environmentFacts:{home:'C:\\Users\\test',env:{},windows_target:{agent:'opencode',executable,prefix_args:[]}}};
  const decoded=api.decodeContract(api.encodeContract(selected.handle));
  expect(decoded.capabilities).toEqual({invoke:true,resume:false,observe:false,usage:false});
  const ready=await api.prepareInvocation(decoded,facts);expect(ready.status).toBe('ready');
  if(ready.status==='ready')expect(ready.invocation.argv).toEqual(['run','--auto','中文 prompt']);
  const key={id:raw.id,revision:'basic-v1',digest:contentKey(raw)};
  expect(api.decodeContract(JSON.stringify({schema:1,key,platform:'win32',basic:raw})).capabilities.resume).toBe(false);
 }
 for(const [platform,executables] of [['posix',['opencode','/tools/opencode','OPENCODE.EXE','codex','pi']],['win32',['C:\\apps\\codex.exe','C:\\apps\\PI.EXE']]] as const)for(const executable of executables)
  expect(api.resolveContract({agent:'binding:worker-x'},source(binding(executable)),platform)).toMatchObject({status:'invalid',reason:expect.stringContaining('BINDING_NATIVE_CONFLICT')});
 const raw=binding('opencode'),key={id:raw.id,revision:'basic-v1',digest:contentKey(raw)};
 expect(()=>api.decodeContract(JSON.stringify({schema:1,key,platform:'posix',basic:raw}))).toThrow('CONTRACT_CODEC_INVALID');
 const native=structuredClone(agentProfiles.get('opencode')!.value);native.id='custom-native';native.match.supported_executable_names=['custom-native'];
 const custom=binding('C:\\apps\\custom-native.exe');
 expect(api.resolveContract({agent:'binding:worker-x'},{...source(custom),values:[native]},'win32').status).toBe('resolved');
 expect(api.resolveContract({agent:'binding:worker-x'},{...source(binding('custom-native')),values:[native]},'posix').status).toBe('invalid');
 // An invalid/ambiguous override cannot hide native protection behind a forged platform list.
 const broken={id:'custom-native',evidence:{platforms:['posix']},match:{supported_executable_names:['custom-native']}};
 for(const values of [[broken],[native,native]])expect(api.resolveContract({agent:'binding:worker-x'},{...source(custom),values},'win32').status).toBe('invalid');
 expect(api.resolveContract({agent:'binding:worker-x'},{...source(binding('C:\\apps\\opencode.exe')),values:[{id:'opencode'}],overridden:['opencode']},'win32').status).toBe('invalid');
});


it('retains conservative occupancy for absolute Windows native aliases without granting plain resume',async()=>{
 const api=await import('../../../src/agents/public/index.js');
 const snapshot={values:[],diagnostics:[],overridden:[]},session='12345678-1234-1234-1234-123456789abc';
 const run=(executable:string)=>({run_id:'legacy-windows',cwd:'C:\\checkout',argv:[executable,'--print','--mode','json','--session-id',session,'--','prompt']});
 for(const executable of ['C:\\agents\\pi.exe','C:/agents/pi.exe','C:/agents/PI.EXE','C:/agents/pi.com']) {
  expect(api.runSessionIdentities(run(executable),snapshot)).toContainEqual({agent:'pi',session_id:session});
  expect(api.resolveResumeContract(run(executable),snapshot,'win32')).toMatchObject({status:'invalid',code:'unsupported-agent'});
 }
 for(const executable of ['C:/agents/pi.cmd','C:/agents/unknown.exe','/opt/pi.exe','pi.exe'])expect(api.runSessionIdentities(run(executable),snapshot)).toEqual([]);
 for(const contract of [null,'broken'])expect(()=>api.runSessionIdentities({...run('C:/agents/pi.exe'),contract},snapshot)).toThrow('CONTRACT_INVALID');
 const invalid={values:[{id:'pi'}],diagnostics:[],overridden:['pi']};
 expect(()=>api.runSessionIdentities(run('C:/agents/pi.exe'),invalid)).toThrow('CONTRACT_INVALID');
 const basic=api.resolveContract({agent:'binding:worker-x'},{...snapshot,bindings:{'worker-x':{schema_version:1,id:'worker-x',command:{executable:'worker-x',argv:[{slot:'prompt'}]},input:{kind:'argv'}}}},'posix');
 if(basic.status!=='resolved')throw Error('basic fixture missing');
 expect(api.runSessionIdentities({...run('C:/agents/pi.exe'),contract:api.encodeContract(basic.handle)},snapshot)).toEqual([]);
 expect(api.runSessionIdentities({run_id:'codex-legacy',cwd:'C:\\checkout',argv:['C:/agents/codex.exe','exec','resume','--json',session,'prompt']},snapshot)).toContainEqual({agent:'codex',session_id:session});
});

it('preserves inert metadata and literal argv in actual schema-1 basic snapshot digests',async()=>{
 const api=await import('../../../src/agents/public/index.js');
 const {contentKey}=await import('../../../src/agents/content-key.js');
 const basic={schema_version:1,id:'worker-x',metadata:{label:'historical'},command:{executable:'worker-x',label:'inert',argv:['literal ${KEEP}',{slot:'prompt'}]},input:{kind:'argv',label:'inert'}};
 const key={id:'worker-x',revision:'basic-v1',digest:contentKey(basic)},token=JSON.stringify({schema:1,key,platform:'posix',basic});
 const handle=api.decodeContract(token);
 expect(handle.key).toEqual(key);expect(handle.sourceKey).toBe(key.digest);
 expect(JSON.parse(api.encodeContract(handle))).toEqual(JSON.parse(token));
 expect(handle.capabilities).toEqual({invoke:true,resume:false,observe:false,usage:false});
 const ready=await api.prepareInvocation(handle,{mode:'run',origin:'managed',entry:'auto',route:{agent:'binding:worker-x',args:[]},checkoutRoot:'/checkout',prompt:'new prompt',environmentFacts:{home:'/home',env:{}}});
 expect(ready.status).toBe('ready');if(ready.status!=='ready')throw Error('legacy snapshot invocation missing');
 expect(ready.invocation.argv).toEqual(['literal ${KEEP}','new prompt']);
 expect(api.resolveContract({agent:'binding:worker-x'},{values:[],diagnostics:[],overridden:[],bindings:{'worker-x':basic}},'posix').status).toBe('invalid');
 for(const change of [(x:typeof basic)=>x.command.executable='pi',(x:typeof basic)=>x.command.argv.push({slot:'prompt'})]) {
  const value=structuredClone(basic);change(value);
  expect(()=>api.decodeContract(JSON.stringify({schema:1,key:{...key,digest:contentKey(value)},platform:'posix',basic:value}))).toThrow('CONTRACT_CODEC_INVALID');
 }
});
