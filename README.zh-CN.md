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
┌────────────────────────── 本机 ──────────────────────────┐
│                                                          │
│  coding agent ──MCP 读写──► Context Hub ──► 存储（本地 JSON）│
│       ▲                    （记忆 + 状态投影）               │
│       │ 启动                      ▲                       │
│  Agent Host ──状态事件──► Notifier ─┘                       │
│  （信号源 + 启动器，可插拔）      │ 读取派生状态（GET /state） │
│                              │                           │
└──────────────────────────────┼───────────────────────────┘
                               ▼ 通知
                          Channel ──► 人
     manual：人启动下一个 ｜ auto：Notifier 经启动器启动
```

| 模块 | 职责 |
|------|------|
| **Context Hub** | 共享记忆（append-only 日志）+ 状态投影（派生视图）。对 Agent 暴露 MCP 工具，对 Notifier 暴露只读 GET /state。**只对记忆负责，不做流程执法** |
| **coding agent** | 若干个，角色分三种（Architect / Executor / Reviewer），角色是指派而非固定绑定 |
| **Agent Host** | 承载本机 Agent 的宿主环境，两个可插拔角色：信号源（Agent 状态事件）+ 启动器；当前实现 Herdr |
| **Notifier** | 通知与流转中枢：轮询派生状态，该谁动时通知人，交叉验证 Agent 是否交差 |
| **Channel** | 通知输出端（本机桌面提醒 / webhook） |

任务状态由记录序列派生：

```
designing → implementing → reviewing ─┬─ pass       → pending_approval → 人 decide(approve) → approved → closed
                                       ├─ fail_code  → revising → revision → 回到 reviewing
                                       └─ fail_design → 打回 designing
```

## 快速上手

前置：Node.js ≥ 20、Herdr（Agent Host，承载各 Agent 的终端 pane；macOS/Linux 用 `brew install herdr`，Windows 从 [Herdr releases](https://github.com/herdrdev/herdr/releases) 取原生二进制）、至少一个 coding agent CLI。**平台：macOS、Linux、Windows**（安装边界见 [Windows 说明](#windows-说明)）。

**安装**——npm 包自带运行所需的一切（构建好的 CLI、角色 skill、启动器脚本）：

```bash
npm install -g take-ur-turn
```

**从源码跑**（参与开发用）：

```bash
git clone https://github.com/ianf-ai/take-ur-turn.git
cd take-ur-turn
npm install
npm run build
```

从源码构建的产物是 `dist/cli.js`。用 `npm link` 把 `tut` 命令暴露到 PATH；不想 link 时 `node dist/cli.js <子命令>` 始终可用（下文以 `tut` 代称）。

**起工作区**（电源开关，幂等——hub pane + notify pane 两个系统 pane）：

```bash
tut up
```

机器上没有 Herdr？先切电源实现：`tut config set power.mode standalone`，随后 `tut up` 以 detached 进程拉起同一套服务（进程事实落 `.context-hub/power.json`），`tut down` 关停。见[命令总览](#命令速览)。

**一次性接线**——把 TUT 标记块注入项目 `AGENTS.md`（幂等：无文件则创建，已有标记块只刷新不重复追加）：

```bash
tut init
```

Herdr 的终端投递与 Enter 补救见 [Herdr 宿主协议](design/herdr-host.md#32-单次投递)。

**发起一个任务**（发起侧两步——任务先于投递存在，首轮即普通轮）：

```bash
tut create --title "mode 子命令补 --url flag" \
           --description "给 CLI 的 mode 子命令补一个 --url flag。\
验收：flag 贯通到 Hub 调用；两种 flag 形式均有测试。" \
           --creator <你的名字> --role human
