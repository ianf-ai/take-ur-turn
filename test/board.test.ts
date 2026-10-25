import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import { BOARD_CORE_SCRIPT } from "../src/core/hub/board-client.js";
import { nativeArgv } from "../src/standalone/launcher-headless/plan.js";
import { derive } from "../src/core/hub/state-machine.js";
import type { ContextRecord, Flow } from "../src/core/common/types.js";
import { boardV2App } from "./helpers/kibitz-browser.js";
import { BOARD_HTML } from "../src/core/hub/board.js";

function browser(fetcher = vi.fn()) {
  const ctx = vm.createContext({ setTimeout, clearTimeout, AbortController, Date, fetch: fetcher });
  vm.runInContext(BOARD_CORE_SCRIPT, ctx);
  return ctx;
}
const response = (data: unknown) => ({ ok: true, json: async () => data });
const snapshot = (kind = "tasks", root = "/hub") => ({ hub_root: root, [kind]: [] });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-17T00:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });

describe("board browser core (actual embedded script)", () => {
  it("orders approvals by pending_since, unknown last, then attention and dwell; does not mutate", () => {
    const ctx = browser();
    const tasks = [
      { task_id: "active", status: "implementing", updated_at: "2026-01-01" },
      { task_id: "unknown", status: "pending_approval", pending_since: "unknown" },
      { task_id: "new", status: "pending_approval", pending_since: "2026-01-01" },
      { task_id: "old", status: "pending_approval", pending_since: "2025-01-01" },
      { task_id: "attention", status: "designing", needs_attention: true },
    ];
    expect(ctx.sortTasks(tasks).map((x: { task_id: string }) => x.task_id)).toEqual(["old", "new", "unknown", "attention", "active"]);
    expect(tasks[0]!.task_id).toBe("active");
  });
  it("backs off 5/10/20/30/30 seconds and resets on recovery while retaining last snapshot", async () => {
    const data = snapshot();
    const fetcher = vi.fn().mockResolvedValueOnce(response(data)).mockRejectedValue(new Error("offline"));
    const ctx = browser(fetcher), update = vi.fn();
    const poller = ctx.createPoller("/state", "tasks", () => true, update);
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.state.retryAt - Date.now()).toBe(5000);
    for (const delay of [10000, 20000, 30000, 30000]) {
      await vi.advanceTimersByTimeAsync(poller.state.retryAt - Date.now());
      expect(poller.state.retryAt - Date.now()).toBe(delay);
      expect(poller.state.snapshot).toEqual(data);
      expect(poller.state.error).toBe("offline");
    }
    fetcher.mockResolvedValue(response(data));
    await vi.advanceTimersByTimeAsync(30000);
    expect(poller.state.error).toBeNull();
    expect(poller.state.retryAt - Date.now()).toBe(5000);
    expect(fetcher.mock.calls.every(([, options]) => options.cache === "no-store")).toBe(true);
    poller.stop();
  });
  it("times out without overlapping scheduled requests; ignores late data after timeout or stop", async () => {
    let resolveLate!: (x: unknown) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveLate = resolve; })).mockResolvedValue(response(snapshot()));
    const ctx = browser(fetcher), update = vi.fn();
    const poller = ctx.createPoller("/state", "tasks", () => true, update);
    await vi.advanceTimersByTimeAsync(4999); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poller.state.error).toBe("请求超时"); expect(poller.state.snapshot).toBeNull();
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(poller.state.snapshot).toEqual(snapshot());
    resolveLate(response(snapshot("tasks", "/late")));
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.state.snapshot.hub_root).toBe("/hub");
    poller.stop(); await vi.advanceTimersByTimeAsync(60000); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("treats bad HTTP/JSON/structure as errors, never an empty success", async () => {
    for (const invalid of [
      { ok: false, status: 500 }, { ok: true, json: async () => { throw new Error("JSON"); } },
      response({ tasks: [] }), response({ hub_root: "/hub", tasks: [null] }),
      response({ hub_root: "/hub", tasks: [], degraded: [null] }),
      response({ hub_root: "/hub", tasks: [{ task_id: "t", title: "t", status: "implementing", warnings: [null] }] }),
    ]) {
      const ctx = browser(vi.fn().mockResolvedValue(invalid));
      const poller = ctx.createPoller("/state", "tasks", () => true, vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(poller.state.error).toBeTruthy(); expect(poller.state.snapshot).toBeNull();
      poller.stop();
    }
  });
  it("keeps independent section snapshots and rejects changed Hub roots", async () => {
    let root: string | null = null, changed = false;
    const accept = (next: string) => { root ??= next; changed ||= root !== next; return !changed; };
    const stateFetch = vi.fn().mockResolvedValue(response(snapshot()));
    const runFetch = vi.fn().mockRejectedValue(new Error("runs only"));
    const ctx = browser();
    const tasks = ctx.createPoller("/state", "tasks", accept, vi.fn(), stateFetch);
    const runs = ctx.createPoller("/runs", "runs", accept, vi.fn(), runFetch);
    await vi.advanceTimersByTimeAsync(10000);
    expect(stateFetch).toHaveBeenCalledTimes(3); expect(runFetch).toHaveBeenCalledTimes(2);
    expect(tasks.state.error).toBeNull(); expect(runs.state.snapshot).toBeNull();
    runFetch.mockResolvedValue(response(snapshot("runs")));
    await vi.advanceTimersByTimeAsync(20000); expect(runs.state.error).toBeNull();
    stateFetch.mockRejectedValue(new Error("state only"));
    await vi.advanceTimersByTimeAsync(5000); expect(tasks.state.error).toBe("state only"); expect(runs.state.error).toBeNull();
    runFetch.mockResolvedValue(response(snapshot("runs", "/different")));
    await vi.advanceTimersByTimeAsync(5000);
    expect(changed).toBe(true); expect(runs.state.error).toContain("归属已变化");
    expect(runs.state.snapshot.hub_root).toBe("/hub");
    tasks.stop(); runs.stop();
  });
  it("embeds scripts and styles without imports, remote assets, data HTML sinks or write actions", () => {
    expect(BOARD_HTML).toContain(BOARD_CORE_SCRIPT);
    expect(BOARD_HTML.replaceAll("http://www.w3.org/2000/svg", "")).not.toMatch(/\bimport\b|https?:\/\/|<script[^>]+src=|@import|innerHTML|<form|setInterval/);
    expect(BOARD_HTML).toContain("textContent");
    expect(browser().validSnapshot({ hub_root: "/hub", tasks: [], degraded: ["unreadable-task"] }, "tasks")).toBe(true);
    expect(BOARD_HTML).toContain("/state"); expect(BOARD_HTML).toContain("/runs");
    expect(BOARD_HTML).toContain("数据已过期"); expect(BOARD_HTML).toContain("last write");
  });
});

