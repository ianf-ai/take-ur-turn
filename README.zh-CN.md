# TUT — Take Ur Turn

[English](./README.md) | [简体中文](./README.zh-CN.md)

让多个 coding agent（不同模型、不同 CLI 工具）在同一项目中协作：上下文自动共享、流程自动流转、你在对话里指挥全程、人只做关键节点审批。

TUT 是一个跑在本机的多 Agent 协作系统：核心是 **Context Hub**——一个本地 MCP Server，作为 Agent 之间的共享记忆（append-only 任务日志）；任务状态由记录序列经纯函数**派生**；Notifier 轮询状态变化，按 manual / auto 模式驱动「设计 → 实现 → Review → 修改」的流转；人只在审批点拍板。

## 要解决的问题

多 Agent 协作的传统做法是文件中转（design.md / review.md 交接），有三个痛点：

- **上下文靠文件中转**：交接文件只传结论，推理过程和被放弃的方案全部丢失——下一个 Agent 拿到的是「what」，丢掉了「why」
- **流程靠手动驱动**：Review-修改循环通常 2-3 轮，每轮人工触发、手动调 prompt、重新 brief 上下文
- **工具之间隔离**：各 Agent session 互相看不到，没有统一的状态和编排入口

TUT 的答案：把过程记忆放进 Hub（写入永不因流程被拒），把流程状态变成日志的派生视图（不存储、不执法），把「谁按启动键」做成 manual / auto 两档——人是流程的关键门，不是流程的路由器。

## 核心机制

- **Append-only 记录**：Agent 经 5 个 MCP 工具（create / publish / read / list / decide）往任务日志追加记录——design、code_changes、review、revision、note、decision。记录永不删除，任何零参与者凭日志可复原全部决策与理由
- **派生状态**：任务状态（走到哪、该谁动）不存储、不执法，是记录序列经纯函数算出的视图。表外组合（如 solo 流程里发 review）照样落盘，但会置 `needs_attention` 提醒人处置
- **审批门**：review pass 后派生为 `pending_approval`，需要**人**发一条 decision 记录（approve / reject）才继续。close 在任意状态有效——人有权随时终止任务
- **流程变体**：建任务时选 `--flow full|direct|solo`——full 走完整循环；solo 小改动免设计轮与 review（create 即 implementing，直达审批，免审不免批）；direct 面向「简单但触风险面（核心路径/门禁/公开面，错了贵）」的改动——给 solo 加一轮 review
- **manual / auto 流转**：manual（默认）该谁动时通知人，人按键启动下一个；auto 模式 Notifier 经启动器直接拉起下一个 Agent（按 role 白名单分级信任），人只做 decide；无论哪档，都可由 coding-agent Host 会话代你跑全程（见下文会话驱动）

## 架构

```
┌────────────────────────────── 本机 ──────────────────────────────┐
│                                                                  │
│  coding agent ──MCP 读写──► Context Hub ──► 存储（本地 JSON）    │
│       ▲                     （记忆 + 状态投影）                  │
│       │ 启动                        ▲                            │
│  Agent Host ──状态事件──► Notifier ─┘                            │
│  （信号源 + 启动器）                 │ 读取派生状态（GET /state）│
│  两种宿主档：                        │                           │
│    herdr — Agent 住在 TUI pane       │                           │
│    standalone — Agent 以             │                           │
│    detached 受监护 run 运行          │                           │
│                                      │                           │
└──────────────────────────────────────┼───────────────────────────┘
                                       ▼ 通知
                                    Channel ──► 人
     manual：人启动下一个 ｜ auto：Notifier 经启动器启动
     电源层：tut up / tut down — power.mode 选宿主档（herdr | standalone）
     只读围观（Kibitz）：/board · tut ps / attach / live-view
```