tut start-next <task_id>   # manual：投首轮（auto 模式：Notifier 按白名单自动投递）
```

`create` 的流程（`--flow full|direct|solo`）与任务级阵容是真旗子。cast 既支持旧的裸名（`--cast executor=pi`），也支持带有序参数的命令（`--cast 'executor=codex --model <executor-model> --sandbox workspace-write --search'`）；多个带参 role 可重复 `--cast`。旧逗号简写（`--cast executor=pi,reviewer=codex`）继续兼容。需求与验收口径写在 `title` + `description` 里，Agent 经 `context.read` 自取。

之后 Agent 在各自 pane 里经 MCP 工具读写 Hub 推进任务；`tut status` 看总览，该人审批时 Notifier 会通知你，`tut decide <task_id> --decision approve --by <你的名字>` 拍板。

Notifier 的辅通道（blocked 即时告警、done 交叉验证）依赖 Herdr 把 pane 内 Agent 的状态变化投给 `scripts/on-agent-event.sh`——这是一次性的环境配置（Herdr 插件），见 [Herdr 事件接线](#herdr-事件接线)。

## 本地统计与元数据修复

`tut stats [task_id ...] [--root /path/to/.context-hub] [--json]` 经 Store 读取本地记录与 usage audit sidecar，不启动任何服务、不写任何东西（含临时文件清理）。不带 task_id 时批量 = 全部本地任务，不含 project scope。报告逐任务与整批给出：严格评审通过率、首轮通过率、修订交付次数、当前 waiting 阻塞，以及按记录角色统计的交付分布。这些质量指标只统计推进既有工作流的记录；直接引用的设计与游离的表外记录不计入。`blocked_external` 与已核验的 `pass` 分列；无评审记为 `null`/`n/a`。solo 被拒后的重复交付计入修订，不进评审率分母。

Token 按 agent 分组——Pi 与 Codex 的原生记账不同，不提供跨 agent 合计。用量遵循 audit 的 worker-round 归因，与质量指标相互独立，测量用参照设计的 token 用量照常保留。sidecar 必须满足冻结的 v1 来源、行区间、窗口、计数器与总量约束；缺失、过期、unresolved 或无效的 sidecar 一律记为覆盖缺口，绝不视同零。未知成本保持 `null`。损坏任务单列，不入统计分母。实时读取是尽力而为，不是原子批次快照。归因与原生 token 定义见 [usage measurement](scripts/usage-audit/README.md)；`--json` 内含指标定义。

`tut repair-meta <task_id> --from-snapshot /path/to/state.json` 可从先前留存的 Notifier `/state` JSON 响应预填 `title`、`flow` 与 `cast`。Notifier 目前只在内存保留最新快照；该模式消费的是保存下来的文件，损坏后无法找回内存里的内容，使用前请核对来源与新鲜度。显式参数优先于快照值（cast 按 role 覆盖）；快照缺失或无效时给出警告，手工字段与既有默认值保持生效。修复仍经运行中的 Hub 执行，元数据可正常读取时拒绝（只服务损坏场景）。需要时 description 与 checkout 仍须手工提供。


## 会话驱动（Host 模式）

上面的快速上手是手动路径——其实除了 `tut up` 和 `tut init`，你不必再碰终端：在项目里开一个交互式 coding-agent 会话（任何能读仓库、能跑 shell 命令的 CLI agent），让它担任 TUT Host——它会运行 `tut skill host` 加载 [host skill](skills/host.md) 并按其行事，成为你的 **Host** 驱动者。你负责说话，Host 负责环境检查、把你的诉求磨成任务（`tut create`，需求+验收）、轮次交接代按 `tut start-next`、盯状态，到审批门带着三件套回来找你：改了什么、验证结果、它自己的抽查意见。

**一句话激活 Host**——把下面这句直接贴进 Agent 会话（换成你的需求即可）：

```text
担任 TUT Host，全程驱动这个任务：<你的需求>
```

激活语是纯意图——不含路径、不含操作指引；机制经项目 `AGENTS.md` 注入（`tut init` 维护的标记块，幂等）：收到指令的 Agent 会运行 `tut skill host` 自取规则，激活语无需教它怎么做。

对话大致长这样：

> 你：「全程驱动这个任务：给 mode 子命令补个 --url flag。」
> ……Host 建任务、推轮次、盯状态……
> Host：「review pass。改动 2 个文件 +12/−3，测试全绿；我抽查了 diff，无异议。批吗？」

发起时一句委托（「全程驱动这个任务」）即授权整个推进循环；审批永远归你——Host 只呈现、不代批，每次 `tut decide` 都凭你的明确同意才执行。auto 模式下轮次交接由 Notifier 接手，Host 的重心移到审批门与异常处置。

环境提示：个别 Agent CLI 的命令沙箱默认禁网——CLI 通道（`tut list` 等）在此类会话里可能被拦，而 MCP 工具经 Agent 宿主进程连接、不受影响。host skill 因此写成 **MCP-first**：零网络配置的沙箱会话也能跑通 Host 全流程（skill 的工具面表逐条列了降级用法）。

守住分工的边界是**驱动不代工**——Host 不写 design / code_changes / review / revision 记录，这些只出自 architect / executor / reviewer 各自 pane 里的会话。（Host 角色与架构表里的「Agent Host」无关——后者指 Herdr，承载 Agent 的终端环境。）

## Agent CLI 接入（一次性）

使用安装版 `tut mcp` 作为 **stdio** MCP Server。它发现当前 workspace 所属的 Hub，验证 `hub_root` 后桥接其 Streamable HTTP `/mcp` 端点。先在所属 workspace 执行 `tut up` 启动 Hub。

**Codex CLI**（`~/.codex/config.toml`）：

```toml
[mcp_servers.tut]
command = "tut"
args = ["mcp"]
```

其他 stdio MCP 客户端使用相同 command / args。客户端须在目标 workspace 启动命令；若不能保证工作目录，用 server 级 env 钉定所属 Hub 根（任务 worktree 可以共享该根）：

```toml
[mcp_servers.tut.env]
TUT_HUB_ROOT = "/absolute/path/to/workspace"
```

填 workspace 目录，不是 `.context-hub` 子目录。全局钉根意味着明确选择一个 workspace，切换项目时须移除或修改。`TUT_HUB_URL` 可提供首选本机 Hub 基础 URL；归属仍须匹配 `TUT_HUB_ROOT` 或 cwd 推导出的根，否则沿 CLI 同源的 3001–3199 奇数 Hub 端口有界扫描。

**MCP 连接配置**：使用上面的 command / args，按需设置根，再重启客户端 MCP 连接；同一 server 不同时配置固定 url。固定 URL 可供 HTTP 客户端使用，但绕过 workspace discovery，多 rig 时可能静默把写入路由到另一 workspace。TUT 不自动修改用户配置。

桥在每次 HTTP 请求前复验归属，断线后按 250/500/1000/2000/4000ms 五次有界退避重新发现，支持同根 Hub 重启换端口。中断的工具调用不重放：写入可能已落盘，重试前先 read 核实。诊断只写 stderr，stdout 专用于 MCP。退出码：0 = stdin EOF，1 = 参数/内部错误，2 = 初始连接/归属验证失败，3 = 重连耗尽；SIGINT/SIGTERM 为 130/143。失败后启动正确 Hub，再重启 MCP 连接。

配好后 Agent 会看到 5 个工具：`context.create` / `context.publish` / `context.read` / `context.list` / `context.decide`。

**不支持 MCP 的 CLI**：走等价的 CLI 通道——`tut create / publish / read / list / decide` 子命令与 MCP 工具一一对应，Agent 经 shell 调用即可（skills 里各角色的「工具速查」表（MCP | CLI 对照）就是为这类 CLI 准备的；两类通道可混用，同一任务里各角色各走各的通道完全兼容）。

**无 MCP 配置能力的环境**（如某些会话的沙箱限制）：同上走 CLI 通道兜底。

### Herdr 事件接线

Notifier 的 blocked / done / working 辅通道需要一次性安装 Herdr 插件。创建 `~/.config/herdr/plugins/tut-notify/` 并写入 `herdr-plugin.toml`：

```toml
id = "tut.notify"
name = "TUT agent events"
version = "0.2.0"
min_herdr_version = "0.7.0"
description = "Forward agent status changes to TUT herdr-hook.mjs"
platforms = ["macos", "linux", "windows"]

