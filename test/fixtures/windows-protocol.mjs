import assert from 'node:assert/strict';
import {launchBroker} from '../../dist/core/run/windows-broker.js';
import {RunStore,delay,probe,complete} from '../../dist/core/run/store.js';
import {WindowsStopController} from '../../dist/core/run/windows-controller.js';
import {startRun,stopRun} from '../../dist/core/run/control.js';
import {taskOccupants} from '../../dist/core/run/admission.js';
import {mkdtempSync,readFileSync,closeSync,rmSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
const root=mkdtempSync(process.env.TEMP+'\\tut-protocol-');const store=new RunStore(root);
// Real native broker input replay, including a literal old lifecycle nonce.
const id=store.create();closeSync(store.openLog(id,true));const broker=await launchBroker(id);const socket=broker.socket;
socket.removeAllListeners('data');let buffer='';let pending;
socket.on('data',c=>{buffer+=c.toString('utf8');let i;while((i=buffer.indexOf('\n'))>=0){const value=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);pending?.(value);pending=undefined;}});
const request=(seq,operation,payload={},binding=broker.binding)=>new Promise(resolve=>{pending=resolve;socket.write(JSON.stringify({...binding,seq,operation,deadline_ms:5000,payload})+'\n');});
const old=await request(1,'observe',{}, {...broker.binding,nonce:'old'});assert.match(old.error,/identity-unverified/);
const created=await request(1,'create-target',{argv:[process.execPath,'-e','process.on("SIGBREAK",()=>console.log("BREAK"));console.log("ready");setTimeout(()=>{},30000)'],cwd:root,env:process.env,log:store.directory(id)+'\\log',job_id:randomBytes(16).toString('hex')});assert.ok(created.value);
while(!readFileSync(store.directory(id)+'\\log','utf8').includes('ready'))await delay(50);
const op='a'.repeat(32);const first=await request(2,'break',{operation:op});assert.ok(first.value);
assert.deepEqual(await request(2,'break',{operation:op}),first);
const collision=await request(2,'break',{operation:'b'.repeat(32)});assert.match(collision.error,/different content/);
const skip=await request(4,'observe');assert.match(skip.error,/non-monotonic/);
await delay(100);assert.equal(readFileSync(store.directory(id)+'\\log','utf8').split('BREAK').length-1,1);
const duplicate=await request(3,'break',{operation:op});assert.match(duplicate.error,/duplicate/);broker.close();
console.log('NATIVE_REPLAY',JSON.stringify({old:old.error,collision:collision.error,skip:skip.error,duplicate:duplicate.error,break_count:1}));
// Drop a real /T receipt at the client transport boundary. No /F after timeout.
const timeoutId=store.create();closeSync(store.openLog(timeoutId,true));const b=await launchBroker(timeoutId);
const target=await b.request('create-target',{argv:[process.execPath,'-e','process.on("SIGBREAK",()=>{});console.log("ready");setTimeout(()=>{},30000)'],cwd:root,env:process.env,log:store.directory(timeoutId)+'\\log',job_id:randomBytes(16).toString('hex')});
const at=new Date().toISOString();const meta={run_id:timeoutId,pid:target.pid,pgid:target.pid,supervisor_pid:process.pid,argv:[process.execPath],cwd:root,started_at:at,status:'stopped',control_protocol:'windows-console-v1',windows:{identity:target.identity},stopped_at:at,stopped_by:'native-test',stop_request:{id:'c'.repeat(32),requested_at:at,requested_by:'native-test',phase:'requested',signals:[],actions:[]}};await store.initialize(timeoutId,meta);
while(!readFileSync(store.directory(timeoutId)+'\\log','utf8').includes('ready'))await delay(30);
b.timeoutMs=500;const controller=new WindowsStopController(store,meta,b,{budgets:[0,0,0]});await controller.step();
const original=b.socket.listeners('data')[0];b.socket.removeListener('data',original);let dropped;
b.socket.on('data',c=>{const frame=JSON.parse(c.toString('utf8'));if(frame.seq===b.nextSeq-1 && frame.value?.targets){dropped=c;}else original(c);});
await controller.step();const failed=store.read(timeoutId);assert.equal(failed.stop_request.result.success,false);assert.match(failed.stop_request.result.error,/delivery-uncertain/);assert.equal(failed.stop_request.actions.length,2);assert.equal(probe(target.pid),true);assert.equal(complete(failed),false);
if(dropped)original(dropped);await controller.step();assert.equal(store.read(timeoutId).stop_request.actions.length,2);
console.log('NATIVE_TIMEOUT',JSON.stringify(failed));b.close();
// Full product supervisor observes broker loss without killing or adopting its target.
const loss=await startRun(store,[process.execPath,'-e','setTimeout(()=>{},30000)'],root,'native-loss');const lost=store.read(loss);process.kill(lost.windows.identity.broker_pid);
const deadline=Date.now()+45000;while(!store.read(loss).windows.error){assert.ok(Date.now()<deadline);await delay(50);}
assert.equal(probe(lost.pid),true);assert.equal(complete(store.read(loss)),false);
// Broker close and a pending write can race: both categories are honest refusal.
const beforeLossStop=readFileSync(store.directory(loss)+'\\meta.json');
for(let attempt=0;attempt<2;attempt++)await assert.rejects(stopRun(store,loss),{message:/^(observer-lost|delivery-uncertain):/});
assert.deepEqual(readFileSync(store.directory(loss)+'\\meta.json'),beforeLossStop);
assert.equal(store.read(loss).stop_request,undefined);assert.equal(taskOccupants(store,'native-loss').length,1);
console.log('NATIVE_LOSS',JSON.stringify(store.read(loss)));
const finiteDeadline=Date.now()+45000;while([lost.pid,target.pid,created.value.pid].some(pid=>probe(pid)===true)&&Date.now()<finiteDeadline)await delay(100);assert.equal(probe(lost.pid),false);assert.equal(probe(target.pid),false);assert.equal(probe(created.value.pid),false);
console.log('FINITE_TARGETS_EXITED');

console.log('NATIVE_ARCHIVE',root); // Retain the run evidence and avoid masking assertions with CWD cleanup.
