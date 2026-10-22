/** Browser-only JS kept as text so tsc ships one self-contained resource. */
export const BOARD_CORE_SCRIPT = String.raw`
function timestamp(value) {
  return typeof value === 'string' && value !== 'unknown' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
}
function sortTasks(tasks) {
  const sortTime = value => { const t = timestamp(value); return t !== null && t <= Date.now() ? t : Infinity; };
  return tasks.slice().sort((a, b) => {
    const ap = a.status === 'pending_approval', bp = b.status === 'pending_approval';
    if (ap !== bp) return ap ? -1 : 1;
    if (ap) return sortTime(a.pending_since) - sortTime(b.pending_since) || a.task_id.localeCompare(b.task_id);
    return Number(!!b.needs_attention) - Number(!!a.needs_attention) ||
      sortTime(a.state_since) - sortTime(b.state_since) || a.task_id.localeCompare(b.task_id);
  });
}
function validSnapshot(data, kind) {
  const object = x => x && typeof x === 'object' && !Array.isArray(x);
  if (!object(data) || typeof data.hub_root !== 'string' || !data.hub_root.trim() || !Array.isArray(data[kind])) return false;
  if (kind === 'tasks') return data.tasks.every(t => object(t) && typeof t.task_id === 'string' && typeof t.title === 'string' && typeof t.status === 'string' &&
    (t.warnings === undefined || (Array.isArray(t.warnings) && t.warnings.every(w => object(w) && typeof w.code === 'string' && Number.isInteger(w.version) && (w.message === undefined || typeof w.message === 'string'))))) &&
    (data.degraded === undefined || (Array.isArray(data.degraded) && data.degraded.every(t => typeof t === 'string')));
  return data.runs.every(r => object(r) && typeof r.run_id === 'string' && typeof r.degraded === 'boolean' &&
    typeof r.log_available === 'boolean' && typeof r.log_truncated === 'boolean' &&
    (r.status === undefined || ['running', 'stopped', 'exited'].includes(r.status)) && Array.isArray(r.log_tail) && r.log_tail.every(l => typeof l === 'string') &&
    Array.isArray(r.issues) && r.issues.every(i => object(i) && typeof i.code === 'string' && typeof i.source === 'string') &&
    (r.pid_alive === null || typeof r.pid_alive === 'boolean'));
}
function createPoller(url, kind, accept, update, fetcher = fetch, seed = null) {
  const state = { snapshot: seed?.snapshot ?? null, lastSuccess: seed?.lastSuccess ?? null, error: seed?.error ?? null, retryAt: null };
  let stopped = false, timer, controller, deadline, failures = 0;
  async function poll() {
    controller = new AbortController();
    try {
      const data = await Promise.race([
        (async () => {
          const response = await fetcher(url, { cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const value = await response.json();
          if (!validSnapshot(value, kind)) throw new Error('响应结构无效');
          return value;
        })(),
        new Promise((_, reject) => { deadline = setTimeout(() => { controller.abort(); reject(new Error('请求超时')); }, 5000); })
      ]);
      if (stopped) return;
      if (!accept(data.hub_root)) throw new Error('Hub 归属已变化，请重新载入');
      state.snapshot = data;
      state.lastSuccess = Date.now();
      state.error = null;
      failures = 0;
    } catch (error) {
      if (stopped) return;
      state.error = error.message || '读取失败';
      failures++;
    } finally { clearTimeout(deadline); }
    if (stopped) return;
    const delay = failures ? Math.min(30000, 5000 * 2 ** Math.min(failures, 3)) : 5000;
    state.retryAt = Date.now() + delay;
    update(state);
    timer = setTimeout(poll, delay);
  }
  poll();
  return { state, stop() { stopped = true; clearTimeout(timer); clearTimeout(deadline); controller.abort(); } };
}
`;