[[events]]
on = "pane.agent_status_changed"
command = ["<ABSOLUTE_NODE>", "<ABSOLUTE_PACKAGE>/scripts/herdr-hook.mjs"]
```

将 `<ABSOLUTE_NODE>` 换成 Node 可执行文件的绝对路径，将 `<ABSOLUTE_PACKAGE>` 换成 TUT 安装包根目录。Herdr 不做 shell 展开，不使用波浪号或 shebang；Windows 同样直接调用 Node，TOML 路径中的反斜杠须转义（也可使用正斜杠）。

激活插件：

```bash
herdr plugin link ~/.config/herdr/plugins/tut-notify
herdr plugin list
```

列表应显示 `tut.notify` enabled。启动 Hub 与 Notifier 后，在 pane 内运行一回合 Agent，检查 notify pane 日志是否出现事件行。

若使用 `tut notify --event-port <p>`，须在 Herdr 插件与启动器继承的环境中设置 `TUT_EVENT_PORT_URL=http://127.0.0.1:<p>/agent-event`；未设置时生产者向默认端口 3002 投递。

## 只读看板

在运行中的 Hub 地址打开 `/board`（如 `http://127.0.0.1:3001/board`）。页面每 5 秒独立读取 `/state` 与 `/runs`，失败后有界退避。待审批任务置顶，展示告警、交付轮数与显式 cast；运行卡片并列展示记录状态、PID 存在性观察及最多 20 行 / 64 KiB 的日志尾部。运行退出不代表任务已交付。

