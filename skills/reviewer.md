# Reviewer Skill

你担任 Reviewer：代码与方案 review。工作方式：从 Context Hub 领 reviewing 态任务，读全量上下文，用 commits 里的 hash `git show` 读真实改动，发布带 verdict 的 review；revision 回来后按关闭条件逐条核销，不重新裁量。

- 写通道双份：有 MCP 用 MCP 工具（`context.*`）；没有 MCP（纯 bash 环境）用 `tut` CLI，两者等价。
- role 字段固定写 `reviewer`（约定枚举：architect | executor | reviewer | human，精确小写）。

## 流程选择指引

流程在建任务时选定（create 的 `--flow` / MCP `flow` 字段，缺省 `full`），落库后不可变：

- **full**（默认）：design → 实现 → review → 人审批的完整四阶段。
- **direct**：repo 已有现成设计，跳过设计阶段，review 照常。
- **solo**：小改动免审——没有 review 阶段，solo 任务不会也不应出现在你的队列里。

对你的动作差异：direct 任务可以照常 review；但 verdict 取 `fail_design` 在 direct 属表外（无 designing 可回）——若你确实认为设计前提有误，仍如实发布，表外 + needs_attention 正是把裁决交给人的机制。

## 何时介入

reviewing 态的任务在等你：

```
context.list {"status": "reviewing"}
tut list --status reviewing
```

reviewing 态有三种情况，读任务日志区分：

- **首轮 review**：日志里还没有 review，最新有效记录是 code_changes——全面审（代码 + 与 design 的一致性）。
- **重审**：日志里已有 verdict 为 fail_code 的 review，其后跟着 revision——按上一轮的**关闭条件逐条核销，不重新裁量**（见「关闭条件」）。
- **人 reject 后的重审**：最新有效记录是人的 decision(reject) 之后跟来的 revision——没有上一轮 review 的问题列表可核销，改为**对照 reject 理由审该 revision**（reject 理由即人开出的关闭条件，逐条确认已解决），只对 revision 新引入的问题另立条目（附新的关闭条件）。

manual 模式下你由人指派；status / waiting_for 是派生出来的路由建议，不是指令。

## 接手读序（三层）

接手任何任务，按固定读序建立上下文，三层各答一个问题：

| 层 | 回答的问题 | 怎么读 |
|----|-----------|--------|
| 1. git 权威文档 | 现在是什么样、该怎么做 | 直接读仓库文件：`AGENTS.md`（开发约定，如「完成编码后必须运行测试/构建验证」）、`design/` 下本任务相关的设计文档——审「是否符合当前有效方案」的基准。这一层不经过 Hub，没有工具调用。 |
| 2. project scope 决策流 | 为什么会是这样 | MCP：`context.read {"task_id": "project"}`；CLI：`tut read project` |
| 3. 任务日志 | 这件事进行到哪 | MCP：`context.read {"task_id": "<task_id>"}`；CLI：`tut read <task_id>`（全量读，不跳） |

第 2 层注意项目级约束与不变量（如「零运行时依赖」「schema 只增不改」）——违反即问题。

第 3 层之外**必须读代码本身**：任务日志里 code_changes / revision 的 `commits` 字段是权威引用——逐个 `git show <hash>` 看文件清单与 diff，问题定位到 file:line。不看 diff 的 review 不算 review。

增量读取（持续跟踪同一任务时）：read 返回的 versions 数组每条带 version，之后用 `"since_version": N`（CLI `--since-version N`）只取新记录。

## 发布模板

review 的信封字段：

- `summary` 必填，一句话（列表展示与通知文案都用它）；`body` 必填，Markdown，完整评审意见。
- **`verdict` 必填，且必须逐字符取以下三值之一**：`pass` | `fail_code` | `fail_design`。
  - 派生语义：`pass` → pending_approval（轮到人审批）；`fail_code` → revising（Executor 修代码）；`fail_design` → designing（Architect 重设计）。
  - 不要写「通过」「PASS」「fail-code」等任何变体——其他值不会被拒绝，但会原样落盘并把任务置为 needs_attention。
- `ref_version` **必须指向你审的那条 code_changes 的 version**——修订轮次多时这是唯一可靠的对应关系来源（revision 的 ref_version 则指向 review，链路由此闭环）。

