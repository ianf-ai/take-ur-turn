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
- **流程变体**：建任务时选 `--flow full|direct|solo`——full 走完整循环；direct 跳过设计阶段（repo 已有设计）；solo 小改动免审不免批（跳过 review，直达审批）
- **manual / auto 流转**：manual（默认）该谁动时通知人，人按键启动下一个；auto 模式 Notifier 经启动器直接拉起下一个 Agent（按 role 白名单分级信任），人只做 decide；无论哪档，都可由 coding-agent Host 会话代你跑全程（见下文会话代驾）

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

前置：Node.js ≥ 20、Herdr（Agent Host，承载各 Agent 的终端 pane；`brew install herdr` 安装，项目主页 https://github.com/herdrdev/herdr ）、至少一个 coding agent CLI。**平台：仅 macOS / Linux**（启动器为 POSIX shell；Herdr 的 Windows 支持尚在 beta）。

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

**发起一个任务**（发起侧两步——任务先于投递存在，首轮即普通轮）：

```bash
tut create --title "mode 子命令补 --url flag" \
           --description "给 CLI 的 mode 子命令补一个 --url flag。\
验收：flag 贯通到 Hub 调用；两种 flag 形式均有测试。" \
           --creator <你的名字> --role human
tut start-next <task_id>   # manual：投首轮（auto 模式：Notifier 按白名单自动投递）
```

`create` 的流程（`--flow full|direct|solo`）与任务级阵容（`--cast executor=pi,reviewer=codex`）是真旗子；需求与验收口径写在 `title` + `description` 里，Agent 经 `context.read` 自取。

之后 Agent 在各自 pane 里经 MCP 工具读写 Hub 推进任务；`tut status` 看总览，该人审批时 Notifier 会通知你，`tut decide <task_id> --decision approve --by <你的名字>` 拍板。

Notifier 的辅通道（blocked 即时告警、done 交叉验证）依赖 Herdr 把 pane 内 Agent 的状态变化投给 `scripts/on-agent-event.sh`——这是一次性的环境配置（Herdr 插件），见 [design/system-design.md](design/system-design.md) 7.2 节的接线说明。

## 会话代驾（Host 模式）

上面的快速上手是手动路径——其实除了 `tut up`，你不必再碰终端：在项目里开一个交互式 coding-agent 会话（任何能读仓库、能跑 shell 命令的 CLI agent），让它加载 [skills/host.md](skills/host.md)——它就担任 **Host** 角色，你的主会话驱动者。你负责说话，Host 负责环境检查、把你的诉求磨成任务（`tut create`，需求+验收）、轮次交接代按 `tut start-next`、盯状态，到审批门带着三件套回来找你：改了什么、验证结果、它自己的抽查意见。

对话大致长这样：

> 你：「盯完这个任务：给 mode 子命令补个 --url flag。」
> ……Host 建任务、推轮次、盯状态……
> Host：「review pass。改动 2 个文件 +12/−3，测试全绿；我抽查了 diff，无异议。批吗？」

发起时一句委托（「盯完这个任务」）即授权整个推进循环；审批永远归你——Host 只呈现、不代批，每次 `tut decide` 都凭你的明确同意才执行。auto 模式下轮次交接由 Notifier 接手，Host 的重心移到审批门与异常处置。

守住分工的边界是**驱动不代工**——Host 不写 design / code_changes / review / revision 记录，这些只出自 architect / executor / reviewer 各自 pane 里的会话。（Host 角色与架构表里的「Agent Host」无关——后者指 Herdr，承载 Agent 的终端环境。）

## Agent CLI 接入（一次性）

Hub 以 **Streamable HTTP** 暴露 MCP 工具，端点 `http://127.0.0.1:3001/mcp`（`tut serve` 起来后即在线；stateless 形态，无会话流）。每个要参与协作的 Agent CLI 配置一次：

**Codex CLI**（`~/.codex/config.toml`）：

```toml
[mcp_servers.tut]
url = "http://127.0.0.1:3001/mcp"
```