运行数据来自 Hub 配置的存储根下 `runs/`，文件缺失或损坏时如实标 degraded。断连保留旧快照并标过期，同根 Hub 重启后自动恢复；`hub_root` 改变时需要重新载入。页面无写操作入口，停止与审批沿用既有 CLI / 人工流程，无需前端构建或新增依赖。 运行预览在 macOS 11+ 使用内核全路径拒绝链接、在 Linux 使用 `/proc/self/fd` 目录锚定；无法安全打开时标 `unsafe_path`/degraded，不回退到无保护读取。

## 命令速览

`tut` 不带参数打印完整 USAGE。语法一字不差摘录如下：

```
tut serve [--port <n>] [--root <dir>]
tut notify [--url <u>] [--interval <s>] [--event-port <p>] [--stall-timeout <m>] [--working-timeout <s>]
tut mode <manual|auto> [--url <u>]
tut config get <key> [--root <dir>]
tut config set <key> <value> [--root <dir>]
tut start-next [<task_id>] [--url <u>] [--force] [--fresh]
tut watch [<task_id>] [--url <u>] [--interval <s>]
tut create --title <t> --description <d> --creator <c> --role <r> [--flow <full|direct|solo>] [--cast <role=command>]... [--url <u>]
tut publish <task_id> --role <r> --content-type <t> --summary <s>
             (--body <text> | --payload-file <md>)
             [--verdict <pass|fail_code|fail_design>] [--commits <a,b>]
             [--ref-version <n>] [--expected-version <n>] [--agent <a>] [--model <m>] [--url <u>]
tut read <task_id> [--since-version <n>] [--json] [--url <u>]
tut list [--status <s>] [--json] [--url <u>]
tut decide <task_id> --decision <approve|reject|close> --by <b> [--reason <text>] [--url <u>]
tut assign <role> <command...>
tut up [--url <u>] [--event-port <p>] [--root <dir>] [--dry-run]
tut down [--root <dir>]
tut skill <host|architect|executor|reviewer>
tut init
tut ack <task_id> [--note <text>] [--url <u>]
tut status [--json] [--url <u>]
tut run [--task <id>] [--fix-preflight] -- <command...>
tut ps [--json]
tut attach <run-id>
tut stop <run-id>
tut resume <run-id> [instruction] [--fix-preflight]
tut live-view --layout <json-file>
tut doctor [--root <dir>] [--url <u>] [--checkout <dir>] [--fix-preflight] [--json]
```

Agent 侧的等价通道是 5 个 MCP 工具（`context.create` / `context.publish` / `context.read` / `context.list` / `context.decide`），CLI 子命令与之一一对应。

### 续跑已停止的 run