const task = (id: string, status = 'implementing', extra = {}) => ({task_id:id,title:'Title '+id,status,version:2,round_count:3,warnings:[],pending_since:null,updated_at:'2026-10-16T23:59:00Z',waiting_for:'agent:executor',needs_attention:false,...extra});
const run = (id = 'run-1', extra = {}) => ({run_id:id,task_id:'t',argv_summary:'["codex","-m","model-1"]',started_at:'2026-10-16T23:59:00Z',status:'running',pid:42,pid_alive:true,degraded:false,issues:[],log_available:true,log_truncated:false,log_tail:[],...extra});
const records = (id='t') => ({task_id:id,versions:[1,2].map(version=>({version,role:'executor',content_type:'note',timestamp:'2026-10-16T23:00:00Z',payload:{summary:'summary '+version,body:'body '+version}}))});
function chunk(id: string, from: number, text: string, eof=true) {
  const bytes=Buffer.from(text);return {run_id:id,from,next:from+bytes.length,size:from+bytes.length+(eof?0:1),eof,encoding:'base64',data:bytes.toString('base64')};
}
function appFetch(tasks: unknown[], runs: unknown[] = [], extra = async (_url: string):Promise<any> => response({})) {
  // Workspace discovery is independent of the task usage and log fixtures.
  return vi.fn(async (url:string, _options?: RequestInit) => url.startsWith('/state')?response({hub_root:'/hub',tasks}):url==='/runs'?response({hub_root:'/hub',runs}):url==='/hubs'?response([]):extra(url));
}
function selectBucket(app: ReturnType<typeof boardV2App>, key:string) {
  app.elements.get('state-rail')!.all().find(n=>n.dataset.bucket===key)!.dispatch('click');
}
function selectRow(app: ReturnType<typeof boardV2App>, id:string) {
  app.elements.get('rows')!.all().find(n=>n.dataset.taskId===id)!.dispatch('click');
}
function expectEmptyDetail(app: ReturnType<typeof boardV2App>) {
  expect(app.location.hash).toBe('');
  expect(app.elements.get('r-empty')!.hidden).toBe(false);
  expect(app.elements.get('r-view')!.hidden).toBe(true);
  expect(app.elements.get('r-view')!.children).toHaveLength(0);
  expect(app.elements.get('r-cap')!.text()).toBe('LIVE VIEW · click a task row');
  expect(app.elements.get('panel-warning')!.hidden).toBe(true);
  expect(app.elements.get('panel-warning')!.text()).toBe('');
  expect(app.elements.get('rows')!.all().some(n=>n.attrs['aria-selected']==='true')).toBe(false);
}
it('ships v11 dark regions, workspace navigation, only read requests and no retired page graphs',()=>{
  expect(BOARD_HTML).toContain('color-scheme:dark');
  for(const id of ['state-rail','rows','r-view'])expect(BOARD_HTML).toContain('id="'+id+'"');
  expect(BOARD_HTML).toContain('id="workspace-tabs"');
  expect(BOARD_HTML).not.toMatch(/walk-graph|flow-mini|dwell timeline|graphManifest|createHistoryQueue|\bPOST\b|\bPUT\b|\bPATCH\b|\bDELETE\b/);
  expect(BOARD_HTML).toContain('停止与审批沿用既有 CLI / 人工流程');
});
it('renders the current workspace and native links to other Hub boards without cross-Hub fetches',async()=>{
  const hubs=[{url:'http://127.0.0.1:3001',hub_root:'/projects/hub',port:3001,is_self:true},
    {url:'http://127.0.0.1:3003',hub_root:'/other/workspace',port:3003,is_self:false}];
  const base=appFetch([task('t')]),fetcher=vi.fn((url:string,options:any)=>url==='/hubs'?Promise.resolve(response(hubs)):base(url,options));
  const app=boardV2App(fetcher);await vi.advanceTimersByTimeAsync(0);
  const tabs=app.elements.get('workspace-tabs')!;
  expect(tabs.hidden).toBe(false);expect(app.elements.get('hub-root')!.hidden).toBe(true);
  expect(tabs.children[0]!.attrs['selected']).toBe('');expect(tabs.children[0]!.text()).toBe('hub');
  const option=tabs.children[1]!;expect(option.tagName).toBe('option');expect(option.text()).toBe('workspace');
  expect(option.value).toBe('http://127.0.0.1:3003/board');expect(tabs.listeners.change).toHaveLength(1);
  tabs.dispatch('change',{target:{value:option.value}});expect(app.location.href).toBe('http://127.0.0.1:3003/board');
  expect(fetcher.mock.calls.every(([url,options])=>url.startsWith('/')&&(!options.method||options.method==='GET'))).toBe(true);
  app.stop();
});
it.each(['offline','empty','self','invalid'])('collapses workspace navigation to its own name on %s discovery',async mode=>{
  const base=appFetch([]),fetcher=vi.fn((url:string,options:any)=>{
    if(url!=='/hubs')return base(url,options);
    if(mode==='offline')return Promise.reject(Error('offline'));
    return Promise.resolve(response(mode==='self'?[{url:'http://127.0.0.1:3001',hub_root:'/hub',port:3001,is_self:true}]:mode==='invalid'?{}:[]));
  });
  const app=boardV2App(fetcher);await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('workspace-tabs')!.hidden).toBe(true);expect(app.elements.get('hub-root')!.text()).toBe('hub');
  expect(app.elements.get('hub-root')!.attrs.title).toBe('/hub');app.stop();
});
it('clears cached workspace tabs when discovery times out after a persisted page restore',async()=>{
  const hubs=[{url:'http://127.0.0.1:3003',hub_root:'/other/workspace',port:3003,is_self:false}];
  const base=appFetch([]);let requests=0,resolveLate!:(value:unknown)=>void,signal!:AbortSignal;
  const app=boardV2App((url:string,options:RequestInit)=>{
    if(url!=='/hubs')return base(url,options);
    if(++requests===1)return Promise.resolve(response(hubs));
    signal=options.signal!;return new Promise(resolve=>{resolveLate=resolve;});
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('workspace-tabs')!.hidden).toBe(false);
  app.stop();app.window.dispatch('pageshow',{persisted:true});await vi.advanceTimersByTimeAsync(5200);
  expect(requests).toBe(2);expect(signal.aborted).toBe(true);
  expect(app.elements.get('workspace-tabs')!.hidden).toBe(true);
  expect(app.elements.get('hub-root')!.hidden).toBe(false);
  expect(app.elements.get('hub-root')!.text()).toBe('hub');expect(app.elements.get('hub-root')!.attrs.title).toBe('/hub');
  resolveLate(response(hubs));await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('workspace-tabs')!.hidden).toBe(true);app.stop();
});
it.each(['pagehide','root change'])('ignores late workspace discovery after %s',async cause=>{
  const base=appFetch([]);let resolveLate!:(value:unknown)=>void;
  const app=boardV2App((url:string,options:RequestInit)=>url==='/hubs'?new Promise(resolve=>{resolveLate=resolve;}):base(url,options));
  await vi.advanceTimersByTimeAsync(0);
  if(cause==='pagehide')app.stop();else app.evaluate("acceptRoot('/changed')");
  resolveLate(response([{url:'http://127.0.0.1:3003',hub_root:'/late/workspace',port:3003,is_self:false}]));
  await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('workspace-tabs')!.hidden).toBe(true);
  expect(app.elements.get('hub-root')!.hidden).toBe(false);app.stop();
});
it('keeps fresh discovery after restore when an older cancelled request responds late',async()=>{
  const base=appFetch([]);let requests=0,resolveOld!:(value:unknown)=>void;
  const hub=(name:string)=>[{url:'http://127.0.0.1:3003',hub_root:'/other/'+name,port:3003,is_self:false}];
  const app=boardV2App((url:string,options:RequestInit)=>{
    if(url!=='/hubs')return base(url,options);
    return ++requests===1?new Promise(resolve=>{resolveOld=resolve;}):Promise.resolve(response(hub('fresh')));
  });
  await vi.advanceTimersByTimeAsync(0);app.stop();app.window.dispatch('pageshow',{persisted:true});await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('workspace-tabs')!.text()).toContain('fresh');
  resolveOld(response(hub('outdated')));await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('workspace-tabs')!.text()).toContain('fresh');
  expect(app.elements.get('workspace-tabs')!.text()).not.toContain('outdated');app.stop();
});
it('rejects external, credentialed and non-HTTP navigation targets and renders workspace names as text',async()=>{
  const attack='<img src=x onerror=alert(1)>',base=appFetch([]);
  const hubs=['https://127.0.0.1:3003','http://evil.example:3003','http://u:p@127.0.0.1:3003','javascript:alert(1)','http://127.0.0.1:9999'].map(url=>({url,hub_root:'/bad',port:3003,is_self:false}));
  hubs.push({url:'http://127.0.0.1:3003',hub_root:'/other/'+attack,port:3003,is_self:false});
  const app=boardV2App((url:string,options:any)=>url==='/hubs'?Promise.resolve(response(hubs)):base(url,options));
  await vi.advanceTimersByTimeAsync(0);const tabs=app.elements.get('workspace-tabs')!;
  expect(tabs.children).toHaveLength(2);expect(tabs.children[1]!.text()).toBe(attack);
  expect(app.all().some(n=>n.tagName==='img')).toBe(false);app.stop();
});
it('groups actual derived approvals for every flow, retains Approved and unknown states, and does no row history reads',async()=>{
  const approvals = (['full','direct','solo'] as Flow[]).map(flow=>{
    const types=flow==='direct'?['code_changes','review']:flow==='solo'?['design','code_changes']:['design','code_changes','review'];
    const sequence:ContextRecord[]=types.map((content_type,index)=>({task_id:flow,version:index+1,content_type,role:content_type==='design'?'architect':content_type==='review'?'reviewer':'executor',timestamp:'2026-10-16T23:00:00Z',payload:{summary:content_type,body:content_type,...(content_type==='review'?{verdict:'pass'}:{})}}));
    const state=derive(flow,sequence,flow)!;
    expect(state.status).toBe('pending_approval');expect(state.needs_attention).toBe(false);expect(state.waiting_for).toBe('human');
    return task(flow,state.status,state);
  });
  const tasks=[task('t'),task('d','designing'),task('p','reviewing',{needs_attention:true,waiting_for:'human'}),task('r','reviewing',{needs_attention:false,waiting_for:'human'}),task('a','approved',{waiting_for:'human'}),task('future','future_state'),...approvals];
  const fetcher=appFetch(tasks,[run(),run('old',{started_at:'2020-01-01T00:00:00Z',argv_summary:'["pi","--model","old-model"]'})]);
  const app=boardV2App(fetcher);await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('state-rail')!.all().filter(n=>n.dataset.bucket&&n.dataset.bucket!=='unmapped').map(n=>n.dataset.bucket)).toEqual(["designing","implementing","reviewing","needs-human","done"] as const);
  expect(app.elements.get('rows')!.text()).toContain('codex · model-1');expect(app.elements.get('rows')!.text()).toContain('round 3');
  selectBucket(app,'needs-human');for(const flow of ['full','direct','solo'])expect(app.elements.get('rows')!.text()).toContain('Title '+flow);
  expect(app.elements.get('rows')!.text()).toContain('Title p');expect(app.elements.get('rows')!.text()).not.toContain('Title r');expect(app.elements.get('th-who')!.text()).toBe('Tokens');
  selectBucket(app,'reviewing');expect(app.elements.get('rows')!.text()).toContain('Title r');expect(app.elements.get('rows')!.text()).not.toContain('Title p');
  selectBucket(app,'done');expect(app.elements.get('rows')!.text()).toContain('Title a');
  selectBucket(app,'designing');expect(app.elements.get('rows')!.text()).toContain('Title d');
  selectBucket(app,'unmapped');expect(app.elements.get('rows')!.text()).toContain('future_state');expect(app.elements.get('rows')!.text()).not.toContain('Title d');expect(app.elements.get('rows')!.text()).not.toContain('pending_approval');
  expect(app.elements.get('state-rail')!.all().find(n=>n.dataset.bucket==='unmapped')!.children.at(-1)!.text()).toBe('1');
  expect(fetcher.mock.calls.some(([url])=>url.includes('/versions'))).toBe(false);app.stop();
});
it('projects five buckets and joins every needs_attention task into needs-human regardless of base status',async()=>{
  const flagged=(id:string,status:string)=>task(id,status,{needs_attention:true,waiting_for:'human'});
  const tasks=[flagged('p','reviewing'),flagged('i','implementing'),flagged('d','designing'),flagged('pa','pending_approval'),flagged('ap','approved'),flagged('fu','future_state'),
    task('rev','revising'),task('cl','closed')];
  const app=boardV2App(appFetch(tasks));await vi.advanceTimersByTimeAsync(0);
  const rail=app.elements.get('state-rail')!;
  expect(rail.all().filter(n=>n.dataset.bucket&&n.dataset.bucket!=='unmapped').map(n=>n.dataset.bucket)).toEqual(["designing","implementing","reviewing","needs-human","done"] as const);
  expect(Object.fromEntries(rail.all().filter(n=>n.dataset.bucket).map(n=>[n.dataset.bucket,n.children.at(-1)!.text()]))).toEqual({designing:'0',implementing:'1',reviewing:'0',"needs-human":'6',done:'1'});
  expect(rail.all().some(n=>n.dataset.bucket==='unmapped')).toBe(false);
  selectBucket(app,'needs-human');const rows=app.elements.get('rows')!.text();
  for(const id of ['p','i','d','pa','ap','fu'])expect(rows).toContain('Title '+id);
  selectBucket(app,'implementing');expect(app.elements.get('rows')!.text()).toContain('Title rev');
  selectBucket(app,'reviewing');expect(app.elements.get('rows')!.text()).toContain('No tasks');
  selectBucket(app,'done');expect(app.elements.get('rows')!.text()).toContain('Title cl');expect(app.elements.get('rows')!.text()).not.toContain('Title ap');
  app.stop();
});
it('keeps machine-status behavior for card details inside projected buckets',async()=>{
  const tasks=[task('p','reviewing',{needs_attention:true,waiting_for:'human'}),task('pa','pending_approval',{waiting_for:'human'})];
  const fetcher=appFetch(tasks,[run('run-p',{task_id:'p'})],async url=>url.endsWith('/usage')?response({schema_version:1,rounds:[{total_tokens:321}]}):url.endsWith('/versions')?response(records('pa')):response(chunk('run-p',0,'working\n')));
  const app=boardV2App(fetcher);await vi.advanceTimersByTimeAsync(0);
  selectBucket(app,'needs-human');expect(app.elements.get('th-who')!.text()).toBe('Tokens');
  selectRow(app,'pa');await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('rows')!.text()).toContain('321 tok'); // machine LATE row still reads usage
  expect(app.elements.get('r-cap')!.text()).toContain('RECORDS');
  selectRow(app,'p');await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('r-cap')!.text()).toContain('LIVE VIEW'); // machine LIVE row still opens the terminal
  expect(app.elements.get('r-view')!.text()).toContain('working');
  app.stop();
});
it('shows bare rail arrows with one inline review junction and no done annotation or outgoing edge',async()=>{
  const app=boardV2App(appFetch([]));await vi.advanceTimersByTimeAsync(0);
  const rail=app.elements.get('state-rail')!;
  expect(rail.children.map(n=>n.dataset.bucket??n.text())).toEqual([
    'designing','↓','implementing','↓ ↑ fail_code','reviewing','↓ pass','needs-human','↓ approve','done'
  ]);
  const junction=rail.children[3]!;
  expect(junction.text()).toBe('↓ ↑ fail_code');expect(junction.children).toHaveLength(0);
  expect(BOARD_HTML).toMatch(/\.sarrow\{[^}]*white-space:nowrap/);
  const done=rail.children.at(-1)!;
  expect(done.children.map(n=>n.text())).toEqual(['','done','0']);
  for(const label of ['↓ design','↓ code_changes','↺','revising','close'])expect(rail.text()).not.toContain(label);
  app.stop();
});
it('switches the activity and agent column headings with each bucket',async()=>{
  const app=boardV2App(appFetch([]));await vi.advanceTimersByTimeAsync(0);
  for(const [key,third,fourth] of [
    ['needs-human','Status','Tokens'],['done','flow','Tokens'],
    ['designing','Activity','Agent · Model'],['implementing','Activity','Agent · Model'],['reviewing','Activity','Agent · Model']
  ]) {
    selectBucket(app,key!);
    expect(app.elements.get('th-activity')!.text()).toBe(third);
    expect(app.elements.get('th-who')!.text()).toBe(fourth);
  }
  app.stop();
});
it('renders intervention codes, approval time and completed flows from state without fetching row histories',async()=>{
  const pending='2026-10-16T23:30:00Z', warningCode='<img src=x onerror=alert(1)>';
  const tasks=[
    task('attention','reviewing',{needs_attention:true,warnings:[{code:'OUT_OF_TABLE',version:2},{code:warningCode,version:3}]}),
    task('both','pending_approval',{needs_attention:true,pending_since:pending,warnings:[{code:'VERSION_GAP',version:4}]}),
    task('approval','pending_approval',{pending_since:pending}),task('missing-time','pending_approval'),
    task('unknown-time','pending_approval',{pending_since:'unknown'}),task('missing-codes','implementing',{needs_attention:true,warnings:undefined}),
    ...(['full','direct','solo'] as const).map(flow=>task(flow,flow==='direct'?'closed':'approved',{flow})),
    task('missing-flow','closed')
  ];
  const fetcher=appFetch(tasks,[],async()=>response({schema_version:1,rounds:[]}));
  const app=boardV2App(fetcher);await vi.advanceTimersByTimeAsync(0);selectBucket(app,'needs-human');await vi.advanceTimersByTimeAsync(0);
  const thirdCell=(id:string)=>app.elements.get('rows')!.all().find(n=>n.dataset.taskId===id)!.children[2]!.text();
  expect(thirdCell('attention')).toBe('needs intervention · OUT_OF_TABLE, '+warningCode);
  expect(thirdCell('both')).toBe('needs intervention · VERSION_GAP');
  expect(thirdCell('approval')).toBe('awaiting approval · 30m');
  expect(app.elements.get('rows')!.text()).not.toContain(pending);
  for(const id of ['missing-time','unknown-time'])expect(thirdCell(id)).toBe('awaiting approval · unknown');
  expect(thirdCell('missing-codes')).toBe('needs intervention · unknown');
  expect(app.all().some(n=>n.tagName==='img')).toBe(false);
  selectBucket(app,'done');await vi.advanceTimersByTimeAsync(0);
  for(const flow of ['full','direct','solo'])expect(thirdCell(flow)).toBe(flow);
  expect(thirdCell('missing-flow')).toBe('unknown');
  expect(app.elements.get('rows')!.text()).not.toContain('round 3');
  expect(fetcher.mock.calls.some(([url])=>url.includes('/versions'))).toBe(false);
  app.stop();
});
it('formats approval waits in seconds, minutes, hours and days and ticks without another state fetch',async()=>{
  const cases=[['seconds',59000,'59s'],['minutes',300000,'5m'],['hours',7200000,'2h'],['days',259200000,'3d']] as const;
  const tasks=cases.map(([id,elapsed])=>task(id,'pending_approval',{pending_since:new Date(Date.now()-elapsed).toISOString()}));
  for(const [id,pending_since] of [
    ['missing',undefined],['null',null],['unknown','unknown'],['invalid','bad-time'],['future','2027-01-01T00:00:00Z']
  ])tasks.push(task(id!,'pending_approval',{pending_since}));
  const fetcher=appFetch(tasks,[],async()=>response({schema_version:1,rounds:[]}));
  const app=boardV2App(fetcher);await vi.advanceTimersByTimeAsync(0);selectBucket(app,'needs-human');await vi.advanceTimersByTimeAsync(0);
  const cell=(id:string)=>app.elements.get('rows')!.all().find(n=>n.dataset.taskId===id)!.children[2]!;
  for(const [id,,formatted] of cases)expect(cell(id).text()).toBe('awaiting approval · '+formatted);
  for(const id of ['missing','null','unknown','invalid','future'])expect(cell(id).text()).toBe('awaiting approval · unknown');
  expect(app.elements.get('rows')!.text()).not.toMatch(/\d{4}-\d\d-\d\dT/);
  const stateReads=()=>fetcher.mock.calls.filter(([url])=>url.startsWith('/state')).length;
  expect(stateReads()).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(cell('seconds').text()).toBe('awaiting approval · 1m');
  expect(cell('seconds').attrs.title).toBe('awaiting approval · 1m');
  expect(stateReads()).toBe(1);expect(fetcher.mock.calls.some(([url])=>url.includes('/versions'))).toBe(false);
  app.stop();
});
it('counts full-flow design tasks in Designing and opens their LIVE terminal on row selection; solo starts implementing',async()=>{
  expect(derive('solo',[],'solo')!.status).toBe('implementing');
  const tasks=(['full'] as Flow[]).map(flow=>{
    const state=derive(flow,[],flow)!;
    expect(state.status).toBe('designing');expect(state.needs_attention).toBe(false);
    return task(flow,state.status,{...state,flow});
  });
  const fetcher=appFetch(tasks,tasks.map(t=>run('run-'+t.task_id,{task_id:t.task_id})),async url=>{
    const id=url.split('/')[2]!;
    return response(chunk(id,0,'Designing '+id+'\n'));
  });
  const app=boardV2App(fetcher);await vi.advanceTimersByTimeAsync(0);
  const rail=app.elements.get('state-rail')!;
  expect(rail.all().find(n=>n.dataset.bucket==='designing')!.children.at(-1)!.text()).toBe('1');
  expect(rail.all().some(n=>n.dataset.bucket==='unmapped')).toBe(false);
  expect(rail.children[1]!.text()).toBe('↓');
  expect(rail.children[3]!.text()).toBe('↓ ↑ fail_code');
  selectBucket(app,'designing');
  expect(app.elements.get('mid-title')!.text()).toBe('DESIGNING · 1 tasks');
  expect(app.elements.get('th-who')!.text()).toBe('Agent · Model');
  for(const t of tasks){
    const row=app.elements.get('rows')!.all().find(n=>n.dataset.taskId===t.task_id)!;
    expect(row.text()).toContain('Title '+t.task_id);expect(row.text()).toContain('codex · model-1');
    expect(row.all().some(n=>n.className==='dot st-designing live')).toBe(true);
    row.dispatch('click');await vi.advanceTimersByTimeAsync(0);
    expect(app.elements.get('r-cap')!.text()).toBe('LIVE VIEW · Title '+t.task_id);
    expect(app.elements.get('r-view')!.all().some(n=>n.className==='term')).toBe(true);
    expect(app.elements.get('r-view')!.text()).toContain('Designing run-'+t.task_id);
  }
  expect(fetcher.mock.calls.some(([url])=>url.includes('/versions')||url.includes('/usage'))).toBe(false);
  app.stop();
});
const railBuckets=[['designing','designing'],['implementing','implementing'],['reviewing','reviewing'],['needs-human','pending_approval'],['done','approved'],['unmapped','future_state']] as const;
const railKeys=railBuckets.map(([key])=>key);
it.each(railKeys.flatMap(from=>railKeys.filter(to=>to!==from).map(to=>[from,to])))('clears selection synchronously when filtering from %s to %s',async(from,to)=>{
  const tasks=railBuckets.map(([key,status])=>task(key,status));
  const app=boardV2App(appFetch(tasks,[],async url=>url.endsWith('/usage')?response({schema_version:1,rounds:[]}):response(records(url.split('/')[2]))));
  await vi.advanceTimersByTimeAsync(0);selectBucket(app,from!);selectRow(app,from!);await vi.advanceTimersByTimeAsync(0);
  const recordButton=app.elements.get('r-view')!.all().find(n=>n.dataset.recordVersion);
  recordButton?.dispatch('click');
  selectBucket(app,from!);
  expect(app.location.hash).toBe('#task/'+from); // Same filter preserves reading.
  selectBucket(app,to!);expectEmptyDetail(app);
  await vi.advanceTimersByTimeAsync(5000);expectEmptyDetail(app);
  selectBucket(app,from!);expectEmptyDetail(app);
  selectRow(app,from!);await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('r-view')!.hidden).toBe(false);
  expect(app.elements.get('r-cap')!.text()).toContain('Title '+from);
  expect(app.elements.get('r-view')!.all().filter(n=>n.className==='rdetail'&&!n.hidden)).toHaveLength(0);
  app.stop();
});
it('clears expanded closed records when the implementing list is empty and reloads after a new row click',async()=>{
  const app=boardV2App(appFetch([task('t','closed')],[],async url=>url.endsWith('/usage')?response({schema_version:1,rounds:[]}):response(records())));
  await vi.advanceTimersByTimeAsync(0);selectBucket(app,'done');selectRow(app,'t');await vi.advanceTimersByTimeAsync(0);
  app.elements.get('r-view')!.all().find(n=>n.dataset.recordVersion)!.dispatch('click');
  expect(app.elements.get('r-view')!.text()).toContain('body 2');
  selectBucket(app,'implementing');expectEmptyDetail(app);expect(app.elements.get('rows')!.text()).toContain('No tasks');
  selectBucket(app,'done');expectEmptyDetail(app);selectRow(app,'t');await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('r-view')!.text()).toContain('summary 2');app.stop();
});
it.each(['records','log'].flatMap(kind=>['success','failure'].map(outcome=>[kind,outcome])))('aborts pending %s and ignores late %s after filtering',async(kind,outcome)=>{
  let resolve!:(value:unknown)=>void,reject!:(error:Error)=>void;
  const fetcher=appFetch([task('t',kind==='records'?'closed':'implementing')],kind==='log'?[run()]:[],async url=>url.endsWith('/usage')?response({schema_version:1,rounds:[]}):new Promise((yes,no)=>{resolve=yes;reject=no;}));
  const app=boardV2App(fetcher);await vi.advanceTimersByTimeAsync(0);
  const source=kind==='records'?'done':'implementing';selectBucket(app,source);selectRow(app,'t');await vi.advanceTimersByTimeAsync(0);
  const request=fetcher.mock.calls.find(([url])=>url.includes(kind==='records'?'/versions':'/log'))!;
  const signal=(request as unknown as [string,{signal:AbortSignal}])[1].signal;
  selectBucket(app,kind==='records'?'implementing':'done');expect(signal.aborted).toBe(true);expectEmptyDetail(app);
  selectBucket(app,source);expectEmptyDetail(app);
  if(outcome==='success')resolve(response(kind==='records'?records():chunk('run-1',0,'STALE LOG\n')));else reject(Error('STALE ERROR'));
  await vi.advanceTimersByTimeAsync(15000);expectEmptyDetail(app);
  expect(fetcher.mock.calls.filter(([url])=>url.includes(kind==='records'?'/versions':'/log'))).toHaveLength(1);
  app.stop();
});
it('shows visible record versions and renders all payload fields as safe text preserving string semantics',async()=>{
  const body='第一行 "引号" 🙂\n  第二行\n<script>evil()</script><img src=x onerror=alert(1)>\n字面 \\n 与 C:\\path\\file';
  const payload={summary:'摘要 "quoted" 🙂',body,extra:'literal \\n',object:{quote:'"',lines:['a','b']},array:[1,true,null],nil:null,flag:false,count:42,'<img onerror=evil()>':'<script>field</script>'};
  const data={task_id:'t',versions:[1,14,123456].map(version=>({...records().versions[0],version,content_type:'future_record',payload}))};
  const app=boardV2App(appFetch([task('t','closed',{version:123456,waiting_for:'human'})],[],async url=>url.endsWith('/usage')?response({schema_version:1,rounds:[]}):response(data)));
  await vi.advanceTimersByTimeAsync(0);selectBucket(app,'done');selectRow(app,'t');await vi.advanceTimersByTimeAsync(0);
  const pane=app.elements.get('r-view')!,buttons=()=>pane.all().filter(n=>n.dataset.recordVersion);
  expect(buttons().map(n=>n.all().find(c=>c.className==='rv')!.text())).toEqual(['v123456','v14','v1']);
  expect(buttons()[0]!.className).toContain('hi');buttons()[0]!.dispatch('click');
  const detail=pane.all().find(n=>n.className==='rdetail'&&!n.hidden)!;
  expect(detail.children.map(n=>n.children[0]!.textContent)).toEqual(Object.keys(payload));
  expect(detail.children.map(n=>n.children[1]!.textContent)).toEqual(Object.values(payload).map(value=>typeof value==='string'?value:JSON.stringify(value,null,2)));
  expect(app.all().some(n=>['script','img','form'].includes(n.tagName))).toBe(false);
  buttons()[1]!.dispatch('click');expect(pane.all().filter(n=>n.className==='rdetail'&&!n.hidden)).toHaveLength(1);
  expect(buttons()[1]!.attrs['aria-expanded']).toBe('true');app.stop();
});
it('groups actual derived approvals for every flow, retains Approved and unknown states, and does no row history reads',async()=>{
  const approvals = (['full','direct','solo'] as Flow[]).map(flow=>{
    const types=flow==='direct'?['code_changes','review']:flow==='solo'?['design','code_changes']:['design','code_changes','review'];
    const sequence:ContextRecord[]=types.map((content_type,index)=>({task_id:flow,version:index+1,content_type,role:content_type==='design'?'architect':content_type==='review'?'reviewer':'executor',timestamp:'2026-10-16T23:00:00Z',payload:{summary:content_type,body:content_type,...(content_type==='review'?{verdict:'pass'}:{})}}));
    const state=derive(flow,sequence,flow)!;
    expect(state.status).toBe('pending_approval');expect(state.needs_attention).toBe(false);expect(state.waiting_for).toBe('human');
    return task(flow,state.status,state);
  });
  const tasks=[task('t'),task('d','designing'),task('p','reviewing',{needs_attention:true,waiting_for:'human'}),task('r','reviewing',{needs_attention:false,waiting_for:'human'}),task('a','approved',{waiting_for:'human'}),task('future','future_state'),...approvals];
  const fetcher=appFetch(tasks,[run(),run('old',{started_at:'2020-01-01T00:00:00Z',argv_summary:'["pi","--model","old-model"]'})]);
  const app=boardV2App(fetcher);await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('state-rail')!.all().filter(n=>n.dataset.bucket&&n.dataset.bucket!=='unmapped').map(n=>n.dataset.bucket)).toEqual(["designing","implementing","reviewing","needs-human","done"] as const);
  expect(app.elements.get('rows')!.text()).toContain('codex · model-1');expect(app.elements.get('rows')!.text()).toContain('round 3');
  selectBucket(app,'needs-human');for(const flow of ['full','direct','solo'])expect(app.elements.get('rows')!.text()).toContain('Title '+flow);
  expect(app.elements.get('rows')!.text()).toContain('Title p');expect(app.elements.get('rows')!.text()).not.toContain('Title r');expect(app.elements.get('th-who')!.text()).toBe('Tokens');
  selectBucket(app,'reviewing');expect(app.elements.get('rows')!.text()).toContain('Title r');expect(app.elements.get('rows')!.text()).not.toContain('Title p');
  selectBucket(app,'done');expect(app.elements.get('rows')!.text()).toContain('Title a');
  selectBucket(app,'designing');expect(app.elements.get('rows')!.text()).toContain('Title d');
  selectBucket(app,'unmapped');expect(app.elements.get('rows')!.text()).toContain('future_state');expect(app.elements.get('rows')!.text()).not.toContain('Title d');expect(app.elements.get('rows')!.text()).not.toContain('pending_approval');
  expect(fetcher.mock.calls.some(([url])=>url.includes('/versions'))).toBe(false);app.stop();
});
it.each([
  ['designing','architect','designing'],
  ['implementing','executor','implementing'],
  ['revising','executor','implementing'],
  ['reviewing','reviewer','reviewing'],
])('shows pending in %s until a current-round run appears',async(status,role,key)=>{
  const runs:unknown[]=[run('other',{task_id:'another-task'})];
  const fetcher=appFetch([task('t',status,{waiting_for:'agent:'+role})],runs);
  const app=boardV2App(fetcher);await vi.advanceTimersByTimeAsync(0);selectBucket(app,key);
  const who=()=>app.elements.get('rows')!.children[0]!.children[3]!.text();
  expect(who()).toBe('pending');
  runs.push(run('previous',{started_at:'2026-10-16T23:58:59Z',status:'exited',pid_alive:false,argv_summary:'["pi","--model","previous-model"]'}));
  await vi.advanceTimersByTimeAsync(5000);
  expect(who()).toBe('pending');
  runs.push(run('next',{started_at:'2026-10-17T00:00:00Z'}));
  await vi.advanceTimersByTimeAsync(5000);
  expect(who()).toBe('codex · model-1');
  expect(fetcher.mock.calls.every(([url])=>['/state?include=closed','/runs','/hubs'].includes(url))).toBe(true);
  app.stop();
});
it.each([
  ['designing','implementing','architect','executor'],
  ['implementing','reviewing','executor','reviewer'],
  ['revising','reviewing','executor','reviewer'],
])('clears the previous command across %s → %s before the next launch',async(before,after,previousRole,nextRole)=>{
  const t=task('t',before,{waiting_for:'agent:'+previousRole});
  const runs=[run('previous',{argv_summary:'["pi","--model","previous-model"]'})];
  const fetcher=appFetch([t],runs),app=boardV2App(fetcher);
  await vi.advanceTimersByTimeAsync(0);selectBucket(app,before==='revising'?'implementing':before);
  const who=()=>app.elements.get('rows')!.children[0]!.children[3]!.text();
  expect(who()).toBe('pi · previous-model');
  // The old process may still be running after it publishes its delivery.
  Object.assign(t,{status:after,waiting_for:'agent:'+nextRole,version:3,updated_at:'2026-10-17T00:00:00Z'});
  await vi.advanceTimersByTimeAsync(5000);selectBucket(app,after);
  expect(who()).toBe('pending');
  runs.push(run('current',{started_at:t.updated_at}));
  await vi.advanceTimersByTimeAsync(5000);
  expect(who()).toBe('codex · model-1');
  expect(fetcher.mock.calls.some(([url])=>url.includes('/versions'))).toBe(false);
  app.stop();
});
it.each([
  ['2026-10-16T23:58:59.999Z','pending'],
  ['2026-10-16T23:59:00.000Z','codex · model-1'],
  ['2026-10-17T07:59:00+08:00','codex · model-1'],
  ['2026-10-16T23:59:00.001Z','codex · model-1'],
])('compares run time %s against the inclusive record-time boundary',async(started_at,expected)=>{
  const app=boardV2App(appFetch([task('t')],[run('current',{started_at,status:'exited'})]));
  await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('rows')!.children[0]!.children[3]!.text()).toBe(expected);app.stop();
});
it('selects the newest current-round run and re-bounds on a new record without a status change',async()=>{
  const t=task('t');
  const app=boardV2App(appFetch([t],[
    run('newest',{started_at:'2026-10-16T23:59:30Z',status:'exited'}),
    run('older',{argv_summary:'["pi","--model","older"]'}),
    run('other',{task_id:'another-task',started_at:'2026-10-17T00:00:00Z'}),
  ]));
  await vi.advanceTimersByTimeAsync(0);
  const who=()=>app.elements.get('rows')!.children[0]!.children[3]!.text();
  expect(who()).toBe('codex · model-1');
  t.updated_at='2026-10-17T00:00:00Z';t.version++;
  await vi.advanceTimersByTimeAsync(5000);expect(who()).toBe('pending');app.stop();
});
it.each([undefined,'unknown','invalid'])('keeps unavailable round timestamps (%s) unknown',async value=>{
  for(const [t,r] of [[task('t','implementing',{updated_at:value}),run()], [task('t'),run('current',{started_at:value})]]) {
    const app=boardV2App(appFetch([t],[r]));await vi.advanceTimersByTimeAsync(0);
    expect(app.elements.get('rows')!.children[0]!.children[3]!.text()).toBe('unknown');app.stop();
  }
});
it.each([
  {status:'running',pid_alive:false},
  {status:'running',pid_alive:null},
  {status:undefined,pid_alive:null},
  {status:'exited',pid_alive:false},
  {status:'stopped',pid_alive:true},
  {status:'stopped',pid_alive:false},
  {status:'stopped',pid_alive:null},
])('shows the current-round command regardless of process observations: %j',async extra=>{
  const app=boardV2App(appFetch([task('t')],[run('current',extra)]));await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('rows')!.children[0]!.children[3]!.text()).toBe('codex · model-1');app.stop();
});
it('does not infer no run before the first successful runs snapshot',async()=>{
  const base=appFetch([task('t')]);
  const fetcher=vi.fn((url:string,options?:RequestInit)=>url==='/runs'?Promise.reject(Error('offline')):base(url,options));
  const app=boardV2App(fetcher);await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('rows')!.children[0]!.children[3]!.text()).toBe('unknown · stale');app.stop();
});
it.each(['meta_missing','meta_invalid','unsafe_path'])('keeps run attribution unknown for %s and recovers on healthy snapshots',async code=>{
  const broken={run_id:'unreadable-active',pid_alive:null,degraded:true,issues:[{source:'meta',code}],log_available:false,log_tail:[],log_truncated:false};
  const runs:unknown[]=[broken];
  const app=boardV2App(appFetch([task('t','reviewing',{waiting_for:'agent:reviewer'})],runs));
  await vi.advanceTimersByTimeAsync(0);selectBucket(app,'reviewing');
  const who=()=>app.elements.get('rows')!.children[0]!.children[3]!.text();
  expect(who()).toBe('unknown');
  runs.push(run('previous',{status:'exited',pid_alive:false}));
  await vi.advanceTimersByTimeAsync(5000);
  expect(who()).toBe('unknown');
  runs.splice(0,runs.length);
  await vi.advanceTimersByTimeAsync(5000);
  expect(who()).toBe('pending');
  runs.push(run('current',{started_at:'2026-10-17T00:00:00Z'}));
  await vi.advanceTimersByTimeAsync(5000);
  expect(who()).toBe('codex · model-1');app.stop();
});
it.each([
  {task_id:undefined,degraded:true,issues:[{source:'log',code:'log_missing'}]},
  {task_id:'another-task',degraded:true,issues:[{source:'log',code:'log_invalid'}]},
  {task_id:'another-task',degraded:false,issues:[]},
])('does not confuse log failures or other task runs with unknown attribution: %j',async extra=>{
  const app=boardV2App(appFetch([task('t')],[run('other',extra),run('previous',{started_at:'2026-10-16T23:58:59Z',status:'exited',pid_alive:false,degraded:true,issues:[{source:'log',code:'log_missing'}]})]));
  await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('rows')!.children[0]!.children[3]!.text()).toBe('pending');app.stop();
});
it.each(['human','none',undefined,'agent:'])('does not use waiting_for=%s to select a current-round command',async waiting_for=>{
  const app=boardV2App(appFetch([task('t','implementing',{waiting_for})],[run('previous',{status:'exited'})]));
  await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('rows')!.children[0]!.children[3]!.text()).toBe('codex · model-1');app.stop();
});
it('preserves needs-human and done column behavior when no run is active',async()=>{
  const tasks=[task('flagged','reviewing',{needs_attention:true,waiting_for:'agent:reviewer'}),
    ...['pending_approval','approved','closed'].map(status=>task(status,status,{flow:'direct',waiting_for:'human'}))];
  const app=boardV2App(appFetch(tasks,[run('previous',{task_id:'flagged',status:'exited',started_at:'2020-01-01'}),run('broken',{task_id:undefined,degraded:true,issues:[{source:'meta',code:'meta_invalid'}]})],async()=>response({schema_version:1,rounds:[{total_tokens:321}]})));
  await vi.advanceTimersByTimeAsync(0);selectBucket(app,'needs-human');await vi.advanceTimersByTimeAsync(0);
  const rows=()=>app.elements.get('rows')!.children;
  expect(rows().find(r=>r.dataset.taskId==='flagged')!.children[3]!.text()).toBe('codex · model-1');
  expect(rows().find(r=>r.dataset.taskId==='pending_approval')!.children[3]!.text()).toBe('321 tok');
  expect(app.elements.get('th-activity')!.text()).toBe('Status');
  selectBucket(app,'done');await vi.advanceTimersByTimeAsync(0);
  expect(rows()).toHaveLength(2);
  for(const row of rows()) {expect(row.children[2]!.text()).toBe('direct');expect(row.children[3]!.text()).toBe('321 tok');}
  app.stop();
});
it('shows Pending approval tokens and human-highlighted expandable records',async()=>{
  const app=boardV2App(appFetch([task('t','pending_approval',{waiting_for:'human'})],[],async url=>url.endsWith('/usage')?response({schema_version:1,rounds:[{total_tokens:321}]}):response(records())),'#task/t');
  await vi.advanceTimersByTimeAsync(0);selectBucket(app,'needs-human');selectRow(app,'t');await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('rows')!.text()).toContain('321 tok');expect(app.elements.get('r-cap')!.text()).toContain('RECORDS');
  const pane=app.elements.get('r-view')!,buttons=pane.all().filter(n=>n.dataset.recordVersion);
  expect(buttons.map(n=>n.dataset.recordVersion)).toEqual(['2','1']);expect(buttons[0]!.className).toContain('hi');
  buttons[0]!.dispatch('click');expect(pane.all().find(n=>n.className==='rdetail'&&!n.hidden)!.text()).toContain('body 2');app.stop();
});
it.each([['--model','model-1'],['-m','model-1'],['--model=model-1'],['-mmodel-1']])('renders native model argv %j consistently in the LIVE row and terminal',async(...args)=>{
  const argv=nativeArgv({agent:'codex',args},'prompt');
  const app=boardV2App(appFetch([task('t')],[run('run-1',{argv_summary:JSON.stringify(argv)})],async()=>response(chunk('run-1',0,''))),'#task/t');
  await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('rows')!.text()).toContain('codex · model-1');
  expect(app.elements.get('r-view')!.all().find(n=>n.className==='ttitle')!.text()).toBe('codex · model-1');app.stop();
});
it.each(['["codex","--model"]','["codex","--model=","exec"]','["codex","--model","model-1','["codex","--model=model-1','["codex","-mmodel-1'])('keeps missing or truncated model unknown: %s',async argv_summary=>{
  const app=boardV2App(appFetch([task('t')],[run('run-1',{argv_summary})],async()=>response(chunk('run-1',0,''))),'#task/t');await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('rows')!.text()).toContain('codex · model unknown');expect(app.elements.get('r-view')!.all().find(n=>n.className==='ttitle')!.text()).toBe('codex · model unknown');app.stop();
});
it('sums per-round tokens, marks unresolved coverage partial and reports missing usage honestly',async()=>{
  const tasks=[task('a','approved'),task('b','approved'),task('c','approved')];
  const fetcher=appFetch(tasks,[],async url=>url.includes('/a/')?response({schema_version:1,rounds:[{total_tokens:100},{total_tokens:250}],unresolved:[{reason:'missing_session'}],total:{total_tokens:999999}}):url.includes('/b/')?{ok:false,status:404}:response({schema_version:1,rounds:[]}));
  const app=boardV2App(fetcher);await vi.advanceTimersByTimeAsync(0);selectBucket(app,'done');await vi.advanceTimersByTimeAsync(0);
  const text=app.elements.get('rows')!.text();expect(text).toContain('350 tok · partial');expect(text).not.toContain('999,999');expect(text).toContain('unknown · no usage');expect(text).not.toMatch(/(?:^|\n)0 tok(?:$|\n)/);
  expect(app.elements.get('th-who')!.text()).toBe('Tokens');expect(fetcher.mock.calls.filter(([u])=>u.includes('/usage'))).toHaveLength(3);app.stop();
});
it('renders all LATE records newest first, highlights human wait, and expands one payload at a time',async()=>{
  const app=boardV2App(appFetch([task('t','approved',{waiting_for:'human'})],[],async()=>response(records())),'#task/t');await vi.advanceTimersByTimeAsync(0);
  const pane=app.elements.get('r-view')!;const buttons=()=>pane.all().filter(n=>n.dataset.recordVersion);
  expect(buttons().map(n=>n.dataset.recordVersion)).toEqual(['2','1']);expect(buttons()[0]!.className).toContain('hi');
  buttons()[0]!.dispatch('click');expect(pane.all().filter(n=>n.className==='rdetail'&&!n.hidden)).toHaveLength(1);expect(pane.all().find(n=>n.className==='rdetail'&&!n.hidden)!.text()).toContain('body 2');
  buttons()[1]!.dispatch('click');expect(pane.all().filter(n=>n.className==='rdetail'&&!n.hidden)).toHaveLength(1);expect(pane.all().find(n=>n.className==='rdetail'&&!n.hidden)!.text()).toContain('body 1');app.stop();
});
it('uses latest run id and byte cursor, decodes split UTF-8, and distinguishes baseline from observed writes',async()=>{
  const bytes=Buffer.from('你好\n'),calls:number[]=[];
  const fetcher=appFetch([task('t')],[run('new'),run('old',{started_at:'2020-01-01'})],async url=>{
    expect(url).toContain('/runs/new/log');const from=Number(new URL(url,'http://local').searchParams.get('from'));calls.push(from);
    if(from===0)return response({run_id:'new',from:0,next:2,size:bytes.length,eof:false,encoding:'base64',data:bytes.subarray(0,2).toString('base64')});
    if(from===2)return response({run_id:'new',from:2,next:bytes.length,size:bytes.length,eof:true,encoding:'base64',data:bytes.subarray(2).toString('base64')});
    return response(chunk('new',from,'new write\n'));
  });
  const app=boardV2App(fetcher,'#task/t');await vi.advanceTimersByTimeAsync(5);
  expect(calls.slice(0,2)).toEqual([0,2]);expect(app.elements.get('r-view')!.text()).toContain('你好');expect(app.elements.get('r-view')!.text()).not.toContain('�');expect(app.elements.get('r-view')!.text()).toContain('last write unknown');
  await vi.advanceTimersByTimeAsync(1000);expect(app.elements.get('r-view')!.text()).toContain('last write 0s ago');app.stop();
});
it('pauses tail-follow on upward scroll, preserves position across chunks and resumes at bottom',async()=>{
  let writes=0;
  const app=boardV2App(appFetch([task('t')],[run()],async url=>{const from=Number(new URL(url,'http://local').searchParams.get('from'));return response(chunk('run-1',from,Array.from({length:20},(_,i)=>'line '+writes+' '+i).join('\n')+'\n'));}),'#task/t');
  await vi.advanceTimersByTimeAsync(0);const terminal=app.elements.get('r-view')!.all().find(n=>n.className==='tbody log-lines')!;
  expect(terminal.scrollTop).toBeGreaterThan(0);terminal.scrollTop=12;terminal.dispatch('scroll');writes++;
  await vi.advanceTimersByTimeAsync(1000);expect(terminal.scrollTop).toBe(12);expect(app.elements.get('r-view')!.text()).toContain('scroll paused');
  terminal.scrollTop=terminal.scrollHeight;terminal.dispatch('scroll');await vi.advanceTimersByTimeAsync(1000);expect(terminal.scrollTop).toBe(terminal.scrollHeight-terminal.clientHeight);app.stop();
});
it('retains cursor after transient error and halts on 416 until an explicit reload',async()=>{
  let fail=0;const cursors:number[]=[];
  const fetcher=appFetch([task('t')],[run()],async url=>{const from=Number(new URL(url,'http://local').searchParams.get('from'));cursors.push(from);if(fail===1)throw Error('offline');if(fail===2)return {ok:false,status:416};return response(chunk('run-1',from,'line\n'));});
  const app=boardV2App(fetcher,'#task/t');await vi.advanceTimersByTimeAsync(0);fail=1;await vi.advanceTimersByTimeAsync(1000);expect(cursors).toEqual([0,5]);
  fail=2;await vi.advanceTimersByTimeAsync(2000);expect(cursors).toEqual([0,5,5]);await vi.advanceTimersByTimeAsync(20000);expect(cursors).toHaveLength(3);
  expect(app.elements.get('panel-warning')!.text()).toContain('416');fail=0;app.elements.get('r-view')!.all().find(n=>n.tagName==='button'&&n.text()==='Reload log')!.dispatch('click');await vi.advanceTimersByTimeAsync(0);expect(cursors.at(-1)).toBe(0);app.stop();
});
it('ignores a late log response after selection changes and stops every poll on pagehide',async()=>{
  let resolve!:(value:unknown)=>void;
  const fetcher=appFetch([task('t'),task('b','closed')],[run()],async url=>url.includes('/log')?new Promise(r=>{resolve=r;}):url.endsWith('/versions')?response(records('b')):response({schema_version:1,rounds:[]}));
  const app=boardV2App(fetcher,'#task/t');await vi.advanceTimersByTimeAsync(0);app.navigate('#task/b');await vi.advanceTimersByTimeAsync(0);resolve(response(chunk('run-1',0,'WRONG TASK\n')));await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('r-view')!.text()).toContain('summary 2');expect(app.elements.get('r-view')!.text()).not.toContain('WRONG TASK');
  app.stop();const count=fetcher.mock.calls.length;await vi.advanceTimersByTimeAsync(60000);expect(fetcher.mock.calls).toHaveLength(count);
  app.window.dispatch('pageshow',{persisted:true});await vi.advanceTimersByTimeAsync(0);expect(fetcher.mock.calls.length).toBeGreaterThan(count);app.stop();
});
it('renders hostile fields as text and freezes dependent reads when Hub identity changes',async()=>{
  let root='/hub';const attack='<img src=x onerror=alert(1)>';
  const fetcher=vi.fn(async(url:string)=>url.startsWith('/state')?response({hub_root:root,tasks:[task('t','approved',{title:attack})]}):url==='/runs'?response({hub_root:root,runs:[]}):response({...records(),versions:[{...records().versions[0],version:2,payload:{summary:attack,body:'</script><script>evil</script>'}}]}));
  const app=boardV2App(fetcher,'#task/t');await vi.advanceTimersByTimeAsync(0);selectBucket(app,'done');selectRow(app,'t');await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('rows')!.text()).toContain(attack);expect(app.all().some(n=>['img','script','form'].includes(n.tagName))).toBe(false);
  app.elements.get('r-view')!.all().find(n=>n.dataset.recordVersion)!.dispatch('click');expect(app.elements.get('r-view')!.text()).toContain('</script><script>evil</script>');
  root='/other';await vi.advanceTimersByTimeAsync(5000);expect(app.elements.get('root-warning')!.hidden).toBe(false);const count=fetcher.mock.calls.filter(([u])=>!['/runs','/state?include=closed'].includes(u)).length;
  await vi.advanceTimersByTimeAsync(30000);expect(fetcher.mock.calls.filter(([u])=>!['/runs','/state?include=closed'].includes(u))).toHaveLength(count);
  selectBucket(app,'implementing');expectEmptyDetail(app);app.stop();
});