其他支持 Streamable HTTP 的 MCP 客户端：配置同一 URL 即可。

配好后 Agent 会看到 5 个工具：`context.create` / `context.publish` / `context.read` / `context.list` / `context.decide`。

**不支持 MCP over HTTP 的 CLI**：走等价的 CLI 通道——`tut create / publish / read / list / decide` 子命令与 MCP 工具一一对应，Agent 经 shell 调用即可（skills 里各角色的「工具速查」表（MCP | CLI 对照）就是为这类 CLI 准备的；两类通道可混用，同一任务里各角色各走各的通道完全兼容）。

**无 MCP 配置能力的环境**（如某些会话的沙箱限制）：同上走 CLI 通道兜底。

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
tut create --title <t> --description <d> --creator <c> --role <r> [--flow <full|direct|solo>] [--cast <role=agent,...>] [--url <u>]
tut publish <task_id> --role <r> --content-type <t> --summary <s>
             (--body <text> | --payload-file <md>)
             [--verdict <pass|fail_code|fail_design>] [--commits <a,b>]
             [--ref-version <n>] [--expected-version <n>] [--agent <a>] [--model <m>] [--url <u>]
tut read <task_id> [--since-version <n>] [--json] [--url <u>]
tut list [--status <s>] [--json] [--url <u>]
tut decide <task_id> --decision <approve|reject|close> --by <b> [--reason <text>] [--url <u>]
tut assign <role> <agent>
tut up [--url <u>] [--dry-run]
tut ack <task_id> [--note <text>] [--url <u>]
tut status [--json] [--url <u>]
```

Agent 侧的等价通道是 5 个 MCP 工具（`context.create` / `context.publish` / `context.read` / `context.list` / `context.decide`），CLI 子命令与之一一对应。

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

- **direct**：repo 已有现成设计，跳过设计阶段——建任务即 implementing；review 与人审批照常
- **solo**：小改动免审——跳过 review，code_changes 直接派生 pending_approval 由人 approve / reject。免审不免批：approve 仍是人的门

## 配置

三层配置面，性质不同、位置不同：

### ① 项目运行时配置 — `.context-hub/config.json`（gitignored，每个项目一份）

Hub 与 Notifier 的行为。改后下个轮询周期生效，无需重启：

| 键 | 作用 | 缺省 |
|---|---|---|
| `flow_mode` | `"manual"` / `"auto"`——轮次交接时谁按启动键（人 / Notifier 经启动器自动启动）。推荐用 `tut mode <manual\|auto>` 切换 | `manual` |
| `notify` | 通知渠道：`channels`（desktop / webhook 等）与 `webhook_url` | 未配置 = 终端 bell 与 notify pane 日志 |
| `auto.launch_roles` | auto 模式的启动白名单（按 role 键控，如 `["executor","reviewer"]`）。**缺省空 = 全部回落通知人**——不在白名单的轮次不自动启动、不落启动痕，人的手动启动不受影响 | `[]` |

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

`naming.tab_label` 渲染**tab** 标签（人读侧）：占位符 `{role}` / `{task}` / `{agent}`，未知占位符原样保留，默认 `TUT {role}`。**pane** 标签是机器寻址键、不可模板化：轮次 pane 恒为 `<task_id>.<role>`（事件反查直接命中）。双字段各司其职。

仓库内 `scripts/workspace.json` 退役为**种子**（形状示例）——运行时零读取。`tut up` 检测 L1/L2 均缺时打印一次性迁移提示。

**从旧分发文件迁移**：`cp scripts/workspace.json .context-hub/workspace.json`（或放 `~/.config/tut/`，先 `mkdir -p`）→ `label` 字段可留可删（读侧容忍）→ `scripts/routes.json` 直接删（已无人读）→ 此后 `tut assign` 改项目级文件。

### ③ 调用参数 — CLI flags 与环境变量

| 参数 | 作用于 | 缺省 |
|---|---|---|
| `--port <n>` | `tut serve` 的监听端口 | `3001` |
| `--url <u>` | Hub 地址覆盖（`tut up` 与上下文/审批命令；仅接受 loopback + 显式端口的地址） | `http://127.0.0.1:3001` |
| `--interval <s>` / `--event-port <p>` / `--stall-timeout <m>` | `tut notify` 的轮询间隔 / Agent 事件端口 / stall 超时 | `5s` / `3002` / `30min` |
| `--working-timeout <s>` | `tut notify` 的 launch → working 短引信；超时未收到 working 信号时告警 | `300s` |
| `--root <dir>` | `tut serve` 的存储根目录 | 当前目录 |
| env `TUT_UP_CLI_SELF` | `tut up` 供给 panes 时用的自身 CLI 路径 | 自动解析（dist 布局） |
| env `TUT_SPLIT_BASE` | birth 锚定逃生舱：无 tut-hub/tut-notify pane 可达时，以该 pane 的（workspace, cwd）锚定新 pane 诞生 | 自动解析 |
| env `TUT_PROJECT_ROOT` | 工作区链 L1 根覆盖：指定启动器读哪个项目的 `.context-hub/workspace.json`（缺省取锚点 pane 的 cwd） | 自动解析 |
| env `TUT_USER_CONFIG_DIR` | 工作区链 L2 目录覆盖（缺省 `~/.config/tut`） | 自动解析 |