`tut resume <run-id> [instruction]` 在一个新 run 里继续某个已完成 run 的精确原生
agent 会话——旧 run 的日志、身份与停止证据原样保留。codex 经由运行日志观测到的
session id 续跑；pi 只恢复已存储且在本项目会话库中核验过的身份（pi 的
`--session-id` 在会话缺失时会静默新建，因此不可核验的 id 会被拒绝而不是伪造恢复）。
跨进程准入：同一会话（受管 run 还包括同一任务）仍被未完成的 run 或 pending 启动
意图占用时拒绝 spawn。受管（headless 归属）续跑额外要求同根 Hub 在线、任务在 /state 与日志两处
仍等待该角色、无 needs_attention、非 pending_approval/approved/closed，并在
spawn 前追加人工启动 marker，避免 auto 双启动。stdout 只输出新 run-id；退出 0
表示启动确认，不是任务成功。

### 只读座位视图

`tut live-view --layout <file>` 渲染只读终端座位网格。布局声明 `schema:1`、`rows`、
`columns` 与座位 selector——`{task_id, role}`（仅匹配明确 headless 归属；运行中的
run 占据座位，多个未完成显示冲突，全部结束则显示最近完成者）或 `{run_id}`（固定）。
每个窗格都是本包 `tut attach` 子进程且 stdin 忽略：无键入通道，不做 stop/resume/
decide。Ctrl-C 只关闭视图及其 attach 子进程；被观察的 run 继续运行，可被另一个
attach 围观。

### checkout preflight 与 close 审计

`tut run` / `tut resume` / auto detached 启动在 spawn 前检查执行 checkout：声明了
依赖的 Node checkout 需要可读的 `node_modules`，TUT 源码 checkout 需要 `dist/`。
缺失项以精确绝对路径与修复指引拒绝启动；无 Node manifest 的目录永不受门禁。
`--fix-preflight`（run/resume/doctor）只执行受支持修复——锁文件下 `npm ci`、TUT
dist 的 `npm run build`——有界、可见（输出走 stderr，stdout 保持单行结果）、限
被查目录内；修复步骤失败时即使半途产物已存在也一律拒绝。`tut doctor` 新增第九
项检查与 `--checkout <dir>`（被查目录；`--root` 保持存储目录含义）。关闭任务现在
还会向已关闭任务追加 `close-stop` 审计 note，记录协作停止的实际结果（系统操作
审计，不是人工授权）。

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

三层配置面，性质不同、位置不同：

### ① 项目运行时配置 — `.context-hub/config.json`（gitignored，每个项目一份）

Hub 与 Notifier 的行为。改后下个轮询周期生效，无需重启：

| 键 | 作用 | 缺省 |
|---|---|---|
| `flow_mode` | `"manual"` / `"auto"`——轮次交接时谁按启动键（人 / Notifier 经启动器自动启动）。推荐用 `tut mode <manual\|auto>` 切换 | `manual` |
| `notify` | 通知渠道：`channels`（desktop / webhook 等）与 `webhook_url` | 未配置 = 终端 bell 与 notify pane 日志 |
| `auto.launch_roles` | auto 模式的启动白名单（按 role 键控，如 `["executor","reviewer"]`）。**缺省空 = 全部回落通知人**——不在白名单的轮次不自动启动、不落启动痕，人的手动启动不受影响 | `[]` |
| `launch_mode` | `start-next` 与 Notifier 的发车后端：`"tui"` 或 `"detached"`。兼容别名 `"headless"` 选择同一后端；get 返回规范值且不回写，set 两种拼写都写 `detached`。缺文件/键默认 `tui`，坏档和非法值明确失败 | `tui` |
| `power.mode` | `tut up` 的电源实现：`"herdr"`（pane 供给，行为不变）或 `"standalone"`——`tut up` 自行拉起 detached 进程组（pid/pgid/port 事实落 `.context-hub/power.json`），`tut down` 关停。停机信号身份门控且按组作用域：leader 已亡的残留组仅在有存活成员通过本 rig 的电源成员登记（会话标记 `TUT_POWER_SESSION` 绑定存活服务实例，复用服务在重复 up 后保留原会话，并随服务自身的 launch 子进程继承）核验时才清理；陈旧或无法归属的组永不发信号。非法值（或配置不可读）会让 up/down 在任何供给动作前显式失败 | `herdr` |

用 `tut config set launch_mode detached` 选择 detached 发车，与 `power.mode`、`flow_mode` 独立。兼容别名 `headless` 无预定删除日期、不产生周期告警。marker 的 `launch_mode: "headless"` / `target_kind: "headless-posix"` 和 run 的 `headless` 归属键仍是协议标识；旧记录、run 和 usage 文件不迁移。