it('humanizes Codex JSON events and refreshes run status without replacing the log window',async()=>{
  const r=run();const events=[{type:'thread.started',thread_id:'session'},{type:'item.completed',item:{type:'reasoning',text:'Inspect the code'}},{type:'item.started',item:{type:'command_execution',command:'npm test'}},{type:'item.completed',item:{type:'agent_message',text:'Tests passed'}},{type:'turn.completed'}].map(e=>JSON.stringify(e)).join('\n')+'\n';
  const app=boardV2App(appFetch([task('t')],[r],async url=>{const from=Number(new URL(url,'http://local').searchParams.get('from'));return response(chunk('run-1',from,from===0?events:''));}),'#task/t');await vi.advanceTimersByTimeAsync(0);
  const panel=app.elements.get('r-view')!,terminal=panel.all().find(n=>n.className==='tbody log-lines');
  for(const text of ['Codex · session','思考  Inspect the code','工具  npm test','消息  Tests passed','完成  本轮输出结束'])expect(panel.text()).toContain(text);
  r.status='exited';r.pid_alive=false;await vi.advanceTimersByTimeAsync(5000);expect(panel.text()).toContain('exited · PID missing');expect(panel.all().find(n=>n.className==='tbody log-lines')).toBe(terminal);app.stop();
});
it('reports malformed usage as unknown and retains record snapshots on a version race',async()=>{
  const t=task('t','approved');let data:any=records();
  const app=boardV2App(appFetch([t],[],async url=>url.endsWith('/usage')?response({schema_version:7,rounds:[]}):response(data)),'#task/t');await vi.advanceTimersByTimeAsync(0);selectBucket(app,'done');selectRow(app,'t');await vi.advanceTimersByTimeAsync(0);
  expect(app.elements.get('rows')!.text()).toContain('unknown · usage 响应结构无效');
  t.version=3;await vi.advanceTimersByTimeAsync(5000);expect(app.elements.get('panel-warning')!.text()).toContain('同步中');expect(app.elements.get('r-view')!.text()).toContain('summary 2');
  data={...data,versions:[...data.versions,{...data.versions[0],version:3,payload:{summary:'new v3'}}]};await vi.advanceTimersByTimeAsync(10000);expect(app.elements.get('r-view')!.text()).toContain('new v3');app.stop();
});