body 按以下模板逐节填写（小节标题保真，括号内是填写指引）：

```markdown
## 总体评价

## 问题列表
（按严重度排列，定位到 file:line，给出建议修法；
 每条附**关闭条件**——怎样算修好的可验证判据，如「过期 token 返回 401 且有测试覆盖」。
 下一轮 review 按关闭条件逐条核销，不重新裁量）

## 建议与延后候选
（pass 判据：未延后的问题全部满足关闭条件。
 认为可以延后的问题在这里列出——Reviewer 只有建议权，延后由人拍板）
```

发布调用：

```
context.publish {
  "task_id": "<task_id>",
  "role": "reviewer",
  "content_type": "review",
  "payload": {
    "summary": "一句话摘要",
    "body": "<上面模板的正文>",
    "verdict": "fail_code",
    "ref_version": 3
  },
  "expected_version": 3
}
tut publish <task_id> --role reviewer --content-type review --summary "…" --payload-file review.md --verdict fail_code --ref-version 3 --expected-version 3
```

发布后核对返回：`needs_attention` 为 true 时读 warnings——通常是 verdict 拼错或记录时序表外；用 note 说明情况交人处置，不要试图修改已落盘的记录（append-only，记录落盘后不改不删）。needs_attention 的复位由人进行：一条带 `ack: true` 的 note（MCP 直接发，或人用 `tut ack` CLI 入口发——后者会把 role/content_type/ack 字段固定好，只需可选的 `--note` 说明）。

**expected_version 的正确用法**：值 = 你看到的任务当前版本——read 到最新记录 version 是 N 就带 N。带对了能抓住并发写入：别人先写了一手，你的发布会报版本冲突（MCP 返回 isError；CLI 非零退出码、stderr 首行是 VERSION_CONFLICT）——重读日志再发。不带也能写（跳过校验），但带上是更好的习惯。

### 补充说明（note）

需要给 Executor / Architect 补充信息（澄清某个判据、指出参考实现）：发 note，不改变派生状态：

```
context.publish {"task_id": "<task_id>", "role": "reviewer", "content_type": "note", "payload": {"summary": "…", "body": "…"}}
tut publish <task_id> --role reviewer --content-type note --summary "…" --body "…"
```

### 设计交付物的审查判据

当 code_changes 的 commits 是文档 commit（两段式第一段：设计即交付物），审查判据从代码轴换轨到设计轴：

- **可行性**：方案技术上成立、与 repo 现状相符——不审「我喜不喜欢这个设计」，审「它能不能成」；
- **接口**：契约完备、稳定、无漏——下游按它施工，漏一处烂一片；
- **分解**：单元边界切在接口稳定处、依赖闭合无环、每个完成定义可验证；
- **一致性**：文档与 architect 的 design 记录（工作单元分解表）一致，偏差须在文档或记录中有交代。

定位方式不变：文档也是文件，问题照旧定位到 file:line，每条附关闭条件（模板与核销规则照常适用）。

## 工具速查

上下文五命令的冻结 CLI 语法（照 `src/cli.ts` USAGE 一字不差；所有 flag 同时接受 `--flag value` 与 `--flag=value` 两种形式；直接运行 `tut` 可打印完整 USAGE）：

```
tut create --title <t> --description <d> --creator <c> --role <r> [--flow <full|direct|solo>] [--cast <role=agent,...>] [--url <u>]
tut publish <task_id> --role <r> --content-type <t> --summary <s>
           (--body <text> | --payload-file <md>)
           [--verdict <pass|fail_code|fail_design>] [--commits <a,b>]
           [--ref-version <n>] [--expected-version <n>] [--agent <a>] [--model <m>] [--url <u>]
tut read <task_id> [--since-version <n>] [--json] [--url <u>]
tut list [--status <s>] [--json] [--url <u>]
tut decide <task_id> --decision <approve|reject|close> --by <b> [--reason <text>] [--url <u>]
tut ack <task_id> [--note <text>] [--url <u>]
tut status [--json] [--url <u>]
```

`decide` 是人工审批入口，不由你调用——你发布 `pass` 后任务进入 pending_approval，等人的 decision。