`flow_mode` 与 `auto.launch_roles` 无需手编 JSON：`tut config get <key>` / `tut config set <key> <value>`（键与值域均校验；`tut config set flow_mode auto` 即 `tut mode` 的离线等价，Hub 未起也能用——与 `tut assign` 同纪律）。Hub 每次请求现读此文件，写入下个轮询周期即生效，无需重启。

### ② 工作区阵容 — 三级解析链（项目 → 用户 → 内置）

每个 role 由哪个 Agent CLI 出演（建单未显式指定 `--cast` 时按它解析）。逐字段逐级回退——文件缺失或损坏视为该级缺席，role 键各自独立回退：

| 级 | 位置 | 说明 |
|---|---|---|
| L1 项目级 | `<项目>/.context-hub/workspace.json` | 环境态归项目（gitignored，与 config.json 同居）；`tut assign <role> <agent>` 写的就是这份（不存在时从当前有效阵容初始化） |
| L2 用户级 | `~/.config/tut/workspace.json` | 机级默认阵容；手工维护（先 `mkdir -p`）。`$TUT_USER_CONFIG_DIR` 覆盖整个目录 |
| L3 内置 | `DEFAULT_ROLES` | architect=codex / executor=pi / reviewer=codex，值冻结 |

文件形状（只写想改的字段即可；条目可带多余键——旧形 `{label, agent}` 读侧容忍，只读 `.agent`）：

```json
{
  "roles": { "architect": { "agent": "pi" }, "executor": { "agent": "pi" }, "reviewer": { "agent": "codex" } },
  "naming": { "tab_label": "TUT {role}" }
}
```

带参 workspace 条目使用有序 `args` 数组，例如：
`"executor": { "agent": "codex", "args": ["--model", "<executor-model>", "--sandbox", "workspace-write", "--search"] }`。
旧的裸字符串 cast 形状保持不变；TUT 不解释命令值中的 shell 引号、变量、运算符、重定向或 glob。只有命令首词进入 `command -v` 检查，完整 argv 才交给 launcher。Codex 在用户参数之后追加 `-c check_for_update_on_startup=false`，pi 在命令前加 `env PI_SKIP_VERSION_CHECK=1`；`TUT_SUPPRESS_AGENT_UPDATE=0` 可关闭这些附加项。

`naming.tab_label` 渲染**tab** 标签（人读侧）：占位符 `{role}` / `{task}` / `{agent}`，未知占位符原样保留，默认 `TUT {role}`。**pane** 标签是机器寻址键、不可模板化：轮次 pane 恒为 `<task_id>.<role>`（事件反查直接命中）。双字段各司其职。

**工作区配置**：用 `tut assign <role> <agent>` 定制项目阵容，或修改上面的 JSON 示例并保存到 `.context-hub/workspace.json`（项目级）或 `~/.config/tut/workspace.json`（用户级，先创建父目录）。`tut up` 检测 L1/L2 均缺时指向本文档。读取时忽略 `label` 字段，运行时不读取 `scripts/routes.json`。

**从旧版种子升级**：已有的项目级或用户级 workspace 文件继续有效，无需迁移。若只修改了安装包里的示例，请在升级前把定制后的 JSON 保存到上述配置位置。自动化脚本若仍复制包内示例，应改为使用自行维护的配置或 `tut assign`；安装包不再附带种子文件。

### ③ 调用参数 — CLI flags 与环境变量

