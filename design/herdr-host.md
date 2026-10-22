# Herdr 宿主

本文实现 [宿主契约](system-design.md#7-宿主契约)。

## 1. 部署与电源

Herdr 管理同一窗口中的 Agent pane，sidebar 显示运行状态。状态检测由 screen manifest 规则与 Agent lifecycle hooks 提供；只有屏幕规则时 blocked 可能漏判。`tut up` 供给本 rig 的 Hub / Notifier 系统 pane，Notifier 的 stdout 为运行日志；任务 pane 在轮次交接时按需创建。

根定位与 Hub 身份发现见 [共享宿主契约](system-design.md#72-冻结计划与路由)。

需要供给时从 3001/3002、3003/3004 起选择首对空闲端口；显式 --event-port 保留指定值。端口预检不提供预留，绑定失败或启动后身份不符可见失败，不写端口配置文件。选端口后、供给前再次发现同根 Hub，能复用时记录归属并重新解析 Notifier 端口。

Herdr 电源仅缺省非 dry-run up 参与同根启动互斥，显式 --url 与 dry-run 不加锁。

up 收尾重读 pane 列表，验证本 rig 系统与任务标签唯一；重复时列标签与 ID 并非零退出，不自动清理，listing 失败也失败。新建 tut-sys 时 HERDR_PANE_ID 缺失或 workspace 不可解析会提示锚定降级；输出期望 `tut-host-<rig>` 标签供 host_pane_label 配置。doctor 以系统 pane 标签后缀与根 cwd 检查 rigHash 碰撞，任务 worktree cwd 不作根证据，Herdr 不可用注明无法扫描。

系统命令显式携带 TUT_HUB_ROOT / TUT_HUB_URL / TUT_EVENT_PORT_URL；pane run 通过 renderer 注入，fallback split 同时用 Herdr --env。run 没有独立 env 旗标，不假定 Herdr 服务端继承启动者环境。

## 2. pane 生命周期与 rig 映射

### 2.1 标签与隔离

rig 为规范 Hub 绝对根路径的 SHA-256 前八位，routingRoot 与任务 worktree 不改变它。系统标签为 `tut-hub-<rig>` / `tut-notify-<rig>`，任务标签为 `<task_id>.<role>-<rig>`；下文 `<T>.<role>` / `<T>.*` 均为逻辑简写，所有寻址、复用、fresh、收割与 sweep 限本 rig。

pane label 是机器寻址键，不可模板化；task_id 不含点，第一个点是 task / role 分隔。tab 名不参与事件反查。无标签 pane 属人，任何自动机制不得触碰。

Herdr 的人读 tab 标签由 `naming.tab_label` 模板渲染，支持 `{role}` / `{task}` / `{agent}`，未知占位符原样保留；模板按项目 workspace → 用户 workspace → 默认 `TUT {role}` 回退。naming 与 route 在同一快照中解析并随计划冻结，child 不重读配置；系统 tab 为 tut-sys。

锚点优先本 rig 带 rig 后缀的系统标签，有标签但缺 workspace_id / cwd 等元数据则拒绝。完全没有带 rig 后缀的系统标签时，可使用无 rig 后缀的系统锚点链；两种标签并存时，无后缀系统标签仅在目标根下有效。无 rig 后缀的任务 pane 不由自动生命周期接管，由人处置。带其他 rig 后缀的事件忽略。

### 2.2 轮次交接

跨角色必须新 pane / session，同任务同角色连续轮可延续。活 pane 的 agent_status 为 idle / working / blocked / done，缺失或 unknown 视为死；done 表示回合结束但 TUI 仍可接收提示。TUT_CONTINUITY_ROLES 默认 executor reviewer，空格分隔可覆盖，空串关闭延续。

| 分支 | 行为 |
|---|---|
| 同角色延续 | 精确目标活 pane 且角色在延续集合时，只投递，不收割、不新生；首次状态可分类即放行，working 不等 idle |
| 新生 | 首轮、角色改变或目标已死时，收割 `<T>.*` 中非 working 且非受延续保护的活 pane；working 跳过并警告，死 pane 不受保护；收割后目标标签仍有活 pane 则拒绝新生 |
| --fresh | 人显式要求外部视角时，force-close 该任务该角色全部 pane（含 working），再走新生；与 --force 去重旁路独立 |

同任务中途显式换 agent 后，要用 fresh 避免把新 route 投入旧会话。自动发车不传 fresh。approve 不收 pane，任务进入 closed 才无条件 cleanup `<T>.*`。

close 清理由 CLI decide 的同步沿和 Notifier 观测转变沿共同触发 `launch --cleanup <T>`，幂等，双沿至多多一次空跑。首个快照已 closed 不补清理；失败只 stderr 一行，不发通知、不写记录、不影响 close。放弃但未 close 的孤儿 pane 不自动回收；裸名 agent pane 由人处置。

## 3. pane 发车链

### 3.1 计划、探测与 birth

主实现为 src/herdr/launcher，通过 `node dist/cli.js launch [--fresh] <task_id> <role> [<agent> [<arg>...]]` 进入；scripts/launch.sh 是仅转发同包入口的 POSIX shim。canonical 计划臂与位置参数兼容臂均冻结 LaunchInvocation，child 消费私有完整计划。位置参数 tut launch / scripts/launch.sh 路径使用 via=legacy，不追加 Hub launch marker。

ExecutionContext 一次解析并复用 anchor / hubRoot / routingRoot / checkoutRoot；anchor 是终端锚点，其余根按共享契约。shell 方言依次取 pane 元数据、TUT_PANE_SHELL、平台默认（Windows powershell5，其余 posix），未知方言在 birth 前拒绝。控制面 raw argv、shell:false；pane 内单串用 POSIX sq、PS5 / pwsh 保守 script block 加隔离 env，或 cmd 安全词 / base64url runner 渲染。

birth 锚点依次为本 rig tut-hub、tut-notify、TUT_SPLIT_BASE，最后失败；只有快照完全无系统 pane 才咨询 split-base，有但不可锚不得回退。dry-run 可输出占位符，绝不猜首个或聚焦 pane。

可执行预检只探 route.agent 首词。POSIX 用 which，which 自身 ENOENT 单独提示安装；Windows 用 Node PATH + PATHEXT 枚举，PATH 缺失才 fallback where.exe。PE native / Node entry 可直 spawn，cmd / bat / ps1 / sh shim 在 spawn 前拒绝并给指引。

探测预算 TUT_PROBE_TIMEOUT_MS 默认 8s，覆盖子进程、stat 和 extensionless PE 头事实；Windows PATH walk 独立 TUT_PROBE_WALK_TIMEOUT_MS 默认 24s。两者范围 250ms–60s，非法值回缺省。生产事实收集在可杀子进程中按候选 NDJSON 流式输出；超时保留已收事实，挂住候选及同目录后续标不可用，从下一目录续探，得到 definitive 结果即停止扫描，不让死 UNC 占住主进程线程池。

探测通过后按序 tab create → 双通道发现根 pane → rename 精确寻址键 → pane run。route 与 naming 使用同一快照，child 不重读；codex 在用户 args 后追加 `-c check_for_update_on_startup=false`，pi 通过一次性 env 禁自更新，TUT_SUPPRESS_AGENT_UPDATE=0 关闭该策略，未知命令参数原样保留。

tab create 返回成功但不可解析时，用 tab-list 恢复，仅收养单空根 pane 且 tab 中无该任务活标签的唯一候选；歧义拒绝，signal 中断视为可能已生效，禁止盲建第二个。fallback split / move / sweep 有界重试。

两臂规划时均读取 `/state` 的 checkout / cast，冻结实际执行根；位置参数臂在网络失败、非成功 HTTP 或坏 JSON 时 stderr 说明 URL / 原因并可见回落 current / default。HTTP 200 而目标不在 tasks 中，任何 Herdr mutation 前拒绝，不将不存在解释为缺省。

TUT_HERDR_EXECUTABLE 覆盖 Herdr 可执行路径；未设或空时 Windows 用 herdr.exe，其余 herdr。Herdr 短命令默认约 10s（TUT_HERDR_TIMEOUT_MS），编排子进程默认 180s，内部总期限 170s；超时 SIGKILL 后走明确失败 / 人工检查，不无限挂起。读屏失败可见降空串，状态不可用不解释为成功；落痕后的编排超时产生 autoLaunchFailed。

### 3.2 单次投递

born 与 continuation 共用单一路径，pane 命令直接启动 Agent；保留原方言、环境与生命周期规则。原 prompt 最多 send-text 一次，不变换正文；无屏幕就绪门、落框匹配、nonce 或旁路 shell 探针。

1. 冻结目标精确 pane 身份与本地 attemptId，使用单调时钟。发送前检查取消和总预算；初始预算不足或 send-text 能证明文本未派出时返回 not-sent / exit 1，仍须 inspect-first，不授权自动重试。

2. 发送文本前读取 `herdr pane list` 基线；使用单一 `TUT_BASELINE_READY_TIMEOUT_MS`（缺省 90000ms，正安全整数；非法值回落并提示 stderr）预算，从首次探测前起算，受 planning/birth 前起算的 170s 总 deadline 裁剪。unknown（含暂时读错误）与 born-working 等待共用此 deadline，不因状态变化重置。

   等待期间零 send-text、零 Enter；迟到/错序/取消样本不得放行，精确 ID 缺失/重复、身份改变立即停止。

   - continuation：首次有效 idle/blocked/done/working 即锁定基线，working 不等待。

   - born 尚未见有效 working：idle/blocked/done 保留立即放行；unknown/暂时错误继续等待。

   - born 首次有效 working 后进入 settling：working/unknown/暂时错误/blocked/done 均继续等待，只有有效 idle 正常放行。

   - readiness 耗尽：仅按最后一次探测的实际有效状态回退。working 单发单按后 baseline-working；blocked/done 按真实非 working 基线单次投递并观察；unknown、读错误、迟到或错序末样本走 baseline-unknown，零输入，绝不回捞旧 working。

     超时回退不称作 ready。

     取消/身份守卫和总 deadline 优先，投递预留不足仍零输入走 deadline（入口预算不足仍 delivery-budget-unavailable）。

   锁定基线且预算允许后依次 send-text → Enter；文本 uncertain 立即升级、零 Enter。Codex 路由在 text 明确 sent 后等待 250ms，再提交 Enter，避免连续普通字符输入触发 TUI 粘贴保护；该间隔计入既有 flip/总预算，预算不足或取消时零 Enter、禁止重发文本。

其它 agent 不加间隔；间隔是输入节奏控制，不是消费确认。

3. 目标合法时最多一次显式 Enter。Enter 的 not-sent/uncertain 均不补按；正常传输后，基线 working 仍直接 baseline-working 报告未确认，不等待、不观察翻转。已知非 working 基线才进入有界观察。

4. `TUT_STATUS_FLIP_TIMEOUT_MS` 为非 working 基线最终放行时起算的观察预算（正常 idle 或超时 blocked/done 回退，覆盖 send-text、Enter 与后续观察，unknown 与 born settling 等待不占此预算），默认 30000ms，范围 1–60000。

   working 分支不包含 send-text：Codex 在 text 明确 sent 后、250ms 输入等待之前起算，等待与 Enter 共用该冻结期限；其它 agent 在 Enter 调用前起算。输入等待耗尽 flip 预算则零 Enter，以 deadline 结束，不重新起算。

   `TUT_STATUS_POLL_MS` 默认 min（250ms，flip 预算），范围 1–flip 预算。逐次查询携带 sequence、起止单调时间、身份与错误；迟到/取消/错序样本不能改变已接受结果。

   每次 v2 控制调用独立受 C ≤ 10000ms 硬顶约束（配置可缩短），并裁剪到剩余 deadline；flip 窗口可由多次 ≤C 调用及 sleep 组成，不把整段窗口授予一个调用。

5. 当前 adapter 的 attribution 固定 unavailable，detector source/age、server epoch、agent generation 不可得时为 null。即便看到非 working→working，也只能记录 working-observed 与 attribution-unavailable，**不能证明本轮输入已消费**，不会生成 submit-confirmed。超时、身份错误、状态不可用、取消均诚实升级；无第二次文本/Enter，不自动重投或另建 pane。

6. 就绪等待未放行也经原 give-up 通道返回 unconfirmed / exit 0 / retry forbidden，保持人工检查入口。文本可能已派出即 unconfirmed / exit 0 / retry forbidden；exit 0 仅表示这次尝试已处理，不是提交确认。终态先冻结，再 best-effort POST `delivery_giveup`（2s）并有界 flush。

   冻结三字段 `{event, agent, pane}` 上可携带 `delivery_v2`，包括原因、状态、传输、计数与预算；有效 v2 优先，坏加法字段整体丢弃，box/transport/probe 字段只作兼容解析，不授予提交许可。

就绪等待期间 launcher 仍占用本轮启动调用。冷启动较慢时可提高 `TUT_BASELINE_READY_TIMEOUT_MS`，希望更早交人工时可缩短；增大旋钮不扩大 170s launcher 总期限，也不改变独立的 flip 预算。非法配置提示不受诊断开关影响。

证据保持 schema=2，既有事件仍可解析；实际进入基线就绪等待（unknown 或 born-working）时携带可选 `baseline_wait: {budget_ms, elapsed_ms}`（离开等待阶段即冻结耗时，不含 flip 窗口）；status_before 为最终真实基线，投递前 working→idle 不计 status_flip。未投递组合 `text_calls=0 / text_transport=not-sent / text_error=null / enter_calls=0 / elapsed_ms=null` 如实表示就绪门未放行，仅用于 baseline-unknown、identity-invalid、cancelled 或 deadline；

既有已发送证据字段含义不变，未投递证据绝不授权补救 Enter。

统一人工指引：投递未确认，请检查目标 pane；仅当目标仍是预期 Agent、提示仍在输入框且没有尚待完成的控制调用时，人工按一次 Enter；输入框已空或工作已开始时先核查本轮，禁止盲按与自动重投。杀掉本地 CLI 不撤销服务端可能迟执行的动作。

就绪等待只在进入等待、正常放行或耗尽时输出 baseline-wait-start/baseline-ready/baseline-wait-exhausted，注明 branch、触发状态以及耗尽时实际状态和回退动作；不逐拍输出等待轮询行。其余诊断相位为 status-before/send-text/input-settle/enter/status-observed/working-observed/give-up；stderr、事件与 delivery.log 来自同一终态证据，不写 prompt 或完整屏幕。

`TUT_DELIVERY_DIAG=0` 只关闭诊断，故障/flush 超时不改投递结果。

`.context-hub/delivery.log` 保持 5MiB + 一代 `.1` 轮转。状态观察不等于可靠自动确认。

### 3.3 受控 Enter

Notifier 消费 delivery_giveup 后通过最小 `Remediator.remediate(request)` 接口调用策略；内置 enter-repress。`auto.remediate = off | enter-repress` 可由 `tut config set` 配置；未配置时 auto 开启、manual 关闭。

off 不执行任何补救调用、不新增补救日志，launcher 不附加补救证据，沿用原升级路径。

补救开启时 delivery_v2 携带冻结目标 `target` 和 `prompt_tail`（规范化尾部最多 80 字符的 SHA-256 与长度，不落正文），常规补救不要求 prompt_tail 存在或有效；下述历史 working 重评额外要求该字段有效；缺少 target 的旧证据仍可解析但不足以补救。

三门全过才代按：

1. 精确 pane_id 匹配、当前 pane 唯一存在且 label 与事件 pane 一致。target.agentSession 非空时保持预期 agent 与 session 的 agent/kind/value 强绑定校验，只有显式 null 时允许无 session 绑定。当前 herdr 接口不暴露 session，绑定按 pane 归属 + 角色标签 + 可分类状态（agent_status 非 unknown），仍须通过下述非 working 状态门。

2. 投递证据 `text_transport=sent` 即视为 prompt 已送达（staged），uncertain / not-sent 拒绝；常规路径不读取 pane 缓冲验证尾部，屏幕只作诊断；历史 working 重评路径额外要求当前输入框尾部匹配（见下）。

3. 原证据为已知非 working 基线、无翻转、无错误、text/Enter 均明确 sent、reason=deadline，并在补救前再次读取非 working 状态。

无翻转仅是操作授权判据，不声称证明输入未消费；uncertain/缺证据一律升级人工。读取失败或身份改变也拒绝按键。 对 reason=baseline-unknown 且 status_before=unknown 的证据，原基线的暂时读取错误不妨碍等待，但身份错误仍拒绝；

保留其余传输与完整性检查，先用单调时钟按同一 `TUT_BASELINE_READY_TIMEOUT_MS` 旋钮有界等待（缺省 90s），直到状态首次可分类；等待期间不按键、不重发文本，身份丢失/改变或生命周期失效立即停止。

可分类后重新核验上述身份、文本传输证据与当前非 working 状态三门；仍 unknown 至上限则零按键升级人工。就绪等待独立于代按后的 flip 观察预算，原始证据不改写。等待期每次轮询后及代按前通过 /state 重读任务与补救开关；

只允许 waiting_for 仍为本角色且派生状态仍等于事件时的在役轮次状态，无关 note 引起的 version 增长不终止等待。

角色/状态变化、needs_attention、降级/缺失任务、读取失败或开关关闭均停止本次补救，停止后不恢复。

working 重评：原证据为 `reason=attribution-unavailable`、已知非 working 基线、`status_flip=true/status_last=working` 且读/传输无错误时，历史 working 仍保留，不作消费证明。首次保守拒绝以 action=none 追加审计后，同一调用内开启一次有界重评（共用 readyMs，默认 90s），不要求第二个事件。仅 Codex 可进入此路径：当前身份/label/生命周期有效，连续至少三次有效 idle 样本且跨度至少 2s，当前可见屏幕最后一个 `›` 输入框的规范化尾部与原 prompt_tail 严格匹配，且候选输入与已识别底栏之间不存在回答正文，才放行；屏幕仅在此路径作为额外保守条件，不能单独授权。

working/unknown/读失败打断稳定窗口，身份错误或生命周期失效立即终止；超时零按键升级人工。重新核验输入框、label、idle 和生命周期后才能追加按键意图；意图持久化后再读 idle，工作中状态不按。

agentSession=null 不构成假 working 或未消费证明。

重评仍占用同一 attempt/pane 去重锁，最多一次机器 Enter，绝不重发文本；按键后失败不再次补按。审计标记 `reevaluated=true` 与 `staged_basis=codex-input-tail`，原 delivery_v2 证据不改写。 重评耗尽沿用现有 `reason` 字段：从未达成 idle 稳定窗为 `reevaluation-deadline: stable-window-not-reached`；

曾达成稳定窗但输入尾部从未匹配为 `reevaluation-deadline: input-tail-not-matched`（后续 idle 中断不抹去已到达该门的事实）；尾部匹配但读取返回时已耗尽预算保留 `reevaluation-deadline`。

此区分仅用于审计，不改变等待预算与按键门。
按 attempt_id 去重并串行保护 pane；先占用再 await，按键前追加动作意图，完成后追加结果，至多一次 sendEnter，绝不重发文本。复用第 3.2 节的预算旋钮、状态读取与时序校验规则观察到 working 时追加 `remediation` 证据（策略、动作、Enter 结果、状态翻转、机器补救归因）；可选字段 `staged_basis=text-transport-sent` 记录 gate ② 的授权依据，保留原 attribution 与 submit_confirmed 不变，归因表示机器代按后观察到翻转，不提升为因果提交证明。

未翻转/控制错误追加二次 give-up 并走人工升级，不递归。原日志不覆写。去重为 notifier 进程生命周期内有效；事件无持久重放机制，重启不重放补救。

补救动作/结果属于审计材料，不受 `TUT_DELIVERY_DIAG` 控制：即使该值为 0，仍输出 stderr 并尽力追加 delivery.log；持久 sink 失败不吞 stderr，诊断开关仅控制普通投递诊断。策略异常保留错误消息于 reason 并输出 stderr。观察窗内暂时读失败、未知/迟到/错序样本不判失败，继续到投递 deadline；

身份丢失/改变仍立即停止。

有合法 working 末样本时，优先按机器补救归因，即使同期任务已前进。

去重账本最多保留 4096 个 attempt，满额后新 attempt 升级人工，不淘汰旧 ID（避免重复按键）；同时活动 pane 最多 64 个，结束即释放。`auto.*` 是配置分组名，不表示所有子键都只在 auto 模式有效：`launch_roles` 只约束自动启动，显式 `auto.remediate=enter-repress` 对 manual 也有效；仅缺省值随模式切换。

非法 remediate 值保守回落 off 并在 stderr 提示。

## 4. hook 信号线与通知接线

### 4.1 事件生产与反查

事件字段与 HTTP 行为见 [共享事件契约](system-design.md#73-辅助事件接口)。

Herdr 插件订阅 pane.agent_status_changed，将完整 UTF-8 JSON 写入 herdr-hook.mjs 的 stdin，command array 不携带 JSON。空 / 坏 payload / 缺字段记 stderr 后退出 0，避免重试风暴。working / blocked / done 直通，idle 仅在前态 working 时映射 done；每次合法 status 更新前态。

hook 用 raw argv 的 herdr pane get 把 pane_id 解析为标签，失败不把 ID 猜成标签。前态按 pane_id SHA-256 存于 HERDR_PLUGIN_STATE_DIR，缺省 os.tmpdir()/tut-herdr-state，temp + rename 更新。随后用 process.execPath spawn 同包 on-agent-event.mjs，传 event / agent / pane 三个 raw 值并继承事件 URL；on-agent-event.sh / hook.sh 仅供 POSIX 转发，Windows 不执行 shim。

canonical 入口校验参数，用 JSON.stringify 构造 body，fetch + AbortController 2 秒超时。网络失败 / 超时 / 非成功状态 best-effort 退出 0，调用契约非法退出 1。hook 只产生三个状态事件，delivery_giveup 由启动器直接经同一接口发送。

反查先取精确任务角色标签的 task 前缀并限定 rig；未命中才按标签的 agent 身份匹配当前等待该 role 且 route 到该 agent 的任务，多项取 updated_at 最新。agent 名与 task_id 撞名时 task 直查优先。无匹配如实降级，blocked 仍告警，done 仍立即 compare；早到 working 触发 compare 后重做前缀反查。

auto 启动成功先通知 launch succeeded 并开始 working 短引信；同任务 / 轮次首个匹配 working 通知 agent working、熄灭引信并续期 stall。无在役 watch 的 working、旧 role / pane、blocked、give-up 不续期；in-flight 早到 working 可匹配。引信到期告警人工介入。

### 4.2 放弃、归档与 Host 转送

delivery_giveup 经 task 标签反查立即告警，有效 delivery_v2 优先解释原因；无有效证据 reason=unknown。通知按 task / pane / agent / attempt 进程内去重，无 v2 则按任务版本；版本前进可再提醒。give-up 不续期 stall，若命中 working 短引信则解除，避免重复告警；受控 Enter 规则见 3.3。

done 在任何异步读 mode 前同步登记 per-task sweep barrier；只有 launch_mode=tui 才列本 rig `<T>.*` pane，逐个读取 visible 尾部 40 行写通知日志，每行带时间和标签。headless 或不可读 / 非法 mode 记录 skip，不调用 Herdr；缺配置 / 缺键按 tui。成功、skip、失败均释放 barrier，下一轮 marker / spawn 等它落定；归档 best-effort，done 的即时 compare 与延迟复查仍执行。

Host 状态转送复用 pending_approval 进入沿与 needs_attention 上升沿，各沿仅尝试一次 pane send-text，同轮可各一条。JSON 只含 task_id / status / waiting_for，status 使用报告沿名，不含标题、指令或授权。目标取 notify.host_pane_label，缺省 / 空取本 rig `tut-host-<rig>`；只在唯一精确匹配时发送，零个 / 多个 / 失败仅日志，不重试、不阻塞比较队列、不持久去重。Host 收到只是知悉信号。

unmatched 事件按 pane + agent 限频，首个正常降级日志与通知；默认 60 秒内后续仅计数，下一事件或到期 timer 聚合事件类型与总数。deadline 从上次输出起算，burst 不顺延，timer 移除自身并淘汰静默条目；只约束 unmatched 日志量，不影响命中任务行为或 blocked / done 即时 compare。

## 5. TUI 协作停止

驱动者经现有 Herdr 按键通道向精确 Codex pane 发 Esc，再核实动作已停且可接新指令。Esc 停止动作，TUI / 会话进程可继续存活；按键投递成功不是停止完成证明，不能仅因 PID 仍活就杀进程。run stop 不提供 pane 寻址。