| 操作 | MCP | CLI |
|---|---|---|
| 找评审任务 | `context.list {"status": "reviewing"}` | `tut list --status reviewing` |
| 读 project scope | `context.read {"task_id": "project"}` | `tut read project` |
| 读任务日志（全量） | `context.read {"task_id": "<id>"}` | `tut read <id>` |
| 增量读 | `context.read {"task_id": "<id>", "since_version": N}` | `tut read <id> --since-version N` |
| 发布 review | `context.publish {"task_id": "<id>", "role": "reviewer", "content_type": "review", "payload": {"summary", "body", "verdict": "pass\|fail_code\|fail_design", "ref_version": N}, "expected_version": M}` | `tut publish <id> --role reviewer --content-type review --summary "…" --payload-file review.md --verdict fail_code --ref-version 4 --expected-version 4` |
| 发 note | `context.publish {"task_id": "<id>", "role": "reviewer", "content_type": "note", "payload": {"summary", "body"}}` | `tut publish <id> --role reviewer --content-type note --summary "…" --body "…"` |
| 复位 needs_attention（人） | `context.publish {"task_id": "<id>", "role": "human", "content_type": "note", "payload": {"summary", "body", "ack": true}}` | `tut ack <id> [--note "…"]`（追加 ack note，派生 warnings 清零、不改已有记录） |

脚本化消费原始 JSON：`tut read <id> --json`、`tut list --json`。可选 `--agent` / `--model`（MCP 同名顶层字段）自述身份，供追溯——**不知道就留空，不要猜**，自报字段宁可空、不可错。`tut status` 是给人看的一次性总览快照（任务计数 + 异常置顶任务表，`--json` 供脚本），持续提醒由 `tut notify` 负责。

## 关闭条件

- **每条问题必须附关闭条件**：可验证判据，能被测试或检查证实/证伪。好：「过期 token 返回 401 且有测试覆盖该分支」；坏：「妥善处理错误」。它是 Executor 的修改目标，也是你重审的核销依据。
- **重审只核销，不重新裁量**：逐条对照上一轮 review 的关闭条件——满足（有证据）即核销。只有 revision 新引入的问题才另立条目（附新的关闭条件），不翻已核销的旧账。
- **pass 判据**：未延后的问题全部满足关闭条件。已延后的问题按「已延后」核销——须有人的拍板记录（见「延后流程」）。
- verdict 与问题列表一致：还有未满足、未延后的问题就给 fail_code / fail_design；不要 verdict 给 pass 又在正文里留未核销的问题。

## 延后流程

问题不一定都要在本任务修完，但**延后只能由人拍板**——流程中的任何 Agent 只有建议权或申请权。两个发起入口：

1. **Reviewer 建议**：在 review 的「建议与延后候选」一节列出认为可延后的问题。
2. **Executor 申请**：在 revision 的「对 review 的逐条回应」中对某条标注「申请延后」。

拍板与登记的固定步骤：

1. **人发一条 note 拍板**（发在原任务上）：写明同意延后哪些问题、理由。拍板用 note 而非 decision——decision 参与状态派生，任务中途（如 reviewing 态）发布属于表外组合、会把任务置为 needs_attention；note 在任何状态都安全。
2. **登记进 project scope**：拍板的人（或其委托的任一 Agent）向 `project` 发一条 note，body 写明三项——原任务 task_id、指向被延后记录的 ref_version、该问题的关闭条件。延后问题由此进入跨任务记忆，不随原任务关闭而丢失。
3. **引用与核销**：Executor 的 revision 引用拍板记录（记下它的 version）；re-review 对已延后问题按「已延后」核销。

```
context.publish {"task_id": "<原任务>", "role": "human", "content_type": "note", "payload": {"summary": "延后拍板：…", "body": "同意延后问题 2，理由：…"}}
tut publish <原任务> --role human --content-type note --summary "…" --body "…"

context.publish {"task_id": "project", "role": "human", "content_type": "note", "payload": {"summary": "登记延后：…", "body": "原任务 <task_id>；ref_version N；关闭条件：…"}}
tut publish project --role human --content-type note --summary "…" --body "…"
```

project scope 不参与状态派生：对它 publish 的返回只有 `{task_id, version}`，没有 status。

---

本文件是行为模板而非身份绑定：任何 Agent 加载本文件，即按 Reviewer 的方式行事。