export const BOARD_UI_SCRIPT = String.raw`
function oneLineText(value, cap = 160) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return text.length > cap ? text.slice(0, cap - 1) + '…' : text;
}
/** Parse a JSON-stringified argv that may be cut mid-way: the /runs contract
 * caps argv_summary at 240 chars, so the tail (session id, prompt) is often
 * missing. Returns null when the text is not an argv array at all;
 * complete=false when the tail was cut. Only fully closed string tokens are
 * extracted, so any flag pair we do find is accurate. */
function argvPrefix(text) {
  if (typeof text !== 'string' || text[0] !== '[') return null;
  const items = []; let i = 1, complete = false;
  const ws = () => { while (i < text.length && ' \t\r\n'.includes(text[i])) i++; };
  ws();
  if (text[i] === ']') return { items, complete: true };
  while (i < text.length) {
    if (text[i] !== '"') return null;
    i++; let value = '', closed = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') { closed = true; i++; break; }
      if (ch === '\\') {
        const esc = text[i + 1];
        if (esc === undefined) return { items, complete: false };
        if (esc === 'u') {
          if (i + 5 >= text.length) return { items, complete: false };
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          value += String.fromCharCode(parseInt(hex, 16)); i += 6; continue;
        }
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!(esc in map)) return null;
        value += map[esc]; i += 2; continue;
      }
      value += ch; i++;
    }
    if (!closed) return { items, complete: false };
    items.push(value);
    ws();
    if (text[i] === ',') { i++; ws(); continue; }
    if (text[i] === ']') { complete = true; break; }
    if (i >= text.length) return { items, complete: false };
    return null;
  }
  return { items, complete };
}
// "agent --model model-1 --thinking max" → "agent · model-1 · thinking max" (agent · model · effort).
// Works from the server-capped 240-char summary: the early flags survive intact.
function commandSummary(argvSummary) {
  if (argvSummary === undefined) return { text: '未知', truncated: false };
  const parsed = argvPrefix(argvSummary);
  if (parsed === null || !parsed.items.length) return { text: oneLineText(argvSummary, 80), truncated: false };
  const argv = parsed.items;
  const value = flag => { const i = argv.indexOf(flag); return i >= 0 && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('-') ? argv[i + 1] : null; };
  const parts = [argv[0].split('/').pop() || argv[0]];
  const attachedModel = argv.slice(1).find(x => x.startsWith('--model=') || (x.startsWith('-m') && !x.startsWith('--') && x.length > 2));
  const model = value('--model') ?? value('-m') ?? (attachedModel?.startsWith('--model=') ? attachedModel.slice(8) : attachedModel?.slice(2));
  parts.push(model || 'model unknown');
  const thinking = value('--thinking'); if (thinking) parts.push('thinking ' + thinking);
  const effort = argv.find(x => x.startsWith('model_reasoning_effort=')); if (effort) parts.push(effort.slice(effort.indexOf('=')+1).replaceAll('\"',''));
  return { text: parts.join(' · '), truncated: !parsed.complete };
}
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => typeof b === 'string' ? b : b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '').join(' ');
  return '';
}
function briefArgs(args) {
  if (!args || typeof args !== 'object') return '';
  for (const key of ['command', 'path', 'file_path', 'url', 'task_id', 'pattern', 'query']) if (typeof args[key] === 'string') return oneLineText(args[key], 90);
  return '';
}
/** A parse failure is not plain text: the /runs contract slices the last
 * 64 KiB, so the first line of a truncated tail can start mid-JSON (all
 * protocol markers cut away) and the last line can be half written. Lines at
 * that slice boundary are conservatively fragments — missing markers are
 * never taken as evidence of launcher text. Marker-free unparseable lines
 * away from the boundary are launcher/stdout text and render as 输出. */
function looksLikeProtocol(text) {
  return text.startsWith('{') || text.startsWith('[') || /"(type|assistantMessageEvent|toolCallId|message|usage|session_id)":/.test(text);
}
/** One readable event line per raw log line (pi --mode json protocol or plain
 * launcher text). Streaming deltas are skipped; completed thinking/text blocks
 * and tool executions become 思考/消息/工具 lines. Unknown JSON shapes degrade
 * to a bare label — protocol JSON never reaches the default viewport.
 * options.boundary marks the first line of a byte-truncated tail. */
function humanizeLogLine(line, options) {
  if (!line.trim()) return null;
  let event;
  try { event = JSON.parse(line); } catch {
    if (looksLikeProtocol(line) || options?.boundary) return { label: '片段', text: '截断的协议记录 · 见原始流', fragment: true };
    return { label: '输出', text: oneLineText(line) };
  }
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') return { label: '事件', text: '未识别 JSON 记录' };
  const inner = event.assistantMessageEvent;
  switch (event.type) {
    case 'thread.started': return { label: '会话', text: 'Codex · ' + oneLineText(event.thread_id, 60) };
    case 'turn.started': return { label: '开始', text: '本轮工作开始' };
    case 'turn.completed': return { label: '完成', text: '本轮输出结束' };
    case 'turn.failed': return { label: '失败', text: oneLineText(event.error?.message ?? '本轮失败') };
    case 'error': return { label: '错误', text: oneLineText(event.message ?? '运行错误') };
    case 'item.started':
    case 'item.completed': {
      const item = event.item;
      if (!item || typeof item !== 'object') return { label: '事件', text: event.type };
      const done = event.type === 'item.completed';
      if (item.type === 'agent_message' || item.type === 'reasoning') return done ? { label: item.type === 'reasoning' ? '思考' : '消息', text: oneLineText(item.text, 300) } : null;
      if (item.type === 'command_execution') return { label: done ? '工具完成' : '工具', text: oneLineText(item.command, 200) + (done && Number.isInteger(item.exit_code) ? ' · exit ' + item.exit_code : '') };
      if (item.type === 'mcp_tool_call') return { label: done ? '工具完成' : '工具', text: oneLineText([item.server,item.tool].filter(Boolean).join(' · '), 160) };
      if (item.type === 'file_change') return done ? { label: '文件', text: oneLineText((Array.isArray(item.changes)?item.changes:[]).map(c=>c?.kind+' '+c?.path).join(' · ')) } : null;
      return { label: '事件', text: oneLineText(item.type ?? event.type) };
    }
    case 'session': return { label: '会话', text: oneLineText(String(event.cwd ?? '').split('/').pop() || event.id || '') };
    case 'agent_start': return { label: '开始', text: '本轮工作开始' };
    case 'agent_settled': return { label: '空闲', text: event.aborted ? '已中止' : '自动工作结束' };
    case 'message_start': return event.message && event.message.role === 'user' ? { label: '收到', text: oneLineText(contentText(event.message.content), 140) } : null;
    case 'message_update':
      if (inner && inner.type === 'thinking_end') return { label: '思考', text: oneLineText(inner.content, 140) };
      if (inner && inner.type === 'text_end') return { label: '消息', text: oneLineText(inner.content, 140) };
      return null;
    case 'tool_execution_start': return { label: '工具', text: [event.toolName, briefArgs(event.args)].filter(Boolean).join(' · ') };
    case 'tool_execution_end': return { label: event.isError ? '工具失败' : '工具完成', text: [event.toolName, Number.isFinite(event.durationMs) ? Math.round(event.durationMs) + ' ms' : ''].filter(Boolean).join(' · ') };
    case 'compaction_start': return { label: '压缩', text: '上下文压缩 · ' + (event.reason ?? '') };
    case 'compaction_end': return { label: '压缩', text: event.aborted ? '已中止' : event.errorMessage ? '失败 · ' + oneLineText(event.errorMessage, 80) : '完成 · ' + (Number.isFinite(event.result?.tokensBefore) ? event.result.tokensBefore + ' → ' + (Number.isFinite(event.result?.estimatedTokensAfter) ? event.result.estimatedTokensAfter + ' tokens' : '') : '') };
    case 'auto_retry_start': return { label: '重试', text: '第 ' + (event.attempt ?? '?') + '/' + (event.maxAttempts ?? '?') + ' 次 · ' + oneLineText(event.errorMessage, 90) };
    case 'auto_retry_end': return { label: '重试', text: event.success ? '成功' : '失败 · ' + oneLineText(event.finalError, 90) };
    case 'summarization_retry_scheduled': return { label: '摘要重试', text: oneLineText(event.errorMessage, 90) };
    default: return { label: '事件', text: event.type };
  }
}
const byId = id => document.getElementById(id);
function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = String(text);
  if (className) n.className = className;
  return n;
}
const LIVE = new Set(['designing', 'implementing', 'reviewing', 'revising']);
const LATE = new Set(['pending_approval', 'approved', 'closed']);
// Five-bucket display projection — a pure (status, needs_attention) → bucket
// map. Rail, counts and activity labels use buckets; machine values remain
// intact (detail panes, LIVE/LATE and the who column stay status-keyed).
// Bucket keys double as the English UI labels (human note v2).
const BUCKETS = ['designing','implementing','reviewing','needs-human','done'];
const LABELS = { designing:'designing',implementing:'implementing',reviewing:'reviewing','needs-human':'needs-human',done:'done',unmapped:'Unmapped' };
function bucket(t) {
  if (t.needs_attention === true || t.status === 'pending_approval') return 'needs-human';
  if (t.status === 'designing' || t.status === 'reviewing') return t.status;
  if (t.status === 'implementing' || t.status === 'revising') return 'implementing';
  if (t.status === 'approved' || t.status === 'closed') return 'done';
  return 'unmapped';
}
function age(value, now = Date.now()) {
  const time = timestamp(value);
  if (time === null || time > now) return 'unknown';
  const seconds = Math.floor((now-time)/1000);
  return seconds < 60 ? seconds+'s' : seconds < 3600 ? Math.floor(seconds/60)+'m' : seconds < 86400 ? Math.floor(seconds/3600)+'h' : Math.floor(seconds/86400)+'d';
}
function activity(t) {
  const parts = [Number.isInteger(t.round_count) ? 'round '+t.round_count : 'round unknown'];
  if (Array.isArray(t.warnings)) {
    if (t.warnings.length) parts.push(t.warnings.length+' warnings: '+t.warnings.map(w=>w.code+' · v'+w.version).join(', '));
  } else parts.push('warnings unknown');
  return parts.join(' · ');
}
function bucketActivity(t, key) {
  if (key === 'needs-human') {
    if (t.needs_attention === true) return 'needs intervention · ' + (t.warnings?.map(w=>w.code).join(', ') || 'unknown');
    return 'awaiting approval · ' + age(t.pending_since);
  }
  if (key === 'done') return t.flow ?? 'unknown';
  return activity(t);
}
function latestRun(taskId, runs) {
  return runs.filter(r=>r.task_id===taskId).slice().sort((a,b)=>(timestamp(b.started_at)??-Infinity)-(timestamp(a.started_at)??-Infinity)||b.run_id.localeCompare(a.run_id))[0] ?? null;
}
function tokenTotal(data) {
  if (!data || data.schema_version !== 1 || !Array.isArray(data.rounds) || (data.unresolved!==undefined&&!Array.isArray(data.unresolved))) throw Error('usage 响应结构无效');
  let total=0, known=0;
  for (const r of data.rounds) {
    if (r && Number.isSafeInteger(r.total_tokens) && r.total_tokens >= 0) { total+=r.total_tokens; known++; }
  }
  if (!Number.isSafeInteger(total)) throw Error('usage 总量超出安全范围');
  if (!data.rounds.length || !known) return 'unknown';
  const partial=known!==data.rounds.length||(Array.isArray(data.unresolved)&&data.unresolved.length>0);
  return total.toLocaleString('en-US')+' tok'+(partial?' · partial':'');
}
let hubRoot=null, rootChanged=false, suspended=false, selectedBucket='implementing';
const states={}, pollers=[], usage=new Map();
let detail=null, tickTimer, usageJobs=0, usageOrder=0;
let workspaceHubs=[], workspaceController;
function workspaceName(root) { return root.split(/[\\/]/).filter(Boolean).pop() || root; }
function renderWorkspaces() {
  const host=byId('workspace-tabs'), label=byId('hub-root');
  host.replaceChildren();
  if(hubRoot===null)return;
  label.textContent=workspaceName(hubRoot);label.setAttribute('title',hubRoot);
  const others=workspaceHubs.filter(h=>!h.is_self);
  const multiple=others.length>0&&!rootChanged;
  host.hidden=!multiple;label.hidden=multiple;
  if(!multiple)return;
  const hubs=[{hub_root:hubRoot,is_self:true},...others];
  for(const h of hubs) {
    const name=workspaceName(h.hub_root), duplicate=hubs.some(other=>other!==h&&workspaceName(other.hub_root)===name);
    const option=node('option',name+(duplicate?' · '+(h.is_self?'当前':h.port):''));
    option.setAttribute('title',h.hub_root);
    option.value=h.is_self?'':new URL('/board',h.url).href;
    if(h.is_self){option.selected=true;option.setAttribute('selected','');}
    host.append(option);
  }
  if(!host.dataset.bound){host.dataset.bound='1';host.addEventListener('change',e=>{const url=e.target&&e.target.value;if(url)location.href=url;});}
}
async function loadWorkspaces() {
  const controller=new AbortController();workspaceController=controller;
  let hubs=[];
  try {
    const data=await readJSON('/hubs',controller);
    if(!Array.isArray(data))throw Error('无效 Hub 列表');
    hubs=data.filter(h=>{
      if(!h||typeof h.hub_root!=='string'||!h.hub_root.trim()||typeof h.is_self!=='boolean')return false;
      try {
        const url=new URL(h.url);
        return url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.username&&!url.password&&
          Number.isInteger(h.port)&&Number(url.port)===h.port&&(h.is_self||(h.port>=3001&&h.port<=3199));
      }catch{return false;}
    });
  }catch{}
  // A timeout aborts the current request too: apply its empty fallback, but
  // never let an older request or an inactive page overwrite navigation.
  if(workspaceController===controller&&!suspended&&!rootChanged){workspaceHubs=hubs;renderWorkspaces();}
}
function selectedTask() { try { return location.hash.startsWith('#task/') ? decodeURIComponent(location.hash.slice(6)) : null; } catch { return null; } }
function taskList() { return states.tasks?.snapshot?.tasks ?? []; }
function runList() { return states.runs?.snapshot?.runs ?? []; }
function currentTask() { return taskList().find(t=>t.task_id===selectedTask()) ?? null; }
function acceptRoot(root) {
  if (hubRoot===null) {hubRoot=root;renderWorkspaces();}
  if (root!==hubRoot) {
    rootChanged=true;
    workspaceController?.abort();renderWorkspaces();
    stopDetail();
    for(const entry of usage.values()) entry.controller?.abort();
  }
  byId('root-warning').hidden=!rootChanged;
  return !rootChanged;
}
async function readJSON(url, controller) {
  let timer;
  try {
    return await Promise.race([
      (async()=>{
        const response=await fetch(url,{cache:'no-store',signal:controller.signal});
        if (!response.ok) throw Object.assign(Error('HTTP '+response.status),{status:response.status});
        return await response.json();
      })(),
      new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('请求超时'));},5000);})
    ]);
  } finally {clearTimeout(timer);}
}
function stateButton(key, count) {
  const button=node('button',undefined,'snode st-'+key+(selectedBucket===key?' on':''));
  button.type='button';button.dataset.bucket=key;button.setAttribute('aria-pressed',String(selectedBucket===key));
  button.append(node('span',undefined,'sd'),node('span',LABELS[key],'sn'),node('b',count));
  button.addEventListener('click',()=>{
    if(selectedBucket!==key){
      selectedBucket=key;
      location.hash='';
      clearDetail();
    }
    renderTable();
  });
  return button;
}
function renderRail() {
  const rail=byId('state-rail');rail.replaceChildren();
  for(const key of [...BUCKETS,...(taskList().some(t=>bucket(t)==='unmapped')?['unmapped']:[])]) {
    rail.append(stateButton(key,taskList().filter(t=>bucket(t)===key).length));
    const arrows={designing:'↓',implementing:'↓ ↑ fail_code',reviewing:'↓ pass','needs-human':'↓ approve'};
    if(arrows[key])rail.append(node('div',arrows[key],'sarrow'));
  }
}
function usageKey(t) {return String(t.version??'unknown');}
function renderTable() {
  renderRail();
  const visible=taskList().filter(t=>bucket(t)===selectedBucket).sort((a,b)=>(timestamp(b.updated_at)??0)-(timestamp(a.updated_at)??0)||a.task_id.localeCompare(b.task_id));
  byId('mid-title').textContent=(LABELS[selectedBucket]??selectedBucket).toUpperCase()+' · '+visible.length+' tasks';
  byId('th-activity').textContent=selectedBucket==='needs-human'?'Status':selectedBucket==='done'?'flow':'Activity';
  byId('th-who').textContent=selectedBucket==='done'||selectedBucket==='needs-human'?'Tokens':'Agent · Model';
  const rows=byId('rows');
  const focusId=rows.contains(document.activeElement)?document.activeElement.dataset.taskId:null;
  rows.replaceChildren();
  for(const t of visible) {
    const key=bucket(t),tr=node('tr',undefined,trClass(t));tr.tabIndex=0;tr.dataset.taskId=t.task_id;
    tr.setAttribute('aria-selected',String(t.task_id===selectedTask()));
    const dot=node('td',undefined,'dotc');dot.append(node('span',undefined,'dot st-'+key+(LIVE.has(t.status)?' live':'')));
    const name=node('td',undefined,'nm'),link=node('a',t.title);link.href='#task/'+encodeURIComponent(t.task_id);link.setAttribute('title',t.title);name.append(link,node('small',t.task_id));
    const who=node('td',undefined,'who');
    if(LATE.has(t.status)) {
      const cached=usage.get(t.task_id);
      who.textContent=cached?.text??'读取中…';
      if(cached?.error)who.setAttribute('title',cached.error);
    } else if(LIVE.has(t.status)) {
      const run=latestRun(t.task_id,runList());who.textContent=run?commandSummary(run.argv_summary).text:'unknown · no run';
      if(states.runs?.error)who.textContent+=' · stale';
    } else who.textContent='unknown · '+t.status;
    const ageCell=node('td',age(t.updated_at),'dw');ageCell.dataset.updatedAt=t.updated_at??'';
    const act=node('td',bucketActivity(t,key),'act');act.setAttribute('title',act.textContent);
    if(key==='needs-human'&&t.needs_attention!==true)act.dataset.pendingSince=t.pending_since??'';
    tr.append(dot,name,act,who,ageCell);
    const select=()=>{location.hash='#task/'+encodeURIComponent(t.task_id);syncDetail();renderTable();};
    tr.addEventListener('click',select);tr.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}});
    rows.append(tr);
  }
  if(!visible.length){const tr=node('tr'),td=node('td',states.tasks?.snapshot?'No tasks in this bucket':'正在读取…','empty');td.setAttribute('colspan','5');tr.append(td);rows.append(tr);}
  if(focusId){const target=[...rows.querySelectorAll('[data-task-id]')].find(n=>n.dataset.taskId===focusId);target?.focus({preventScroll:true});}
  const diagnostics=byId('task-diagnostics');diagnostics.replaceChildren();
  if(states.tasks?.snapshot?.truncated)diagnostics.append(node('p','返回不完整 · truncated','warning'));
  for(const id of states.tasks?.snapshot?.degraded??[])diagnostics.append(node('p','任务数据不可读 · '+id,'warning'));
  if(selectedBucket==='unmapped')diagnostics.append(node('p','源状态未匹配本页显示桶；保留原始 status。','warning'));
  pumpUsage();
}
function trClass(t){return t.task_id===selectedTask()?'sel':'';}
function pumpUsage() {
  if(suspended||rootChanged||states.tasks?.error)return;
  // Never-read rows precede refreshes; the oldest dispatch wins thereafter.
  // A sequence (rather than wall time) also makes same-tick completions fair.
  const visible=taskList().filter(t=>bucket(t)===selectedBucket&&LATE.has(t.status))
    .sort((a,b)=>(usage.get(a.task_id)?.order??0)-(usage.get(b.task_id)?.order??0));
  for(const t of visible) {
    if(usageJobs>=2)break;
    const old=usage.get(t.task_id),key=usageKey(t);
    if(old?.loading||(old?.key===key&&old.retryAt>Date.now()))continue;
    const entry={key,order:++usageOrder,text:old?.text??'读取中…',loading:true,controller:new AbortController()};usage.set(t.task_id,entry);usageJobs++;
    readJSON('/tasks/'+encodeURIComponent(t.task_id)+'/usage',entry.controller).then(data=>{entry.text=tokenTotal(data);entry.retryAt=Date.now()+5000;}).catch(error=>{
      entry.error=error.message;entry.text=error.status===404?'unknown · no usage':'unknown · '+error.message;entry.retryAt=Date.now()+10000;
    }).finally(()=>{entry.loading=false;usageJobs--;if(!suspended&&!rootChanged){renderTable();}});
  }
}
function panelWarning(message) {byId('panel-warning').hidden=!message;byId('panel-warning').textContent=message??'';}
function stopDetail() {
  if(!detail)return;
  detail.stopped=true;clearTimeout(detail.timer);detail.controller?.abort();
}
function clearDetail() {
  stopDetail();detail=null;
  byId('r-empty').hidden=false;byId('r-view').hidden=true;byId('r-view').replaceChildren();
  panelWarning('');byId('r-cap').textContent='LIVE VIEW · click a task row';
}
function syncDetail() {
  if(rootChanged||suspended)return;
  const id=selectedTask(),t=currentTask();
  if(!id){clearDetail();return;}
  if(!t){stopDetail();detail=null;byId('r-view').hidden=true;byId('r-empty').hidden=false;panelWarning(states.tasks?.snapshot?'任务未出现在当前 /state 快照 · '+id:'正在读取任务…');return;}
  const live=LIVE.has(t.status),run=live?latestRun(id,runList()):null;
  const key=id+'|'+(live?'live|'+(run?.run_id??'none'):'records');
  byId('r-cap').textContent=(live?'LIVE VIEW':'RECORDS')+' · '+t.title;
  if(detail?.key!==key||detail?.stopped){
    stopDetail();detail={key,id,live,run,stopped:false,version:null,cursor:0,decoder:new TextDecoder(),buffer:'',follow:true,lastWrite:null,baseline:true,lines:[],failures:0};
    const host=byId('r-view');host.replaceChildren();byId('r-empty').hidden=true;host.hidden=false;panelWarning('');
    if(live)mountTerminal(detail);else{const pane=node('div',undefined,'recspane');host.append(pane);detail.pane=pane;}
  }
  if(live){
    detail.run=run;
    if(detail.commandTitle)detail.commandTitle.textContent=run?commandSummary(run.argv_summary).text:'unknown · no run';
    if(detail.pidLabel)detail.pidLabel.textContent=run?'PID '+(run.pid??'unknown')+' · '+(run.status??'unknown')+(run.pid_alive===false?' · PID missing':''):'';
    if(!run||!run.log_available){panelWarning(run?'日志不可用':'暂无关联 run，等待 /runs');return;}
    if(!detail.busy&&!detail.timer&&!detail.halted)pollLog(detail);
  } else {
    if(!detail.busy&&(detail.version!==t.version||detail.retryAt<=Date.now()))pollRecords(detail,t);
    else if(detail.data)renderRecords(detail,t);
  }
}
function mountTerminal(d) {
  const term=node('div',undefined,'term'),bar=node('div',undefined,'tbar');
  const commandTitle=node('span',d.run?commandSummary(d.run.argv_summary).text:'unknown · no run','ttitle');
  bar.append(node('span',undefined,'tdot r'),node('span',undefined,'tdot'),node('span',undefined,'tdot'),commandTitle);
  const follow=node('button','Following');follow.type='button';follow.addEventListener('click',()=>{d.follow=true;d.terminal.scrollTop=d.terminal.scrollHeight;updateLogFoot(d);});
  const reload=node('button','Reload log');reload.type='button';reload.addEventListener('click',()=>{stopDetail();detail=null;syncDetail();});bar.append(reload);
  const pidLabel=node('span',d.run?'PID '+(d.run.pid??'unknown')+' · '+(d.run.status??'unknown'):'','tpid');bar.append(follow,pidLabel);
  const terminal=node('div',undefined,'tbody log-lines');terminal.tabIndex=0;terminal.setAttribute('aria-label','运行日志');
  terminal.addEventListener('scroll',()=>{d.follow=terminal.scrollTop+terminal.clientHeight>=terminal.scrollHeight-4;updateLogFoot(d);});
  const foot=node('div',undefined,'tfoot');term.append(bar,terminal,foot);byId('r-view').append(term);Object.assign(d,{terminal,foot,followButton:follow,pidLabel,commandTitle});updateLogFoot(d);
}
function updateLogFoot(d) {
  if(!d.foot)return;
  d.followButton.textContent=d.follow?'Following':'Paused · follow tail';
  d.foot.textContent=(d.lastWrite===null?'last write unknown':'last write '+Math.max(0,Math.floor((Date.now()-d.lastWrite)/1000))+'s ago')+' · 本页观察新增字节，无 heartbeat · '+(d.follow?'following':'scroll paused')+' · '+d.cursor+' bytes'+(d.trimmed?' · 有限窗口，较早行已省略':'');
}
function appendLog(d,text,eof) {
  d.buffer+=text;
  const lines=d.buffer.split('\n');d.buffer=lines.pop()??'';
  for(const raw of lines){const item=humanizeLogLine(raw);if(item)d.lines.push(item.label+'  '+item.text);}
  // Show an unfinished plain stdout line, but never a half JSON event.
  const pending=d.buffer&&!looksLikeProtocol(d.buffer)?oneLineText(d.buffer,1000):'';
  if(d.buffer.length>131072){d.buffer='';d.lines.push('片段  超长协议记录已省略');}
  if(d.lines.length>1000){d.lines=d.lines.slice(-1000);d.trimmed=true;}
  const top=d.terminal.scrollTop;
  d.terminal.replaceChildren(...d.lines.map(line=>node('p',line,'ln'+(line.startsWith('工具')?' cyan':line.startsWith('思考')?' dim':line.startsWith('消息')?' g':''))),...(pending?[node('p',pending,'ln dim')]:[]));
  if(!d.lines.length&&!pending)d.terminal.append(node('p',eof?'等待日志输出…':'读取日志…','ln dim'));
  d.terminal.scrollTop=d.follow?d.terminal.scrollHeight:top;
}
async function pollLog(d) {
  if(d.stopped||suspended||rootChanged)return;
  d.timer=null;d.busy=true;d.controller=new AbortController();let delay=1000;
  try {
    const chunk=await readJSON('/runs/'+encodeURIComponent(d.run.run_id)+'/log?from='+d.cursor+'&limit=65536',d.controller);
    if(d.stopped)return;
    if(chunk.run_id!==d.run.run_id||chunk.from!==d.cursor||!Number.isSafeInteger(chunk.next)||chunk.next<chunk.from||!Number.isSafeInteger(chunk.size)||chunk.next>chunk.size||typeof chunk.eof!=='boolean'||chunk.eof!==(chunk.next===chunk.size)||chunk.encoding!=='base64'||typeof chunk.data!=='string')throw Error('日志响应结构无效');
    const bytes=Uint8Array.from(atob(chunk.data),c=>c.charCodeAt(0));
    if(bytes.length!==chunk.next-chunk.from||bytes.length>65536)throw Error('日志字节范围无效');
    if(!d.baseline&&bytes.length)d.lastWrite=Date.now();
    d.cursor=chunk.next;appendLog(d,d.decoder.decode(bytes,{stream:true}),chunk.eof);
    if(chunk.eof)d.baseline=false;
    d.failures=0;panelWarning('');updateLogFoot(d);
    if(!chunk.eof)delay=0;
  }catch(error){
    if(d.stopped)return;
    d.failures++;delay=Math.min(10000,1000*2**Math.min(d.failures,4));
    panelWarning('日志读取失败 · '+error.message+' · 保留游标 '+d.cursor+(error.status===416||error.status===409?'；请重新选择任务以明确重读':''));
    if(error.status===416||error.status===409){d.halted=true;return;}
  }finally{d.busy=false;}
  if(!d.stopped&&!d.halted)d.timer=setTimeout(()=>pollLog(d),delay);
}
async function pollRecords(d,t) {
  d.busy=true;d.controller=new AbortController();const version=t.version;
  try{
    const data=await readJSON('/tasks/'+encodeURIComponent(d.id)+'/versions',d.controller);
    if(d.stopped)return;
    if(data.task_id!==d.id||!Array.isArray(data.versions)||!data.versions.every(r=>r&&Number.isInteger(r.version)&&r.payload&&typeof r.payload.summary==='string'))throw Error('记录响应结构无效');
    if(Number.isInteger(version)&&data.versions.reduce((max,r)=>Math.max(max,r.version),0)!==version)throw Error('记录与 /state 版本同步中');
    d.data=data;d.version=version;d.retryAt=Infinity;panelWarning('');renderRecords(d,currentTask()??t);
  }catch(error){if(!d.stopped){d.retryAt=Date.now()+10000;panelWarning('记录读取失败 · '+error.message+(d.data?' · 数据已过期，保留最近快照':''));}}
  finally{d.busy=false;}
}
function renderRecords(d,t) {
  const top=d.pane.scrollTop,focus=d.pane.contains(document.activeElement)?document.activeElement.dataset.recordVersion:null;
  d.pane.replaceChildren();
  const records=d.data.versions.slice().sort((a,b)=>b.version-a.version);
  d.pane.append(node('div','RECORDS · '+records.length+' entries · newest first','lcap'));
  records.forEach((r,index)=>{
    const item=node('div',undefined,'ritem'+(d.open===r.version?' open':'')),button=node('button',undefined,'rec'+(index===0&&t.waiting_for==='human'?' hi':''));button.type='button';button.dataset.recordVersion=String(r.version);button.setAttribute('aria-expanded',String(d.open===r.version));
    const summary=node('span',r.payload.summary,'rs');summary.append(node('small',(r.role??'unknown')+' · '+(r.timestamp??'unknown')));
    button.append(node('span','v'+r.version,'rv'),node('span',r.content_type??'unknown','rt'),summary);
    const payload=node('div',undefined,'rdetail');payload.hidden=d.open!==r.version;
    for(const [key,value] of Object.entries(r.payload)){
      const field=node('div',undefined,'rfield');
      field.append(node('div',key,'rlabel'),node('pre',typeof value==='string'?value:JSON.stringify(value,null,2),'rvalue'));
      payload.append(field);
    }
    button.addEventListener('click',()=>{d.open=d.open===r.version?null:r.version;renderRecords(d,currentTask()??t);});item.append(button,payload);d.pane.append(item);
  });
  if(!records.length)d.pane.append(node('p','零记录','empty'));
  d.pane.scrollTop=top;
  if(focus)[...d.pane.querySelectorAll('[data-record-version]')].find(n=>n.dataset.recordVersion===focus)?.focus({preventScroll:true});
}
function renderStatus() {
  for(const kind of ['tasks','runs']){
    const s=states[kind],stale=!!s?.error||rootChanged;
    byId(kind+'-connection').hidden=!stale;
    byId(kind+'-connection').textContent=stale?'断连 / 读取失败 · '+(rootChanged?'Hub 归属已变化':s.error)+' · 最近成功 '+(s?.lastSuccess?new Date(s.lastSuccess).toLocaleTimeString():'尚未成功'):'';
    byId(kind+'-stale').hidden=!stale||!s?.snapshot;
  }
  byId('live-meta').textContent=(rootChanged||suspended||states.tasks?.error||states.runs?.error?'快照可能已过期':'实时 · 每 5 秒刷新')+' · '+['tasks','runs'].map(k=>k+' 最近成功 '+(states[k]?.lastSuccess?new Date(states[k].lastSuccess).toLocaleTimeString():'尚未成功')).join(' · ');
}
function startBoardPolling() {
  if(pollers.length)return;
  loadWorkspaces();
  for(const [kind,url] of [['tasks','/state?include=closed'],['runs','/runs']])pollers.push(createPoller(url,kind,acceptRoot,state=>{
    states[kind]=state;
    renderStatus();renderTable();syncDetail();
  },fetch,states[kind]));
}
function tick(){
  if(suspended||rootChanged)return;
  for(const n of document.querySelectorAll('[data-updated-at]'))n.textContent=age(n.dataset.updatedAt);
  for(const n of document.querySelectorAll('[data-pending-since]')){
    n.textContent='awaiting approval · '+age(n.dataset.pendingSince);n.setAttribute('title',n.textContent);
  }
  if(detail&&!detail.stopped){updateLogFoot(detail);if(!detail.live&&detail.retryAt<=Date.now())syncDetail();}
  pumpUsage();tickTimer=setTimeout(tick,1000);
}
window.addEventListener('hashchange',()=>{syncDetail();renderTable();});
window.addEventListener('pagehide',()=>{
  if(suspended)return;suspended=true;workspaceController?.abort();clearTimeout(tickTimer);for(const p of pollers.splice(0))p.stop();stopDetail();for(const u of usage.values())u.controller?.abort();renderStatus();
});
window.addEventListener('pageshow',event=>{if(event.persisted&&suspended){suspended=false;startBoardPolling();tick();}});
renderRail();startBoardPolling();tick();
`;
