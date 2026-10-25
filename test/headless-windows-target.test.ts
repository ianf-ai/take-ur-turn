import { describe, expect, it } from 'vitest';
import type { Stats } from 'node:fs';
import { resolveDetachedWindowsTarget, type DetachedWindowsTargetDeps } from '../src/standalone/launcher-headless/windows-target.js';
import { windowsPiEncodedCwd, windowsPiRouteArgs, windowsPiSessionLocation, verifyWindowsPiSession } from '../src/core/run/windows-pi-session.js';
import { physicalWindowsArgv } from '../src/standalone/launcher-headless/windows-plan.js';

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
    await expect(resolveDetachedWindowsTarget('powershell.exe',{},deps())).rejects.toThrow('unsupported-headless-agent');
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
