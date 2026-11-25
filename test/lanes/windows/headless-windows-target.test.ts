import { afterEach,describe,expect,it,vi } from 'vitest';
import type { Stats } from 'node:fs';
import { resolveDetachedWindowsTarget, type DetachedWindowsTargetDeps } from '../../../src/standalone/launcher-detached/windows-target.js';
import { windowsPiEncodedCwd, windowsPiRouteArgs, windowsPiSessionLocation, verifyWindowsPiSession } from '../../../src/agents/public/native-compat.js';
import { physicalWindowsArgv } from '../../../src/core/run/windows-launch.js';

const script = 'C:\\node22\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js';
const manifest = 'C:\\node22\\node_modules\\@earendil-works\\pi-coding-agent\\package.json';
const node = 'C:\\node22\\node.exe';
const shim = 'C:\\node22\\pi.cmd';
// Standard npm cmd-shim output (with its current PATHEXT placement), treated
// only as fixture data. The resolver must never execute any of this text.
const npmShim = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*
`;
function deps(overrides: Record<string, string | undefined> = {}): DetachedWindowsTargetDeps {
  const files = new Map(Object.entries({ [shim]: npmShim, [script]: '#!/usr/bin/env node', [node]: 'MZ',
    [manifest]: JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.4.0',bin:{pi:'dist/cli.js'}}), ...overrides }));
  return {
    candidates: async () => [shim], nodeExecutable: node,
    stat: async file => { if (!files.has(file) || files.get(file) === undefined) throw Object.assign(new Error('missing'), {code:'ENOENT'}); return {isFile:()=>true} as Stats; },
    readText: async file => { const value=files.get(file); if(value === undefined) throw new Error(`missing ${file}`); return value; },
  };
}
describe('Windows detached physical targets', () => {
  it('preserves literal argument boundaries, empty strings, Unicode, quotes, newlines and shell metacharacters', () => {
    const literals=['','two words','中文🙂','a"b','trailing\\','line\nbreak','&|%!'];
    const target={agent:'pi' as const,kind:'node-entry' as const,executable:node,prefix_args:[script],source_path:script};
    expect(physicalWindowsArgv(target,['pi',...literals])).toEqual([node,script,...literals]);
  });
  it('resolves verified npm pi 1.4.0 to node.exe + CLI JS; retains logical pi', async () => {
    expect(await resolveDetachedWindowsTarget('pi', {Path:'C:\\node22'}, deps())).toEqual({
      agent:'pi',version:'1.4.0',kind:'node-entry',executable:node,prefix_args:[script],source_path:script,
    });
  });
  it('accepts CRLF npm shim and an explicit package entry', async () => {
    expect((await resolveDetachedWindowsTarget('pi', {}, deps({[shim]:npmShim.replaceAll('\n','\r\n')}))).agent).toBe('pi');
    expect((await resolveDetachedWindowsTarget(script, {}, deps())).prefix_args).toEqual([script]);
  });
  it('accepts the legacy npm empty shebang-args slot without accepting extra shell commands', async () => {
    const old=npmShim.replace('  SET "_prog=node"\n','  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n')
      .replace('set PATHEXT=%PATHEXT:;.JS;=;% & ', '');
    expect((await resolveDetachedWindowsTarget('pi',{},deps({[shim]:old}))).prefix_args).toEqual([script]);
    await expect(resolveDetachedWindowsTarget('pi',{},deps({[shim]:old.replace('"%_prog%"  ', '"%_prog%" --unexpected ')}))).rejects.toThrow('unsupported Windows pi wrapper');
  });
  it('supports the shipped 1.4.0 bundled npm bin as well as the unbundled entry used by the VM spike', async () => {
    const bundled=script.replace('dist\\cli.js','dist\\bundle\\cli.js');
    const d=deps({[shim]:npmShim.replace('dist\\cli.js','dist\\bundle\\cli.js'),[bundled]:'#!/usr/bin/env node',
      [manifest]:JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.4.0',bin:{pi:'dist/bundle/cli.js'}})});
    expect((await resolveDetachedWindowsTarget('pi',{},d)).prefix_args).toEqual([bundled]);
    expect((await resolveDetachedWindowsTarget(script,{},d)).prefix_args).toEqual([script]);
  });
  it.each([
    {[shim]: npmShim + 'echo injected\n'},
    {[shim]: npmShim.replace('dist\\cli.js','other.js')},
    {[manifest]:JSON.stringify({name:'other',version:'1.4.0',bin:{pi:'dist/cli.js'}})},
    {[manifest]:JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.3.0',bin:{pi:'dist/cli.js'}})},
    {[script]:undefined}, {[node]:undefined},
  ])('refuses an unverified wrapper/package/entry without fallback', async overrides => {
    await expect(resolveDetachedWindowsTarget('pi', {}, deps(overrides))).rejects.toThrow();
  });
  it('supports native codex independently and refuses arbitrary shell/file-association agents', async () => {
    const target = 'C:\\apps\\codex.exe';
    expect(await resolveDetachedWindowsTarget('codex', {}, {candidates:async()=>[target],stat:async()=>({isFile:()=>true} as Stats)})).toMatchObject({agent:'codex',executable:target,prefix_args:[]});
    await expect(resolveDetachedWindowsTarget('powershell.exe',{},deps())).rejects.toThrow('does not execute .cmd shims');
    await expect(resolveDetachedWindowsTarget('.\\pi.cmd',{},deps())).rejects.toThrow('must be absolute');
  });
  it('uses case-insensitive Path without where.exe and respects the first existing unsupported shim', async () => {
    const d=deps();delete d.candidates;
    expect((await resolveDetachedWindowsTarget('pi',{Path:'C:\\node22',PATHEXT:'.EXE;.CMD'},d)).agent).toBe('pi');
    await expect(resolveDetachedWindowsTarget('pi',{}, {...deps(),candidates:async()=>['C:\\first\\pi.cmd',shim],stat:async()=>({isFile:()=>true} as Stats),readText:async file=>file.startsWith('C:\\first')?'echo wrapper':npmShim})).rejects.toThrow('unsupported Windows pi wrapper');
  });
});

describe('Windows Pi 1.4.0 session directory contract', () => {
  const cwd='C:\\tutlab\\spikework', home='C:\\Users\\runner';
  const noSettings={home,readSettings:()=>undefined};
  describe.each(['cli','environment','agentDir'] as const)('%s Windows path input', source => {
    function locationFor(value: string, readSettings: (file: string) => string | undefined = noSettings.readSettings) {
      const parsed=source==='cli' ? windowsPiRouteArgs(['--session-dir',value]) : undefined;
      return windowsPiSessionLocation(cwd, source==='environment' ? {PI_CODING_AGENT_SESSION_DIR:value}
        : source==='agentDir' ? {PI_CODING_AGENT_DIR:value} : {}, parsed?.directory, {home,readSettings});
    }
    it.each(['/d/sessions','/mnt/d/sessions','/cygdrive/d/sessions'])('preserves Pi native drive identity through argv and session lookup: %s', input => {
      const settingsReads:string[]=[];
      const location=locationFor(input,file=>{settingsReads.push(file);return undefined;});
      const directory=source==='agentDir' ? 'D:\\sessions\\sessions\\--C--tutlab-spikework--' : 'D:\\sessions';
      expect(location.session_directory).toBe(directory);
      if(source==='agentDir')expect(settingsReads[0]).toBe('D:\\sessions\\settings.json');
      const id='4dbc674d-ed3c-4d66-beb8-0e2d7ee7069b';
      const session=verifyWindowsPiSession(location,id,{
        entries:dir=>{expect(dir).toBe(directory);return ['existing.jsonl'];},
        header:file=>{expect(file).toBe(`${directory}\\existing.jsonl`);return {type:'session',id,cwd};},
      });
      const argv=physicalWindowsArgv({agent:'pi',kind:'node-entry',executable:node,prefix_args:[script],source_path:script},
        ['pi','--session-id',id,'--','prompt'],session);
      expect(argv[argv.indexOf('--session-dir')+1]).toBe(directory);
    });
    it.each(['file:///D:/sessions','file://server/share/sessions','file:///D:/space%20name','FILE:///D:/sessions'])('refuses unsupported file URLs instead of freezing a different directory: %s', input => {
      expect(()=>locationFor(input)).toThrow('file URL');
    });
  });
  it('encodes ordinary drive, spaces/Unicode and UNC paths as Pi does (without junction/case folding)', () => {
    expect(windowsPiEncodedCwd(cwd)).toBe('--C--tutlab-spikework--');
    expect(windowsPiEncodedCwd('C:\\work 中文\\repo')).toBe('--C--work 中文-repo--');
    expect(windowsPiEncodedCwd('\\\\server\\share\\repo')).toBe('---server-share-repo--');
    expect(windowsPiEncodedCwd('c:\\repo')).not.toBe(windowsPiEncodedCwd('C:\\repo'));
  });
  it('freezes CLI > environment > native default, flat overrides never gain a cwd child', () => {
    expect(windowsPiSessionLocation(cwd,{},undefined,noSettings)).toEqual({storage_layout:'cwd-encoded',source:'default',launch_cwd:cwd,session_directory:'C:\\Users\\runner\\.pi\\agent\\sessions\\--C--tutlab-spikework--'});
    expect(windowsPiSessionLocation(cwd,{PI_CODING_AGENT_SESSION_DIR:'..\\flat'},undefined,noSettings)).toMatchObject({source:'environment',storage_layout:'flat',session_directory:'C:\\tutlab\\flat'});
    expect(windowsPiSessionLocation(cwd,{PI_CODING_AGENT_SESSION_DIR:'C:\\ignored'},'C:\\中文 !&%\\sessions',noSettings)).toMatchObject({source:'cli',session_directory:'C:\\中文 !&%\\sessions'});
    expect(windowsPiSessionLocation(cwd,{PI_CODING_AGENT_DIR:'~\\custom'},undefined,noSettings).session_directory).toBe('C:\\Users\\runner\\custom\\sessions\\--C--tutlab-spikework--');
  });
  it('refuses unknown effective settings and ambiguous drive-relative paths; explicit overrides resolve the ambiguity', () => {
    const settings={home,readSettings:()=>'{"sessionDir":"elsewhere"}'};
    expect(()=>windowsPiSessionLocation(cwd,{},undefined,settings)).toThrow('requires explicit');
    expect(windowsPiSessionLocation(cwd,{},'C:\\explicit',settings).source).toBe('cli');
    expect(()=>windowsPiSessionLocation(cwd,{},'D:relative',noSettings)).toThrow('ambiguous');
    expect(()=>windowsPiSessionLocation(cwd,{},'D:',noSettings)).toThrow('ambiguous');
  });
  it('extracts only storage options, preserves literal option values and leaves forbidden selectors to nativeArgv', () => {
    expect(windowsPiRouteArgs(['--model','model','--session-dir=../sessions','--system-prompt','--session-dir','--continue'])).toEqual({directory:'../sessions',args:['--model','model','--system-prompt','--session-dir','--continue']});
    expect(()=>windowsPiRouteArgs(['--session-dir'])).toThrow();
    expect(()=>windowsPiRouteArgs(['--session-dir=x','--session-dir=y'])).toThrow('duplicate');
  });
  it('requires exactly one matching header id AND cwd, never invents a new session or folds aliases', () => {
    const id='4dbc674d-ed3c-4d66-beb8-0e2d7ee7069b';
    const location=windowsPiSessionLocation(cwd,{},'C:\\flat',noSettings);
    const good={entries:()=>['one.jsonl'],header:()=>({type:'session',id,cwd})};
    expect(verifyWindowsPiSession(location,id,good)).toMatchObject({session_file:'C:\\flat\\one.jsonl',header_cwd:cwd,session_id:id});
    expect(()=>verifyWindowsPiSession(location,id,{...good,entries:()=>[]})).toThrow('found 0');
    expect(()=>verifyWindowsPiSession(location,id,{...good,entries:()=>['one.jsonl','two.jsonl']})).toThrow('found 2');
    for(const headerCwd of [undefined,'C:\\other','c:\\tutlab\\spikework']) expect(()=>verifyWindowsPiSession(location,id,{...good,header:()=>({type:'session',id,cwd:headerCwd})})).toThrow('project identity');
  });
});


describe('Windows capability ReadyInvocation parity',()=>{
 const cwd='C:\\checkout',home='C:\\Users\\tester',id='12345678-1234-1234-1234-123456789abc';
 const target={agent:'pi' as const,kind:'node-entry' as const,executable:node,prefix_args:[script],source_path:script};
 afterEach(()=>vi.restoreAllMocks());
 async function fixture() {
  const api=await import('../../../src/agents/public/index.js');
  const legacy=await import('../../../src/agents/public/transition.js');
  const {nativeReads}=await import('../../../src/core/agents/native-reads.js');
  vi.spyOn(nativeReads,'home').mockReturnValue(home);
  vi.spyOn(nativeReads,'readSettings').mockReturnValue(undefined);
  vi.spyOn(nativeReads,'entries').mockReturnValue(['existing.jsonl']);
  vi.spyOn(nativeReads,'header').mockReturnValue({type:'session',id,cwd});
  const resolved=api.resolveContract({agent:'pi',verifiedTarget:'pi'},{values:[],diagnostics:[],overridden:[]},'win32');
  if(resolved.status!=='resolved')throw Error('missing Windows contract');
  return {api,legacy,nativeReads,handle:resolved.handle};
 }
 for(const mode of ['run','resume'] as const)for(const source of ['cli','environment','default'] as const) {
  it(`${mode}: matches the complete legacy physical plan for ${source} storage`,async()=>{
   const {api,legacy,handle}=await fixture();
   const route={agent:'pi',args:source==='cli'?['--session-dir','C:\\explicit sessions']:[]};
   const env=source==='environment'?{PI_CODING_AGENT_SESSION_DIR:'C:\\environment sessions'}:{};
   const previous={...windowsPiSessionLocation(cwd,env,windowsPiRouteArgs(route.args).directory,{home,readSettings:()=>undefined}),session_id:id};
   const sessionRef={profile:handle.key,agent:'pi',session_id:id,identity_source:'designated' as const,source_run_id:'source',route,cwd,store:previous,evidence:{via:'RunStore' as const,run_id:'source',field:'headless.designated_session_id' as const}};
   // A continuation uses the frozen directory despite settings/environment drift.
   const currentEnv=mode==='resume'?{PI_CODING_AGENT_SESSION_DIR:'C:\\changed since launch'}:env;
   const facts={mode,origin:'managed' as const,entry:'auto' as const,route,checkoutRoot:cwd,prompt:'literal prompt 中文',environmentFacts:{home,env:currentEnv,designated_id:id,windows_target:target},...(mode==='resume'?{sessionRef}:{})};
   const logical=await legacy.invoke({...facts,profile:handle,platform:'win32'});
   if(logical.status!=='ready')throw Error(logical.reason);
   const store=legacy.legacyWindowsSession({target,cwd,env:currentEnv,routeFacts:legacy.legacyWindowsRouteFacts(target,route.args)!,designated:id,...(mode==='resume'?{id}:{}),previous:()=>previous});
   const expected=physicalWindowsArgv(target,['pi',...logical.invocation.argv],store);
   const ready=await api.prepareInvocation(handle,facts);expect(ready.status).toBe('ready');if(ready.status!=='ready')return;
   expect([ready.invocation.executable,...ready.invocation.argv]).toEqual(expected);
   expect(ready.invocation.sessionPlan.store).toEqual(store);
   expect(ready.invocation.envPatch).toEqual(logical.invocation.envPatch);
   expect(ready.invocation.cwd).toBe(cwd);expect(Object.isFrozen(ready.invocation.sessionPlan.store)).toBe(true);
  });
 }
 it('uses the verified Codex physical executable and prefix',async()=>{
  const {api}=await fixture();
  const resolved=api.resolveContract({agent:'codex',verifiedTarget:'codex'},{values:[],diagnostics:[],overridden:[]},'win32');if(resolved.status!=='resolved')throw Error('missing Codex');
  const physical={agent:'codex',executable:'C:\\apps\\codex.exe',prefix_args:['native-prefix']};
  const facts={mode:'run' as const,origin:'managed' as const,entry:'auto' as const,route:{agent:'codex',args:[]},checkoutRoot:cwd,prompt:'hello',environmentFacts:{home,env:{},windows_target:physical}};
  const ready=await api.prepareInvocation(resolved.handle,facts);if(ready.status!=='ready')throw Error(ready.reason);
  expect(ready.invocation.executable).toBe(physical.executable);expect(ready.invocation.argv[0]).toBe('native-prefix');
 });
 it('preserves native settings and explicit-directory refusals',async()=>{
  const {api,handle,nativeReads}=await fixture();
  const facts={mode:'run' as const,origin:'managed' as const,entry:'auto' as const,route:{agent:'pi',args:[] as string[]},checkoutRoot:cwd,prompt:'hello',environmentFacts:{home,env:{},designated_id:id,windows_target:target}};
  vi.mocked(nativeReads.readSettings).mockReturnValue(JSON.stringify({sessionDir:'ambiguous'}));
  expect(await api.prepareInvocation(handle,facts)).toMatchObject({status:'invalid',reason:expect.stringContaining('settings sessionDir requires explicit')});
  for(const [args,reason] of [[['--session-dir','file:///D:/sessions'],'unsupported Windows pi file URL'],[['--session-dir'],'requires a nonempty path'],[['--session-dir','C:\\a','--session-dir','C:\\b'],'duplicate pi --session-dir']] as const) {
   expect(await api.prepareInvocation(handle,{...facts,route:{agent:'pi',args:[...args]}})).toMatchObject({status:'invalid',reason:expect.stringContaining(reason)});
  }
 });
 it.each(['missing','cwd','header','duplicate','file'] as const)('refuses %s continuation evidence before returning ready',async problem=>{
  const {api,handle,nativeReads}=await fixture();
  const store={storage_layout:'flat' as const,source:'cli' as const,session_directory:'C:\\sessions',launch_cwd:problem==='cwd'?'C:\\other':cwd,...(problem==='file'?{session_file:'C:\\sessions\\old.jsonl'}:{})};
  if(problem==='header')vi.mocked(nativeReads.header).mockReturnValue({type:'session',id,cwd:'C:\\other'});
  if(problem==='duplicate')vi.mocked(nativeReads.entries).mockReturnValue(['one.jsonl','two.jsonl']);
  if(problem==='missing')vi.mocked(nativeReads.entries).mockReturnValue([]);
  const route={agent:'pi',args:[]};
  const sessionRef={profile:handle.key,agent:'pi',session_id:id,identity_source:'designated' as const,source_run_id:'source',route,cwd,store,evidence:{via:'RunStore' as const,run_id:'source',field:'headless.designated_session_id' as const}};
  expect(await api.prepareInvocation(handle,{mode:'resume',origin:'managed',entry:'auto',route,checkoutRoot:cwd,prompt:'hello',environmentFacts:{home,env:{},windows_target:target},sessionRef})).toMatchObject({status:'invalid'});
 });
});

import {resolveContract,prepareInvocation} from '../../../src/agents/public/index.js';
import {readWindowsLaunch} from '../../../src/core/run/windows-launch.js';
it.each(['native','node-entry'] as const)('accepts an unlisted %s target through the shared basic contract',async kind=>{
  const executable=kind==='native'?'C:\\new app\\worker.exe':'C:\\new app\\worker.mjs';
  const target=await resolveDetachedWindowsTarget(executable,{}, {nodeExecutable:node,candidates:async()=>[executable],stat:async()=>({isFile:()=>true} as Stats)});
  const binding={schema_version:1,id:'worker-x',command:{executable,argv:[{slot:'args'}]},input:{kind:'stdin',encoding:'utf8'}};
  const resolved=resolveContract({agent:'binding:worker-x'},{values:[],diagnostics:[],overridden:[],bindings:{'worker-x':binding}},'win32');
  expect(resolved.status).toBe('resolved');if(resolved.status!=='resolved')return;
  const result=await prepareInvocation(resolved.handle,{mode:'run',origin:'managed',entry:'auto',route:{agent:'binding:worker-x',args:['two words','&|🙂']},checkoutRoot:'C:\\checkout',prompt:'raw prompt\n🙂',environmentFacts:{home:'C:\\home',env:{},windows_target:target}});
  expect(result.status).toBe('ready');if(result.status!=='ready')return;
  expect([result.invocation.executable,...result.invocation.argv]).toEqual([target.executable,...target.prefix_args,'two words','&|🙂']);
  expect(result.invocation.input).toEqual({kind:'stdin',encoding:'utf8',text:'raw prompt\n🙂'});
  const ownership={schema:1 as const,role:'executor',attempt_id:'12345678-1234-1234-1234-123456789abc',base_version:0,trigger_version:0,route:{agent:'binding:worker-x',args:[]},route_source:'fixture',session_reason:'fresh',windows:{schema:1 as const,target,logical_argv:result.invocation.logicalArgv}};
  expect(readWindowsLaunch(ownership).target.agent).toBe(target.agent);
});

describe('basic native protection after physical resolution and args expansion',()=>{
  const snapshot=(binding:unknown)=>({values:[],diagnostics:[],overridden:[],bindings:{'worker-x':binding}});
  const binding=(executable:string,argv:unknown[])=>({schema_version:1,id:'worker-x',command:{executable,argv},input:{kind:'argv'}});
  it.each(['direct','explicit-node'] as const)('rejects the official Pi %s entry at declaration resolution',async form=>{
    const target=await resolveDetachedWindowsTarget(script,{},deps());
    expect(target.agent).toBe('pi');
    const b=form==='direct'?binding(script,[{slot:'args'},{slot:'prompt'}]):binding(node,[script,{slot:'args'},{slot:'prompt'}]);
    expect(resolveContract({agent:'binding:worker-x'},snapshot(b),'win32')).toMatchObject({status:'invalid',reason:expect.stringContaining('BINDING_NATIVE_CONFLICT')});
  });
  it('rejects a basic alias when the host has verified a protected native target',()=>{
    const b=binding('C:\\apps\\worker.exe',[{slot:'prompt'}]);
    expect(resolveContract({agent:'binding:worker-x',verifiedTarget:'pi'},snapshot(b),'win32')).toMatchObject({status:'invalid',reason:expect.stringContaining('BINDING_NATIVE_CONFLICT')});
  });
  it('rejects a Pi interpreter entry supplied by args even with explicit session selectors',async()=>{
    const resolved=resolveContract({agent:'binding:worker-x'},snapshot(binding(node,[{slot:'args'},{slot:'prompt'}])),'win32');
    expect(resolved.status).toBe('resolved');if(resolved.status!=='resolved')return;
    const target=await resolveDetachedWindowsTarget(node,{}, {...deps(),candidates:async()=>[node]});
    const result=await prepareInvocation(resolved.handle,{mode:'run',origin:'managed',entry:'auto',route:{agent:'binding:worker-x',args:[script,'--session-id','11111111-1111-4111-8111-111111111111','--session-dir','C:\\foreign-store']},checkoutRoot:'C:\\checkout',prompt:'prompt',environmentFacts:{home:'C:\\home',env:{},windows_target:target}});
    expect(result).toMatchObject({status:'invalid',reason:expect.stringContaining('BINDING_NATIVE_CONFLICT')});
  });
  it('checks the final physical interpreter prefix even when logical names are unlisted',async()=>{
    const resolved=resolveContract({agent:'binding:worker-x'},snapshot(binding('C:\\apps\\worker.exe',[{slot:'prompt'}])),'win32');
    if(resolved.status!=='resolved')throw Error('missing basic handle');
    const result=await prepareInvocation(resolved.handle,{mode:'run',origin:'managed',entry:'auto',route:{agent:'binding:worker-x',args:[]},checkoutRoot:'C:\\checkout',prompt:'prompt',environmentFacts:{home:'C:\\home',env:{},windows_target:{agent:'unlisted',executable:node,prefix_args:[script]}}});
    expect(result).toMatchObject({status:'invalid',reason:expect.stringContaining('BINDING_NATIVE_CONFLICT')});
  });
  it.each(['direct','explicit-node'] as const)('allows an ordinary cli.js via %s and treats prompt references to native paths as data',async form=>{
    const ordinary='C:\\new app\\cli.js',executable=form==='direct'?ordinary:node;
    const b=binding(executable,[...(form==='explicit-node'?[ordinary]:[]),{slot:'args'},{slot:'prompt'}]);
    const target=await resolveDetachedWindowsTarget(executable,{}, {nodeExecutable:node,candidates:async()=>[executable],stat:async()=>({isFile:()=>true} as Stats)});
    const resolved=resolveContract({agent:'binding:worker-x'},snapshot(b),'win32');
    if(resolved.status!=='resolved')throw Error('ordinary interpreter refused');
    const result=await prepareInvocation(resolved.handle,{mode:'run',origin:'managed',entry:'auto',route:{agent:'binding:worker-x',args:['--flag']},checkoutRoot:'C:\\checkout',prompt:script,environmentFacts:{home:'C:\\home',env:{},windows_target:target}});
    expect(result.status).toBe('ready');
    if(result.status==='ready')expect(result.invocation.argv).toEqual([ordinary,'--flag',script]);
  });
});