it('refreshes usage while the task version stays unchanged so later audit coverage becomes visible',async()=>{
  let tokens=100;const fetcher=appFetch([task('a','approved')],[],async()=>response({schema_version:1,rounds:[{total_tokens:tokens}]}));
  const app=boardV2App(fetcher);await vi.advanceTimersByTimeAsync(0);selectBucket(app,'done');await vi.advanceTimersByTimeAsync(0);expect(app.elements.get('rows')!.text()).toContain('100 tok');
  tokens=300;await vi.advanceTimersByTimeAsync(5000);expect(app.elements.get('rows')!.text()).toContain('300 tok');app.stop();
});
it('fairly reads every delayed LATE row before repeated refreshes can starve the tail, with bounded concurrency and cached results',async()=>{
  const tasks=Array.from({length:20},(_,i)=>task('task-'+i,'closed'));
  const counts=new Map<string,number>();let active=0,peak=0,tokens=100;
  const fetcher=appFetch(tasks,[],async url=>{
    const id=url.split('/')[2]!;counts.set(id,(counts.get(id)??0)+1);active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,1000));active--;
    return id==='task-19'?{ok:false,status:404}:response({schema_version:1,rounds:[{total_tokens:tokens}]});
  });
  const app=boardV2App(fetcher);await vi.advanceTimersByTimeAsync(0);selectBucket(app,'done');
  await vi.advanceTimersByTimeAsync(10000);
  expect(counts.size).toBe(20);expect(peak).toBe(2);expect(app.elements.get('rows')!.text()).not.toContain('读取中');expect(app.elements.get('rows')!.text()).toContain('unknown · no usage');
  const firstCount=counts.get('task-0')!;tokens=300;
  await vi.advanceTimersByTimeAsync(1000);expect(app.elements.get('rows')!.text()).toContain('300 tok');
  expect(firstCount).toBeGreaterThan(1);
  const before=fetcher.mock.calls.length;selectBucket(app,'needs-human');selectBucket(app,'done');await vi.advanceTimersByTimeAsync(0);
  expect(fetcher.mock.calls).toHaveLength(before);expect(app.elements.get('rows')!.text()).toContain('300 tok');
  await vi.advanceTimersByTimeAsync(79000);
  for(const t of tasks)expect(counts.get(t.task_id)).toBeGreaterThan(1);
  expect(peak).toBe(2);expect(active).toBeLessThanOrEqual(2);app.stop();
});