| 参数 | 作用于 | 缺省 |
|---|---|---|
| `--port <n>` | `tut serve` 的监听端口 | `3001` |
| `--url <u>` | Hub 地址覆盖（`tut up` 与上下文/审批命令；仅接受 loopback + 显式端口的地址） | `http://127.0.0.1:3001` |
| `--interval <s>` / `--event-port <p>` / `--stall-timeout <m>` | `tut notify` 的轮询间隔 / Agent 事件端口 / stall 超时（`--event-port` 同时决定 `tut up` 探测与供给的端口；轮询间隔下限 1s） | `5s` / `3002` / `30min` |
| `--working-timeout <s>` | `tut notify` 的 launch → working 短引信；超时未收到 working 信号时告警 | `300s` |
| `--root <dir>` | `tut serve` 的存储根目录；`tut up` / `tut down` 的 rig 根目录（拥有 `.context-hub` 的目录），缺省取 cwd 所在 rig | 当前目录 |
| env `TUT_UP_CLI_SELF` | `tut up` 供给 panes 或 standalone 服务时用的自身 CLI 路径 | 自动解析（dist 布局） |
| env `TUT_SPLIT_BASE` | birth 锚定逃生舱：无 tut-hub/tut-notify pane 可达时，以该 pane 的（workspace, cwd）锚定新 pane 诞生 | 自动解析 |
| env `TUT_PROJECT_ROOT` | 工作区链 L1 根覆盖：指定启动器读哪个项目的 `.context-hub/workspace.json`（缺省取锚点 pane 的 cwd） | 自动解析 |
| env `TUT_USER_CONFIG_DIR` | 工作区链 L2 目录覆盖（缺省 `~/.config/tut`） | 自动解析 |