| 模块 | 职责 |
|------|------|
| **Context Hub** | 共享记忆（append-only 日志）+ 状态投影（派生视图）。对 Agent 暴露 MCP 工具，对 Notifier 暴露只读 GET /state。**只对记忆负责，不做流程执法** |
| **coding agent** | 若干个，角色分三种（Architect / Executor / Reviewer），角色是指派而非固定绑定 |
| **Agent Host** | 承载本机 Agent 的宿主环境，两个可插拔角色：信号源（Agent 状态事件）+ 启动器。两种宿主档由 `power.mode` 选择——**herdr**（TUI rig：Agent 住在终端 pane）/ **standalone**（无需终端复用器：服务与 Agent run 都是独立进程组） |
| **Notifier** | 通知与流转中枢：轮询派生状态，该谁动时通知人，交叉验证 Agent 是否交差 |
| **Channel** | 通知输出端（本机桌面提醒 / webhook） |
| **Kibitz** | 只读观测面：覆盖状态与 run 的 `/board` 页，加上 `tut ps` / `attach` / `live-view`——不带任何写控件 |

TUT 完全运行在本机，围绕 Context Hub 组织为三个平面：**状态面**（共享记忆与派生任务状态）、**运行面**（干活的 Agent 会话）、**监控面**（观察、通知与流转）。**电源层**（`tut up` / `tut down`）按 `power.mode` 选择的两种宿主档（`herdr` / `standalone`）拉起服务。最外面是一层只读观测面（Kibitz 看板与 run 围观命令），不带任何写操作。

**状态面。** Context Hub 是本地 MCP 服务，充当 Agent 之间的共享记忆：本地 JSON 上的 append-only 任务日志。任务状态（到哪一步、该谁动）是记录序列的纯函数，读取时派生，Hub 不做执法。消费方（Notifier、Kibitz 看板、CLI 命令）都经 GET /state 读同一份视图；Hub 本身只对记忆负责。

**运行面。** Agent 会话由 Agent Host 的启动器供给，落点二选一：`tui` 启动把每个 Agent 放进 Herdr rig 的终端 pane，开工指令打字投递进 pane；`detached` 启动让 Agent 以受监护的 detached run 运行——即 run 协议（`tut run / ps / attach / stop / resume`），原生非交互调用、精确续跑。后端由 `launch_mode` 选择，独立于电源档；自然配对是 herdr + tui 与 standalone + detached。无论哪种落点，角色上下文都只经 Hub 流动——会话之间从不直接对话。

**电源层。** `tut up` / `tut down` 是整套环境的电源开关：幂等 up、有序 down。`power.mode` 选实现——`herdr` 把 rig 供给为两个系统 pane；`standalone` 把 Hub 与 Notifier 拉起为独立进程组，事实落在 `.context-hub/power.json`，停止走身份门控、按组发信号——陈旧或无法验证的组永不被发信号。

**监控面。** Notifier 轮询派生状态（GET /state），消费侧路证据（tui 启动的 pane 状态事件、detached 启动的 run 结果）该谁动时经 Channel 通知人。manual 下由人启动下一轮；auto 下 Notifier 直接拉起下一个 Agent，按角色启动白名单门控。两种模式下审批都只属于人。

**只读观测（Kibitz）。** `/board` 的 Kibitz 看板置顶审批，其后是告警、交付轮次与活动 run；`tut ps`、`tut attach`、`tut live-view` 在终端侧给出同样的只读姿态。围观永远不会变成操作：停 run 与审批任务走 CLI / 人的工作流。

任务状态由记录序列派生：

```
designing → implementing → reviewing ─┬─ pass       → pending_approval → 人 decide(approve) → approved → closed
                                       ├─ fail_code  → revising → revision → 回到 reviewing
                                       └─ fail_design → 打回 designing
```

## 快速上手