另有一次性环境态配置：Herdr 事件接线插件（见[快速上手](#快速上手)末段的接线说明）。

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

- [design/system-design.md](design/system-design.md) — **系统设计（当前有效）**：架构、状态派生规则、MCP 工具 schema、模块契约、技术选型
- [design/context-design.md](design/context-design.md) — **上下文设计**：放什么（scope / 记录类型 / payload 信封与 body 模板）、怎么管理

## 故障排查与已知限制

**排障**：

- **Agent 说看不到 context.* 工具**：确认 `tut serve` 在跑（`curl http://127.0.0.1:3001/state` 有响应即活）；确认该 CLI 的 MCP 配置指向 `/mcp` 端点；个别 CLI 会话可能被沙箱挡住 localhost 回连——此时让该 Agent 改用 CLI 通道（`tut read` / `tut publish`），行为完全等价
- **3001 端口被占用（EADDRINUSE）**：`tut serve --port <n>` 换端口，其余命令以 `--url` 指向新地址（`tut up` 的供给探测同指向）
- **`npm i -g` 后自定义的阵容丢了**——已解决：阵容存于项目（`.context-hub/workspace.json`）或用户级（`~/.config/tut/`），升级不动它们。迁移步骤见[配置 ②](#-工作区阵容--三级解析链项目--用户--内置)

**已知限制**（设计取舍，非 bug）：

- 角色变更必诞生全新 pane/session（`<task_id>.<role>`，锚定 hub 所在 workspace/cwd，由生命周期钩子在下一轮交接或 `tut decide close` 时回收）；同任务同角色连续轮（revision、re-review）则延续现存同角色 pane——只投递不收割不新生：上下文仍只经 Hub 流动、不越过角色边界，且免全量重读。同角色想要外部视角？`tut start-next --fresh` force-close 工位（含 working）后照常新生。同轮重复启动被 launch note 拒绝（ALREADY_LAUNCHED；用 `tut start-next --force` 恢复）
- 任务未经 decide close 即放弃时 pane 会遗留（无自动孤儿回收）；手工关闭或由后续生命周期钩子收尾
- Notifier 按轮询粒度观察状态：轮询窗口内的中间态不被观察（版本号可见跳变）；状态以记录重放为准，任何中间态都可从日志复原
- auto 模式下 decision 记录无法密码学验证「确实来自人」——当前靠通知审计 + by 字段追溯兜底，更结构化的解法留待多机部署场景

## Credits

Agent 承载由 [Herdr](https://github.com/herdrdev/herdr) 驱动——运行时前置、独立安装；本包不分发其代码。

## License

[Apache-2.0](LICENSE)