另有一次性环境态配置：Herdr 事件接线插件（见 [Herdr 事件接线](#herdr-事件接线)）。

## 开发

依赖清单见 [package.json](package.json)：运行时依赖为 @modelcontextprotocol/sdk + zod（显式声明，保证与 SDK 共享同一 zod 实例），此外无其他运行时依赖。

```bash
npm install        # 安装依赖
npm test           # 跑测试（vitest）
npm run typecheck  # 类型检查
npm run build      # 编译到 dist/
```

Agent 角色的行为指令在 [skills/](skills/) 目录（architect / executor / reviewer / host，行为模板而非身份绑定——任何 Agent 加载后都能干这类活）。

## 文档

- [design/system-design.md](design/system-design.md) — **系统设计（根文档）**：宿主无关核心与宿主契约
- [design/context-design.md](design/context-design.md) — **上下文设计**：放什么（scope / 记录类型 / 正文内容要求）、怎么管理
- [design/herdr-host.md](design/herdr-host.md) — **Herdr 宿主**：pane、电源、hook、终端投递与 Enter 补救
- [design/standalone-host.md](design/standalone-host.md) — **Standalone 宿主**：服务电源、run、detached 发车、续跑、座位与 preflight

## 故障排查与已知限制

### Windows 说明

Standalone 电源（`tut config set power.mode standalone`）通过 Node 启动 detached Hub / Notifier，无需 Herdr。要求 PowerShell 5.1+ 及 CIM / NetTCPIP provider，用于创建时间 token 与 TCP 监听者核验。`power.json` 保存 `process_scope: "windows-tree"`、`pgid: null`；`up` / `doctor` 报告未注册服务，`up --adopt` 显式核验并采纳同 workspace 监听者（`--dry-run` 仅预览）。

Windows `down` 用原生进程 handle 核验创建身份并强制终止捕获到的服务树，排除已登记 run 根 / supervisor 及启动中的 run supervisor，最后复验端点。每项服务的完成事实单独保存，允许部分失败后重试。**已知缺口（documented-gap）**：没有 Job Object 容器或 POSIX 信号宽限期。捕获前 leader 已亡、身份不可读或 run 元数据损坏时拒绝清理；捕获前已孤儿化或在快照间逃逸的后代无法保证回收。Windows run / 发车实现属于独立能力，本电源支持不启用它们。

原生 Windows 端到端可用（hub、MCP、CLI、流转驱动均已对照 Herdr Windows 版与 PowerShell 5.1 验证）。安装边界须知：

- **npm 安装的 agent CLI 以 `.cmd` shim 形态存在**，TUT 出于加固考虑不执行 shim。请将角色指向 direct Node entry 路由，例如 `tut assign executor node "%APPDATA%/npm/node_modules/@openai/codex/codex.js"`，或使用带原生可执行文件的 agent
- 若 PowerShell 执行策略拦截 script block（`tut up` 通过向 pane 键入命令来供给），先执行一次 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
- `tut up` 需要存在当前 pane 上下文（交互式 Herdr pane 内运行，或 `HERDR_PANE_ID` 指向有效 pane id）；无头运行会失败，报错中会点名原因，并给出 standalone 逃生口（`tut config set power.mode standalone` 改为供给 detached 进程，不依赖 herdr，`tut down` 关停）
- Windows 桌面通知通过 PowerShell 使用原生 toast；若 PowerShell 或 toast API 不可用，TUT 会降级为终端响铃。已知边界：系统通知被抑制时（如专注助手/勿扰模式），toast 静默不显示——Windows 不会向 TUT 报错
- 每次尝试发送 toast 时，TUT 都会刷新 `HKCU` 下的用户级 AppUserModelID 注册；无需管理员安装步骤
- Herdr 的 Windows zip 依赖 VC++ 运行库（`vc_redist.x64`）——缺失时二进制静默退出

**排障**：

- **Agent 说看不到 context.* 工具**：在目标 workspace 执行 `tut status` 确认所属 Hub 可达；确认 MCP 配置在正确 workspace 运行 `tut mcp`（或钉定 `TUT_HUB_ROOT`）；个别 CLI 会话可能被沙箱挡住 localhost 回连——此时让该 Agent 改用 CLI 通道（`tut read` / `tut publish`），行为完全等价
- **3001 端口被占用（EADDRINUSE）**：在目标 workspace 运行 `tut up`。它会验证 Hub 归属，发现该 workspace 的既有本地 Hub；默认端口对被占用时，从 3003/3004 起选择空闲端口对供给自己的 Hub/notifier。普通 CLI 也会发现所属 Hub；显式 `--url` 指向 foreign Hub 会被拒绝。手工指定地址可用 `tut serve --port <n>` 与 `--url`，挪事件端口用 `--event-port`（Hub 与事件端口不能相同）。复用 Hub 不代表 notifier 在相邻端口：`up` 通过 notifier 的 `hub_root` 与 `hub_url` 确认归属，保留 3101/3002 及自动分配的端口对。复用 notifier 要求其报告身份字段；移动事件端口前先停止已有 notifier。
- **启动锁错误**：`another up (pid N) is provisioning` 表示应等待该次启动完成；只有确认没有其它 `tut up` 实例在运行后，才可删除提示中的 `.context-hub/up.lock` 并重试。`cannot verify startup lock` 可能是锁文件损坏，也可能撞上初次写入的竞态：先重试；若持续失败，检查锁内容并确认没有其它 `tut up` 在运行后再删除。`startup lock recovery in progress` 表示另一个实例正在接管陈旧锁：先重试；若接管已中断，检查提示中的 `.context-hub/up.lock.reclaim` 目录，仅在确认没有其它 `tut up` 在运行后删除该目录。
- **工作区阵容存储**：阵容存于项目（`.context-hub/workspace.json`）或用户级（`~/.config/tut/`），升级不动它们。工作区解析链见[配置](#配置)

**已知限制**（设计取舍，非 bug）：

- 角色变更必诞生全新 pane/session（`<task_id>.<role>`，锚定 hub 所在 workspace/cwd，由生命周期钩子在下一轮交接或 `tut decide close` 时回收）；同任务同角色连续轮（revision、re-review）则延续现存同角色 pane——只投递不收割不新生：上下文仍只经 Hub 流动、不越过角色边界，且免全量重读。同角色想要外部视角？`tut start-next --fresh` force-close 工位（含 working）后照常新生。同轮重复启动被 launch note 拒绝（ALREADY_LAUNCHED；用 `tut start-next --force` 恢复）
- 任务未经 decide close 即放弃时 pane 会遗留（无自动孤儿回收）；手工关闭或由后续生命周期钩子收尾
- Notifier 按轮询粒度观察状态：轮询窗口内的中间态不被观察（版本号可见跳变）；状态以记录重放为准，任何中间态都可从日志复原
- auto 模式下 decision 记录无法密码学验证「确实来自人」——当前靠通知审计 + by 字段追溯兜底，更结构化的解法留待多机部署场景

## Credits

Agent 承载由 [Herdr](https://github.com/herdrdev/herdr) 驱动——运行时前置、独立安装；本包不分发其代码。

## License

[Apache-2.0](LICENSE)
