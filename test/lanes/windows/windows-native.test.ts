/** Real Win32 acceptance, executed only on Windows; neutral finite-lived targets. */
import { expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStore, complete, delay, probe } from '../../../src/core/run/store.js';
const { startRun, stopRun } = await import(path.resolve('dist/core/run/control-windows.js')) as typeof import('../../../src/core/run/control-windows.js');
import { windowsMeta } from '../../../src/core/run/windows-protocol.js';
import { taskOccupants } from '../../../src/core/run/admission.js';
const native = it.skipIf(process.platform !== 'win32');
native('launches a Windows OpenCode-named basic binding through the real planner and controller without native capabilities',async()=>{
    // A copied Node binary is an explicit mechanism fixture, not authenticated OpenCode evidence.
    const root=mkdtempSync(path.join(os.tmpdir(),'tut-native-opencode-basic-')),executable=path.join(root,'opencode.exe');
    copyFileSync(process.execPath,executable);
    // This path really forks a supervisor; use shipped JS, as the other live cases do.
    await import(path.resolve('dist/app/agents.js'));
    const {startServer}=await import('../../../src/hub/server.js');
    const {hubCreate,hubRead}=await import('../../../src/hub/hub-client.js');
    const {writeConfigKey,writeAgentBinding}=await import('../../../src/core/common/config.js');
    const {runStartNextHeadless}=await import(path.resolve('dist/standalone/launcher-detached/start-next.js')) as typeof import('../../../src/standalone/launcher-detached/start-next.js');
    const {decodeContract}=await import('../../../src/agents/public/index.js');
    const server=await startServer({root:path.join(root,'.context-hub'),port:0}),store=new RunStore(root);
    let id:string|undefined;
    try {
        await writeConfigKey(path.join(root,'.context-hub'),{key:'launch_mode',value:'detached'});
        await writeAgentBinding(path.join(root,'.context-hub'),'windows-basic',{schema_version:1,id:'windows-basic',command:{executable,argv:['-e','console.log(JSON.stringify({cwd:process.cwd(),pwd:process.env.PWD,hub:process.env.TUT_HUB_URL,args:process.argv.slice(1)}))',{slot:'args'},{slot:'prompt'}]},input:{kind:'argv'}});
        const task=await hubCreate(server.url,{title:'Windows basic platform regression',description:'Mechanism fixture only; no coding model is invoked.',creator:'test',role:'executor',flow:'direct'});
        vi.stubEnv('TUT_HUB_ROOT',root);vi.stubEnv('TUT_PROJECT_ROOT',root);vi.stubEnv('TUT_HUB_URL',server.url);
        const code=await runStartNextHeadless({hubUrl:server.url,rigRoot:root,role:'executor',force:false,task:{task_id:task.task_id,title:'Windows basic platform regression',version:0},explicitRoute:{agent:'binding:windows-basic',args:[]}});
        expect(code).toBe(0);expect(store.list()).toHaveLength(1);id=store.list()[0]!;
        const deadline=Date.now()+45000;
        await store.withMetadataReads(async()=>{while(!complete(await store.readAsync(id!))){if(Date.now()>deadline)throw Error('basic run did not finish');await delay(100);}});
        const meta=await store.readAsync(id);
        expect(meta.exit_code).toBe(0);expect(meta.cwd).toBe(root);
        expect(decodeContract(meta.headless!.contract).capabilities).toEqual({invoke:true,resume:false,observe:false,usage:false});
        expect(meta.argv[0]).toBe(executable);
        const output=JSON.parse(readFileSync(store.logPath(id),'utf8').trim());
        expect(output).toMatchObject({cwd:root,pwd:root,hub:server.url});
        expect(output.args).toHaveLength(1);expect(output.args[0]).toContain('完整上下文');
        expect((await hubRead(server.url,task.task_id)).versions.filter(r=>r.payload.launch)).toHaveLength(1);
    }finally {
        if(id&&!complete(await store.readAsync(id)))await stopRun(store,id);
        await server.close();
        vi.unstubAllEnvs();
    }
},90000);
async function until(fn: () => boolean, ms = 45000) { const end = performance.now() + ms; while (!fn()) {
    if (performance.now() > end)
        throw new Error('native condition timed out');
    await delay(50);
} }
native('creates a hidden-console Job and merges concurrent stop/close requests with at most one Break', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tut-native-'));
    const store = new RunStore(root);
    try {
        // Cover startup + the bounded identity/stop protocol, rather than
        // letting a 20s target expire while the VM is still doing file I/O.
        // It remains finite if an assertion fails before we can stop it.
        const id = await startRun(store, [process.execPath, '-e', 'console.log("ready");setTimeout(()=>{},120000)'], root);
        await until(() => readFileSync(store.logPath(id), 'utf8').includes('ready'));
        expect(probe(store.read(id).pid)).toBe(true);
        expect(complete(store.read(id))).toBe(false);
        const results = await Promise.all([stopRun(store, id), stopRun(store, id)]);
        expect(results.every(r => r.success)).toBe(true);
        expect(results.filter(r => r.requested)).toHaveLength(1);
        const r = windowsMeta(store.read(id)).stop_request!;
        expect(results.map(result => result.meta.stop_request?.id)).toEqual([r.id, r.id]);
        // The finite target can exit between the ready check and the broker's
        // observation. An empty Job needs no Break; a delivered Break must
        // still have its receipt and the matching terminal outcome.
        if (r.actions.length === 0) {
            expect(r.result?.outcome).toBe('already-ended');
            expect(r.result?.exit_code).toBe(0);
        } else {
            expect(r.actions.map(a => a.action)).toEqual(['break']);
            expect(r.actions[0]?.delivery).toBe('sent');
            const targets = r.actions[0]?.receipt?.targets;
            expect(targets).toBeDefined();
            if (targets!.length > 0) {
                expect(r.result?.outcome).toBe('forced-break');
            } else {
                // Natural exit can also race the native action after intent.
                expect(r.result?.outcome).toBe('already-ended');
                expect(r.result?.exit_code).toBe(0);
            }
        }
        expect(r.phase).toBe('completed');
        expect(r.result?.success).toBe(true);
        expect(r.result?.root_exited).toBe(true);
        expect(r.result?.group_alive).toBe(false);
        expect((await stopRun(store, id)).requested).toBe(false);
        expect(complete(store.read(id))).toBe(true);
    }
    finally {
        await delay(300);
        // Keep this native run archive for diagnosis; do not mask assertions with Windows CWD/handle cleanup errors.
    }
}, 90000);
native('runs the full Break /T /F ladder against a target that handles Break', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tut-native-'));
    const store = new RunStore(root);
    try {
        const id = await startRun(store, [process.execPath, '-e', 'process.on("SIGBREAK",()=>console.log("break received"));console.log("ready");setTimeout(()=>{},120000)'], root);
        await until(() => readFileSync(store.logPath(id), 'utf8').includes('ready'));
        const result = await stopRun(store, id);
        expect(result.success).toBe(true);
        const actions = windowsMeta(result.meta).stop_request!.actions;
        expect(actions.map(a => a.action)).toEqual(['break', 'taskkill-tree', 'taskkill-tree-force']);
        expect(actions.every(a => a.delivery === 'sent')).toBe(true);
        expect(result.meta.stop_request?.result?.outcome).toBe('forced-kill');
    }
    finally {
        await delay(300);
        // Keep this native run archive for diagnosis; do not mask assertions with Windows CWD/handle cleanup errors.
    }
}, 120000);
native('broker loss leaves the original target alive, refuses takeover, and keeps occupancy', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tut-native-'));
    const store = new RunStore(root);
    const id = await startRun(store, [process.execPath, '-e', 'console.log("ready");setTimeout(()=>{},30000)'], root, 'native-loss');
    const meta = windowsMeta(store.read(id));
    process.kill(meta.windows.identity.broker_pid); // fault injection into this test-owned broker only
    await until(() => !!windowsMeta(store.read(id)).windows.error);
    expect(probe(meta.pid)).toBe(true);
    expect(complete(store.read(id))).toBe(false);
    // Socket error/close and the pending write callback may win in either order.
    const before = readFileSync(path.join(store.directory(id), 'meta.json'));
    for (let attempt = 0; attempt < 2; attempt++)
        await expect(stopRun(store, id)).rejects.toThrow(/^(observer-lost|delivery-uncertain):/);
    expect(readFileSync(path.join(store.directory(id), 'meta.json'))).toEqual(before);
    expect(store.read(id).stop_request).toBeUndefined();
    expect(taskOccupants(store, 'native-loss')).toHaveLength(1);
    await until(() => probe(meta.pid) === false); // finite target exits itself, never an unowned recovery kill
    expect(complete(store.read(id))).toBe(false);
    // Keep this native run archive for diagnosis; do not mask assertions with Windows CWD/handle cleanup errors.
}, 90000);

native('rejects native nonce/sequence replay and retains occupation after a lost receipt', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { fileURLToPath } = await import('node:url');
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../fixtures/windows-protocol.mjs', import.meta.url))], { timeout: 150000 });
    expect(result.stdout).toContain('NATIVE_REPLAY');
    expect(result.stdout).toContain('NATIVE_TIMEOUT');
    expect(result.stdout).toContain('FINITE_TARGETS_EXITED');
}, 160000);