前置：Node.js ≥ 20、至少一个 coding agent CLI。默认终端模式需要 Herdr（macOS/Linux 用 `brew install herdr`，Windows 从 [Herdr releases](https://github.com/herdrdev/herdr/releases) 安装）；无 Herdr 时用下面的 standalone 路径。平台边界见 [Windows 说明](#windows-说明)。

**安装**：npm 包自带构建好的 CLI、角色 skill 与启动器：

```bash
npm install -g take-ur-turn
```

在项目根目录执行一次接线，再启动工作区（均幂等）：

```bash
tut init
tut up
```

没有 Herdr 时，先执行 `tut config set power.mode standalone`；再执行 `tut config set launch_mode detached` 选择 detached 发车，随后 `tut up`。standalone 服务用 `tut down` 关停。Agent 接入见[下节](#agent-cli-接入一次性)。

**发起任务**——需求与验收在 Hub 中，任务先于首轮投递存在：

```bash
tut create --title "mode 子命令补 --url flag" \
           --description "给 CLI 的 mode 子命令补 --url；验收：贯通 Hub 调用，两种 flag 形式均有测试。" \
           --creator your-name --role human
tut start-next TASK_ID
```

将 `TASK_ID` 替换为 create 返回的 task_id，`your-name` 替换为你的名字。`start-next` 用于 manual；auto 由 Notifier 按白名单发车。`create` 支持 `--flow full|direct|solo` 与任务级 `--cast`，完整语法运行 `tut` 查看。

之后用 `tut status` 看总览；收到审批通知并核对交付后，用 `tut decide TASK_ID --decision approve --by your-name` 拍板。

Herdr 的[事件接线与终端投递](design/herdr-host.md)单独配置；源码安装见[开发](#开发)。

## 本地统计与元数据修复

`tut stats [task_id ...] [--root /path/to/.context-hub] [--json]` 离线只读，不启动 Hub、不写文件。缺省批次为全部本地任务（不含 project）；报告通过率、首轮通过率、修订、等待阻塞与角色交付。
质量指标只计推进流程的记录；`blocked_external` 与 `pass` 分列，solo 重交付计修订、不进评审率分母。
无评审为 `null`/`n/a`；损坏任务单列，不入分母；实时读取不是原子批次快照。

Token 按 agent 分组、不跨 agent 合计；缺失、过期、unresolved 或无效 sidecar 是覆盖缺口，不是零，未知成本为 `null`。
用量独立按 worker-round 归因，参照设计仍可有用量；v1 来源/行区间/窗口/计数/总量约束见[用量测量](scripts/usage-audit/README.md)，`--json` 包含指标定义。

`tut prune TASK_ID --by NAME --reason "回收本地空间" [--archive /backup/tasks]` 经运行中的 Hub 清理一个 **closed** 任务，执行须有人授权。指定归档时先将整个任务目录拷贝到 `<archive>/TASK_ID`，再向 `.context-hub/tasks/.pruned.jsonl` 追加并同步审计意图（task_id、时间、操作者、原因、可选归档路径、唯一 prune ID），然后移除目录。默认不备份；全量 records 归档仍走人工发版手册。
归档父目录须位于 Hub 存储目录外，已有副本拒绝覆盖。拷贝或 manifest 写入失败保留任务，部分归档副本也保留供检查；删除失败会保留已追加的意图，重试前先检查。manifest 只追加，已清理 ID 不复用，run 档案及原始引用保持不变。`/state` 可选暴露保留的 `pruned` ID 及可辨识的 `prune_events`。Notifier 将每次消失匹配到新的清理意图；恢复目录后重新武装消失告警，Notifier 重启后仍生效，历史意图始终保留在 manifest。`--by` 只落账，不构成授权。

`tut repair-meta TASK_ID --from-snapshot /path/to/state.json` 经运行中的 Hub 修复损坏/缺失元数据，拒绝覆盖可读元数据，不改记录。
快照须为事先保存的 Notifier `/state` JSON；核对来源与新鲜度，损坏后不能找回内存快照。
只预填 title/flow/cast；显式参数优先（cast 按 role），description/checkout 需手工补。
快照缺失/无效会警告并保留手工值与默认值；完整参数运行 `tut` 查看。

## 会话驱动（Host 模式）

在项目里开一个能读仓库、跑命令的交互式 coding-agent 会话，贴入：

```text
担任 TUT Host，全程驱动这个任务：<你的需求>
```

`tut init` 维护的 AGENTS.md 标记块让 Agent 自行运行 `tut skill host`，加载 [host skill](skills/host.md)。你负责说需求，Host 检查环境、磨需求与验收、建任务、交接轮次、盯状态，在审批门报告改动、验证与抽查意见。
发起委托授权普通推进循环；approve/reject/close 等仍须你的明确同意。auto 下 Notifier 接手发车，Host 聚焦审批与异常。
Host **驱动不代工**：design/code_changes/review/revision 由各 worker 会话发布。Host 角色与架构里的 Agent Host（运行环境）不同。
CLI 沙箱禁网时，Host 按 skill 的 MCP-first 工具表与降级入口继续；无法代行的操作交人。

## Agent CLI 接入（一次性）

按[随包声明指示](skills/agent-onboarding.md)，依据已安装 CLI 的本地 `--help`
自述最小 JSON；人手填写使用相同路径，无需另一个 agent。

```bash
tut agent add worker-x --from declaration.json  # 或 --from - 从 stdin 导入
tut assign executor binding:worker-x
tut start-next TASK_ID
```

`agent add` 经静态校验保存到 `.context-hub/config.json`，无需 TTY、会话/续跑样例或模型探针。
`binding:` 为显式逻辑引用保留前缀，缺失或损坏时明确报错，不回退 PATH/同名 profile。
既有无前缀命令保持原义。basic 绑定支持受管调用及 argv/stdin 输入；保存声明本身不证明发车或任务交付成功。
`agent setup ID [--from FILE]` 是可选导入/增强助手，可导入最小声明或完整原生 profile。
`agent probe ID` 显式运行隔离原生诊断，可能使用 CLI/模型；失败保留证据和已保存声明。

MCP 客户端使用 stdio `command=tut`、`args=["mcp"]`，先 `tut up`，从目标 workspace 启动；cwd 不可靠时设 `TUT_HUB_ROOT` 为工作区目录（非 `.context-hub`），换项目需移除或更新全局钉定。
勿为同一 server 同配固定 URL：它绕过工作区发现，可能把写入路由到另一 rig。配置后重启客户端 MCP 连接；桥不自动修改用户配置。

桥在每次 HTTP 请求前复验归属，断线后按 250/500/1000/2000/4000ms 五次有界退避重新发现，支持同根 Hub 重启换端口。中断的工具调用不重放：写入可能已落盘，重试前先 read 核实。

诊断只写 stderr，stdout 专用于 MCP。退出码：0 = stdin EOF，1 = 参数/内部错误，2 = 初始连接/归属验证失败，3 = 重连耗尽；SIGINT/SIGTERM 为 130/143。失败后启动正确 Hub，再重启 MCP 连接。完整契约见 [MCP 接入桥](design/system-design.md#431-agent-stdio-接入桥)。
无法配置 MCP 时用等价的 `tut create/publish/read/list/decide` 通道；[角色 skills](skills/) 给出 MCP/CLI 对照。

### Herdr 事件接线

在 `~/.config/herdr/plugins/tut-notify/herdr-plugin.toml` 定义顶层字段：`id="tut.notify"`、`name="TUT agent events"`、`version="0.2.0"`、`min_herdr_version="0.7.0"`、`description="Forward agent status changes to TUT herdr-hook.mjs"`、`platforms=["macos","linux","windows"]`（每项独占一行）。
添加 `[[events]]` 表，其中 `on="pane.agent_status_changed"`，`command=["<ABSOLUTE_NODE>","<ABSOLUTE_PACKAGE>/scripts/herdr-hook.mjs"]`。替换为真实绝对路径，不用 tilde/shebang/shell 展开；Windows TOML 路径用正斜杠或转义反斜杠。
执行 `herdr plugin link ~/.config/herdr/plugins/tut-notify` 与 `herdr plugin list` 确认启用；起 Hub/Notifier，运行 pane 内 Agent，核对 notify 日志事件。非默认 `--event-port` 须在插件与 launcher 继承环境中设置匹配的 `TUT_EVENT_PORT_URL=http://127.0.0.1:PORT/agent-event`（缺省 3002）。[信号契约](design/herdr-host.md#4-hook-信号线与通知接线)解释事件处理。

## 只读看板

在运行中的 Hub 地址打开 `/board`（如 `http://127.0.0.1:3001/board`）。页面每 5 秒独立读取 `/state` 与 `/runs`，失败后有界退避。待审批任务置顶，展示告警、交付轮数与显式 cast；运行卡片并列展示记录状态、PID 存在性观察及最多 20 行 / 64 KiB 的日志尾部。运行退出不代表任务已交付。

运行数据来自 Hub 配置的存储根下 `runs/`，文件缺失或损坏时如实标 degraded。断连保留旧快照并标过期，同根 Hub 重启后自动恢复；`hub_root` 改变时需要重新载入。页面无写操作入口，停止与审批沿用既有 CLI / 人工流程，无需前端构建或新增依赖。 运行预览在 macOS 11+ 使用内核全路径拒绝链接、在 Linux 使用 `/proc/self/fd` 目录锚定；无法安全打开时标 `unsafe_path`/degraded，不回退到无保护读取。

## 命令速览

运行无参数 `tut` 查看全部命令与参数；角色操作规程用 `tut skill ROLE`（host / architect / executor / reviewer）查看。 续跑、只读座位与 checkout preflight 的详细用法见该帮助的 `resume` / `live-view` / `run` / `doctor` 条目。 close 还会追加 `close-stop` 系统审计 note，记录实际停止结果；这不构成人工授权。

## 典型工作流

```
host/人建任务（tut create——需求+验收在 title/description，flow/cast 为旗子）
    ↓ 首轮即普通轮（tut start-next / auto）
Architect 发布 design
    ↓ 派生: designing → implementing
Executor 读上下文 → 编码实现（跑测试）→ 发布 code_changes
    ↓ 派生: implementing → reviewing
Reviewer 读上下文 → Review（每条问题带关闭条件）→ 发布 review
    ├─ pass        → pending_approval → 人 decide(approve) → approved
    └─ fail_code   → revising → Executor 发布 revision → 回到 reviewing
（Notifier 轮询状态变化，manual 模式通知人启动下一步，auto 模式可自动流转）
```

上图是默认流程 **full**。建任务时可选变体（create 时确定、落库后不可变）：

- **solo**：小改动免设计轮与 review——create 即 implementing，design 记录仅作参考（不转态），code_changes 直接派生 pending_approval 由人 approve / reject。免审不免批：approve 仍是人的门
- **direct**：简单改动触及风险面（核心路径/门禁/公开面，错了贵）时，给 solo 加一轮 review——与 solo 同样建任务即 implementing（repo 已有现成设计可供施工），review 与人审批照常

## 配置

### ① 项目运行时 — `.context-hub/config.json`（gitignored）

| 键 | 作用 | 缺省 |
|---|---|---|
| `flow_mode` | manual 人发车 / auto Notifier 发车；`tut mode manual` 或 `tut mode auto` | `manual` |
| `auto.launch_roles` | auto 按角色启动白名单；空则只通知人，不影响手动启动 | `[]` |
| `launch_mode` | 发车后端 tui / detached，独立于电源和流程 | `tui` |
| `power.mode` | `tut up/down` 电源实现 herdr / standalone | `herdr` |
| `notify` | channels（desktop/webhook）、webhook_url；手编 JSON | 终端 bell 与 notify 日志 |

`config get/set` 支持的键和值域运行 `tut` 查看；`config set flow_mode auto` 是 `tut mode auto` 的离线等价，运行时设置下次请求/轮询生效。
用 `tut config set launch_mode detached` 选择 detached 发车；兼容别名 `headless` 的 get/set 均规范为 detached，无预定退役或周期告警；旧 marker/run/usage 协议标识不迁移。
standalone 停机有身份核验且不停止独立 run；完整电源行为运行 `tut` 查看，平台缺口见 [Windows 说明](#windows-说明)。
OpenCode 2.2 detached 路由须显式 `--auto`，如 `--cast 'executor=opencode --model zai-coding-plan/glm-5.3-flash --auto'`；缺失时落痕前拒绝。route 不得自选 session 或夹带第二条 prompt；观测 session 的续跑与 `start-next --fresh` 见帮助；Windows 不支持，当前无 usage 归因、不计 token。

### ② Rig 阵容与调用意图

`.context-hub/config.json` 是 rig 的人工意图文件。`tut mode`、`tut config set`、`tut assign`、`tut agent add` 共用保键原子写端口及跨进程锁。`flow_mode` 与 `auto.launch_roles` 仍是本机显式授信；声明阵容不授予启动权限。

```json
{
  "flow_mode": "manual",
  "roles": {
    "architect": {"agent": "codex"},
    "executor": {"agent": "pi", "args": ["--model", "chosen-model"]},
    "reviewer": {"agent": "codex"}
  },
  "naming": {"tab_label": "TUT {role}"},
  "agent_bindings": {
    "custom": {"executable": "custom-cli", "args": ["run", "--quiet"], "prompt": {"kind": "argv", "index": 2}}
  }
}
```

任务 `--cast` 覆盖对应角色。`config.roles` 存在时是完整权威阵容：缺席角色须显式 assign 或 cast，坏声明拒绝，不跨层补角色或拼参数。config 损坏时包括 cast 在内的新发车均拒绝；所属 rig 的意图独立于执行 checkout 选择。

旧 rig 尚无 `config.roles` 时保留兼容链：项目 `.context-hub/workspace.json` → 用户 `~/.config/tut/workspace.json`（`TUT_USER_CONFIG_DIR` 覆盖）→ 内置 architect=codex、executor=pi、reviewer=codex。`tut assign` 从任务 checkout 或子目录调用时也写所属 rig（`TUT_HUB_ROOT` 或最近的 rig）。首次 `tut assign ROLE COMMAND...` 把有效阵容固化到 config，保全项目旧扩展，键冲突时拒绝。workspace 文件不被改写或删除，不扩展用户级继承链。旧 `label` 保留但不参与路由。

`naming.tab_label` 默认 `TUT {role}`，支持 `{role}`/`{task}`/`{agent}`；机器 pane 键固定 `<task_id>.<role>`。config 显示节存在时覆盖旧显示配置。Codex 追加 `-c check_for_update_on_startup=false`，pi 加 `env PI_SKIP_VERSION_CHECK=1`；`TUT_SUPPRESS_AGENT_UPDATE=0` 关闭附加项。

`tut agent add custom --prompt argv:2 -- custom-cli run --quiet` 保存上述最小声明；`--prompt stdin` 表示标准输入。argv 索引是固定 args 中的 prompt 插入位置，范围 0 至 args 长度。目前支持声明写入与解析，基础发车消费另属后续单元；既有 setup/profile 发车路径继续使用。命令沿用 shell-neutral token 语法，参数保序，不猜厂商 flag。

### ③ 调用参数与环境

端口、地址、轮询和超时参数以无参数 `tut` 输出为准；`--root` 在 serve/config 等指存储目录，在 up/down 指拥有 `.context-hub` 的 rig 根。
常用环境覆盖：`TUT_HUB_ROOT`/`TUT_HUB_URL` 指定所属 Hub，`TUT_PROJECT_ROOT` 覆盖旧阵容 L1，`TUT_USER_CONFIG_DIR` 覆盖 L2；`TUT_UP_CLI_SELF` 覆盖电源所用 CLI，`TUT_SPLIT_BASE` 提供 Herdr pane 诞生锚点。
更多实现细节见[系统设计](design/system-design.md)与[宿主文档](#文档)。

## 开发

依赖清单见 [package.json](package.json)：运行时依赖为 @modelcontextprotocol/sdk + zod（显式声明，保证与 SDK 共享同一 zod 实例），此外无其他运行时依赖。 源码产物为 `dist/cli.js`；用 `npm link` 暴露 `tut`，或直接执行 `node dist/cli.js <子命令>`。

```bash
git clone https://github.com/ianf-ai/take-ur-turn.git
cd take-ur-turn
npm install        # 安装依赖
npm run build      # 先编译到 dist/，再测试和类型检查
npm test           # 跑测试（vitest）
npm run typecheck  # 类型检查
```

Agent 角色的行为指令在 [skills/](skills/) 目录（architect / executor / reviewer / host，行为模板而非身份绑定——任何 Agent 加载后都能干这类活）。

## 文档

- [design/system-design.md](design/system-design.md) — **系统设计（根文档）**：宿主无关核心与宿主契约
- [design/context-design.md](design/context-design.md) — **上下文设计**：放什么（scope / 记录类型 / 正文内容要求）、怎么管理
- [design/herdr-host.md](design/herdr-host.md) — **Herdr 宿主**：pane、电源、hook、终端投递与 Enter 补救
- [design/standalone-host.md](design/standalone-host.md) — **Standalone 宿主**：服务电源、run、detached 发车、续跑、座位与 preflight

## 故障排查与已知限制

### Windows 说明

standalone 电源无需 Herdr，要求 Node、PowerShell 5.1+ 与 CIM/NetTCPIP；`up`/`doctor` 报告未注册服务，`up --adopt` 核验采纳同 workspace 监听者，`--dry-run` 只预览。
服务事实用 `process_scope: "windows-tree"`、`pgid: null`；down 核验创建 token 后强制终止捕获的服务树，排除 run 根/supervisor（含启动中），复验端点并逐服务记完成，部分失败可重试。
没有 Job Object 或 POSIX 宽限期；捕获前 leader 已亡、身份不可读或 run 元数据损坏会拒绝；已孤儿化/快照间逃逸后代不保证回收。电源支持不等于 run/发车支持，详情运行 `tut` 查看。
Herdr + PowerShell 5.1 的 hub/MCP/CLI/流转驱动已验证；安装边界：

- npm agent 的 `.cmd` shim 不执行；改用原生可执行文件或 direct Node entry，如 `tut assign executor node "%APPDATA%/npm/node_modules/@openai/codex/codex.js"`。
- PowerShell 拦脚本时执行一次 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。
- Herdr 电源需当前 pane 或有效 `HERDR_PANE_ID`；无头环境用 `tut config set power.mode standalone`。
- toast 不可用回落 bell；勿扰模式可静默抑制 toast；每次刷新 HKCU 用户级 AppUserModelID，无需管理员安装。
- Herdr Windows zip 需要 `vc_redist.x64`，缺失时可能静默退出。

**排障**：

- **Agent 说看不到 context.* 工具**：在目标 workspace 执行 `tut status` 确认所属 Hub 可达；确认 MCP 配置在正确 workspace 运行 `tut mcp`（或钉定 `TUT_HUB_ROOT`）；个别 CLI 会话可能被沙箱挡住 localhost 回连——此时让该 Agent 改用 CLI 通道（`tut read` / `tut publish`），行为完全等价
- **3001 端口被占用（EADDRINUSE）**：在目标 workspace 运行 `tut up`。它会验证 Hub 归属，发现该 workspace 的既有本地 Hub；默认端口对被占用时，从 3003/3004 起选择空闲端口对供给自己的 Hub/notifier。普通 CLI 也会发现所属 Hub；显式 `--url` 指向 foreign Hub 会被拒绝。手工指定地址可用 `tut serve --port <n>` 与 `--url`，挪事件端口用 `--event-port`（Hub 与事件端口不能相同）。复用 Hub 不代表 notifier 在相邻端口：`up` 通过 notifier 的 `hub_root` 与 `hub_url` 确认归属，保留 3101/3002 及自动分配的端口对。复用 notifier 要求其报告身份字段；移动事件端口前先停止已有 notifier。
- **启动锁错误**：`another up (pid N) is provisioning` 表示应等待该次启动完成；只有确认没有其它 `tut up` 实例在运行后，才可删除提示中的 `.context-hub/up.lock` 并重试。`cannot verify startup lock` 可能是锁文件损坏，也可能撞上初次写入的竞态：先重试；若持续失败，检查锁内容并确认没有其它 `tut up` 在运行后再删除。`startup lock recovery in progress` 表示另一个实例正在接管陈旧锁：先重试；若接管已中断，检查提示中的 `.context-hub/up.lock.reclaim` 目录，仅在确认没有其它 `tut up` 在运行后删除该目录。
- **工作区阵容存储**：新阵容写入 `.context-hub/config.json`；旧 workspace 文件仍保留兼容读。工作区解析链见[配置](#配置)

**已知限制**（设计取舍，非 bug）：

- 角色变更必诞生全新 pane/session（`<task_id>.<role>`，锚定 hub 所在 workspace/cwd，由生命周期钩子在下一轮交接或 `tut decide close` 时回收）；同任务同角色连续轮（revision、re-review）则延续现存同角色 pane——只投递不收割不新生：上下文仍只经 Hub 流动、不越过角色边界，且免全量重读。同角色想要外部视角？`tut start-next --fresh` force-close 工位（含 working）后照常新生。同轮重复启动被 launch note 拒绝（ALREADY_LAUNCHED；用 `tut start-next --force` 恢复）
- 任务未经 decide close 即放弃时 pane 会遗留（无自动孤儿回收）；手工关闭或由后续生命周期钩子收尾
- Notifier 按轮询粒度观察状态：轮询窗口内的中间态不被观察（版本号可见跳变）；状态以记录重放为准，任何中间态都可从日志复原
- auto 模式下 decision 记录无法密码学验证「确实来自人」——当前靠通知审计 + by 字段追溯兜底，更结构化的解法留待多机部署场景

## Credits

Agent 承载由 [Herdr](https://github.com/herdrdev/herdr) 驱动——运行时前置、独立安装；本包不分发其代码。

## License

[Apache-2.0](LICENSE)

[测试环境分类与门禁 profiles](test/README.md)
