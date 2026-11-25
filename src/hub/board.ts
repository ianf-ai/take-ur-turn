import { BOARD_CORE_SCRIPT, BOARD_UI_SCRIPT } from "./board-client.js";

/** Self-contained, read-only Kibitz v2 page. */
export const BOARD_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,"><title>TUT · Kibitz 观棋</title><style>
:root{
  color-scheme:dark;
  --bg:#0b0f14; --panel:#131a22; --card:#1a2330; --line:#232d3a;
  --ink:#e6edf3; --dim:#8b98a5; --faint:#5a6673;
  --run:#3fb950; --wait:#d29922; --bad:#f85149; --info:#58a6ff;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;height:100vh;display:flex;flex-direction:column;overflow:hidden}
header{display:flex;align-items:center;gap:14px;padding:8px 16px;border-bottom:1px solid var(--line)}
header h1{font-size:15px;font-weight:650}
header .g{color:var(--dim);font-size:12px;margin-left:auto}
header h1{flex:none}#workspace-tabs{margin-left:auto;max-width:280px;font:12px ui-monospace,monospace;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:5px;padding:4px 8px}


.main{flex:1;display:grid;grid-template-columns:210px 1fr 46%;min-height:0}

.rail{border-right:1px solid var(--line);overflow-y:auto;padding:12px 10px}
.rail .cap{font-size:11px;color:var(--faint);letter-spacing:1px;margin-bottom:10px}
.snode{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;cursor:pointer;margin-bottom:4px}
.snode:hover{background:var(--card)}
.snode.on{border-color:var(--run);background:#101a15}
.snode .sd{width:8px;height:8px;border-radius:50%;background:var(--faint);flex:none}
.snode.on .sd{background:var(--run)}
.snode .sn{flex:1;font-size:13px}
.snode b{color:var(--dim);font-weight:400;font-size:12px}
.sarrow{text-align:center;color:var(--faint);font-size:11px;padding:1px 0;white-space:nowrap}

.mid{overflow-y:auto}
.mid h2{font-size:11px;font-weight:600;color:var(--dim);letter-spacing:1px;padding:12px 14px 8px;position:sticky;top:0;background:var(--bg);z-index:1}
table{width:100%;border-collapse:collapse}
thead th{font-size:11px;font-weight:600;color:var(--faint);letter-spacing:1px;text-align:left;padding:10px 14px 8px;position:sticky;top:0;background:var(--bg);z-index:1;border-bottom:1px solid var(--line)}
tbody tr{border-bottom:1px solid #161d26;cursor:pointer;font-size:13px}
tbody tr:hover,tbody tr.sel{background:var(--card)}
tbody td{padding:10px 14px;vertical-align:top}
td.dotc{width:20px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%}
.dot.live{animation:pulse 2s infinite}
td.nm{max-width:260px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
td.act{color:var(--dim);font-size:12px;white-space:normal}
td.who{width:150px;color:var(--faint);font-size:12px;white-space:normal}
td.dw{width:52px;text-align:right;color:var(--faint);font-size:12px}
.empty{padding:30px 14px;color:var(--faint);font-size:12px;text-align:center}

.right{display:flex;flex-direction:column;overflow:hidden;background:#060a09;border-left:1px solid var(--line)}
.right .cap{font-size:11px;color:var(--faint);letter-spacing:1px;padding:12px 14px 8px;flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.right .empty{flex:1;display:flex;align-items:center;justify-content:center;text-align:center}
#r-view{flex:1;min-height:0}

.term{background:#04070a;height:100%;display:flex;flex-direction:column}
.tbar{display:flex;gap:6px;align-items:center;background:#111820;padding:6px 12px;border-bottom:1px solid #1c2a24}
.tdot{width:10px;height:10px;border-radius:50%;background:#2a3644}
.tdot.r{background:#f85149}
.ttitle{font:12px ui-monospace,Menlo,monospace;color:var(--dim);margin-left:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tpid{margin-left:auto;font:11px ui-monospace;color:var(--faint);flex:none}
.tbody{flex:1;overflow-y:auto;background:#04070a;font:13px/1.9 ui-monospace,Menlo,monospace;padding:12px 16px}
.tbody .ln{white-space:pre-wrap}
.dim{color:#5f7a6e}
.g{color:#7ee787}
.cyan{color:#56d4dd}
.wait{color:#d29922}
.spin{color:#e3b341;animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.tfoot{font:11px ui-monospace,Menlo,monospace;color:var(--faint);padding:6px 12px;background:#0a0f0d;border-top:1px solid #1c2a24;flex:none}

.recspane{height:100%;overflow-y:auto}
.ritem .rec{cursor:pointer}
.ritem .rec:hover,.ritem.open .rec{background:#0d141b}
.rdetail{display:none;margin:0 14px 10px 54px;padding:8px 12px;background:#080d12;border:1px solid #1a2530;border-radius:6px;font:12px/1.7 ui-monospace,Menlo,monospace;color:var(--dim);white-space:pre-wrap}
.ritem.open .rdetail{display:block}
.lcap{font-size:10px;color:var(--faint);letter-spacing:1px;padding:9px 14px 5px;position:sticky;top:0;background:#060a09;z-index:1}
.rec{display:flex;gap:8px;padding:6px 14px;border-bottom:1px solid #10161d;font-size:12px}
.rec .rv{font:11px ui-monospace;color:var(--info);flex:none;min-width:32px;padding-top:1px}
.rec .rt{color:var(--dim);flex:none;width:86px;font-size:11px;padding-top:2px}
.rec .rs{flex:1;min-width:0}
.rec .rs small{display:block;color:var(--faint);font-size:11px;margin-top:1px}
.rec.hi .rv{color:var(--wait)}
.rec.hi .rs{color:var(--wait)}
.rfield+.rfield{margin-top:12px}.rlabel{color:var(--faint);font-weight:600}.rvalue{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}
.hide{display:none!important}
button{font:inherit;color:inherit;background:none;text-align:left}button,a{cursor:pointer}button:focus-visible,a:focus-visible,tr:focus-visible{outline:2px solid var(--wait);outline-offset:-2px}
.snode{width:100%;color:var(--ink)}.sd,.dot{background:var(--state-color,var(--faint))}.snode .sd{background:var(--state-color,var(--faint))}.snode.on .sd{background:var(--state-color,var(--run))}
.st-designing{--state-color:#56d4dd}.st-implementing{--state-color:#3fb950}.st-reviewing{--state-color:#58a6ff}.st-needs-human{--state-color:#d29922}.st-done{--state-color:#5a6673}
header .g{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#hub-root{font:11px ui-monospace,monospace}.main{grid-template-columns:210px minmax(0,1fr) 46%}
.mid{min-width:0}td.nm{max-width:200px}td.nm a{color:inherit;text-decoration:none}td.nm small{display:block;font-size:10px;font-weight:400;color:var(--faint);overflow:hidden;text-overflow:ellipsis}
.warning{color:var(--wait);font-size:12px;padding:8px 14px}.connection{font-size:11px;color:var(--wait);padding:0 14px}.rec{width:100%;background:none;color:var(--ink);text-align:left;border:0;border-bottom:1px solid #10161d}.ritem.open .rdetail{display:block}.rdetail{overflow-wrap:anywhere}.rec.hi{border-left:2px solid var(--wait)}
.tbody{min-height:0;overflow-wrap:anywhere}.ln{margin:0}.tbar button{margin-left:auto;border:1px solid var(--line);border-radius:4px;padding:2px 8px;font-size:11px}.tfoot{white-space:normal;line-height:1.6}.tpid{margin-left:8px}#r-view{overflow:hidden}.right{min-width:0}footer{flex:none;border-top:1px solid var(--line);padding:7px 16px;font-size:10px;color:var(--faint)}footer p{margin:0}#live-meta{color:var(--dim);margin-bottom:3px}[hidden]{display:none!important}
@media(prefers-reduced-motion:reduce){.dot.live,.spin{animation:none}}
@media(max-width:1100px){.main{grid-template-columns:175px minmax(330px,1fr) 38%}tbody td,thead th{padding-left:9px;padding-right:9px}td.nm{max-width:150px}}
@media(max-width:800px){body{height:auto;min-height:100vh;overflow:auto}.main{grid-template-columns:145px minmax(0,1fr)}.right{grid-column:1/-1;border-top:1px solid var(--line);height:480px}.mid{overflow:auto}header .g{max-width:55%}.rail{padding:10px 6px}.snode{padding:7px 6px}.sn{font-size:12px!important}}
</style></head><body>
<header><h1>TUT Kibitz</h1><select id="workspace-tabs" aria-label="Workspace 切换" hidden></select><span class="g" id="hub-root">正在确认 Hub 归属…</span></header>
<p id="root-warning" class="warning" role="alert" hidden>Hub 归属已变化，请重新载入。保留的快照已过期。</p>
<div class="main">
<nav class="rail" aria-label="任务分桶筛选"><div class="cap">BUCKETS · click to filter</div><div id="state-rail"></div></nav>
<main class="mid"><h2 id="mid-title">TASKS</h2><p id="tasks-connection" class="connection" role="status"></p><p id="runs-connection" class="connection" role="status"></p><p id="tasks-stale" class="warning" hidden>数据已过期 · 以下为最近成功快照</p><p id="runs-stale" class="warning" hidden>运行数据已过期</p><div id="task-diagnostics"></div>
<table aria-label="任务与运行"><thead><tr><th aria-label="状态"></th><th>Task</th><th id="th-activity">Activity</th><th id="th-who">Agent · Model</th><th>Last active</th></tr></thead><tbody id="rows"></tbody></table></main>
<aside class="right" aria-label="任务详情"><div class="cap" id="r-cap">LIVE VIEW · click a task row</div><div id="panel-warning" class="warning" role="status" hidden></div><div id="r-empty" class="empty">Click a task row.<br>In-flight states → live view · late states → records (click an entry to expand).</div><div id="r-view" hidden></div></aside>
</div>
<footer><p id="live-meta">正在读取…</p><p>任务状态与进程观察分别采样，运行退出不代表任务已交付。PID 仅表示本次存在性观察，不能确认进程身份。日志为有限窗口，last write 仅表示本页观察到新增字节，无 heartbeat。停止与审批沿用既有 CLI / 人工流程。</p></footer>
<script>
${BOARD_CORE_SCRIPT}
${BOARD_UI_SCRIPT}</script></body></html>`;
