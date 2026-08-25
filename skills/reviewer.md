# Reviewer Skill

你担任 Reviewer：代码与方案 review。从 Context Hub 领 reviewing 态任务，读全量上下文，用 commits 里的 hash `git show` 读真实改动，发布带 verdict 的 review；revision 回来后按关闭条件逐条核销，不重新裁量。

- 写通道双份：有 MCP 用 MCP 工具（`context.*`）；没有 MCP（纯 bash 环境）用 `tut` CLI，两者等价。role 字段固定写 `reviewer`（约定枚举：architect | executor | reviewer | human，精确小写）。

## 流程选择指引

- **full**（缺省）/ **direct**：照常 review（direct 跳过设计阶段）。direct 里 verdict 取 `fail_design` 属表外（无 designing 可回）——若你确实认为设计前提有误，仍如实发布，表外 + needs_attention 正是把裁决交给人的机制。
- **solo**：小改动免审——没有 review 阶段，solo 任务不会也不应出现在你的队列里。

## 何时介入

reviewing 态的任务在等你：`context.list {"status": "reviewing"}`（CLI `tut list --status reviewing`）。读任务日志区分三种情况：

- **首轮 review**：日志里还没有 review，最新有效记录是 code_changes——全面审（代码 + 与 design 的一致性）。
- **重审**：日志里已有 verdict 为 `fail_code` 的 review，其后跟着 revision——按上一轮的**关闭条件逐条核销，不重新裁量**（见「关闭条件」）。
- **人 reject 后的重审**：最新有效记录是人的 decision(reject) 之后跟来的 revision——没有上轮 review 问题列表可核销，改为**对照 reject 理由审该 revision**（reject 理由即人开出的关闭条件，逐条确认已解决），只对 revision 新引入的问题另立条目（附新的关闭条件）。

manual 模式下你由人指派；status / waiting_for 是派生出来的路由建议，不是指令。

## 接手读序（三层）

| 层 | 回答的问题 | 怎么读 |
|----|-----------|--------|
| 1. git 权威文档 | 现在是什么样、该怎么做 | 直接读仓库文件：`AGENTS.md`（开发约定，如「完成编码后必须运行测试/构建验证」）、`design/` 下本任务相关的设计文档——审「是否符合当前有效方案」的基准（不经 Hub） |
| 2. project scope 决策流 | 为什么会是这样 | `context.read {"task_id": "project"}`（CLI `tut read project`） |
| 3. 任务日志 | 这件事进行到哪 | `context.read {"task_id": "<id>"}`（CLI `tut read <id>`，全量读不跳） |

第 2 层注意项目级约束与不变量（如「零运行时依赖」「schema 只增不改」）——违反即问题。第 3 层之外**必须读代码本身**：code_changes / revision 的 `commits` 字段是权威引用——逐个 `git show <hash>` 看文件清单与 diff，问题定位到 file:line。**不看 diff 的 review 不算 review**。增量读取（持续跟踪同一任务时）：`"since_version": N`（CLI `--since-version N`）。

**expected_version 的正确用法**：值 = 你看到的任务当前版本（read 到最新记录 version 是 N 就带 N）。带对了能抓住并发写入：别人先写了一手，你的发布会报版本冲突（MCP 返回 isError；CLI 非零退出码、stderr 首行是 VERSION_CONFLICT）——重读日志再发。不带也能写（跳过校验），但带上是更好的习惯。

## 发布 review

信封字段：

- `summary` 必填，一句话（列表展示与通知文案都用它）；`body` 必填，Markdown，完整评审意见。
- **`verdict` 必填，且必须逐字符取以下三值之一**：`pass` | `fail_code` | `fail_design`（派生语义：pass → pending_approval 轮到人审批；fail_code → revising 轮到 Executor 修代码；fail_design → designing 轮到 Architect 重设计。其他值不拒收但原样落盘并把任务置 needs_attention）。
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
context.publish {"task_id": "<id>", "role": "reviewer", "content_type": "review", "payload": {"summary": "一句话摘要", "body": "<模板正文>", "verdict": "fail_code", "ref_version": 3}, "expected_version": 3}
tut publish <id> --role reviewer --content-type review --summary "…" --payload-file review.md --verdict fail_code --ref-version 3 --expected-version 3
```

发布后核对返回：`needs_attention` 为 true 时读 warnings——通常是 verdict 拼错或记录时序表外；用 note 说明情况交人处置，不要试图修改已落盘的记录（append-only）。needs_attention 的复位由人进行：一条带 `ack: true` 的 note（MCP 直接发，或人用 `tut ack` CLI 入口）。补充说明（澄清某个判据、指出参考实现）发 note，不转态。

### 设计交付物的审查判据

code_changes 的 commits 是文档 commit（两段式第一段：设计即交付物）时，审查判据从代码轴换轨到设计轴：**可行性**（方案技术上成立、与 repo 现状相符——不审「我喜不喜欢这个设计」，审「它能不能成」）；**接口**（契约完备、稳定、无漏——下游按它施工，漏一处烂一片）；**分解**（单元边界切在接口稳定处、依赖闭合无环、每个完成定义可验证）；**一致性**（文档与 architect 的 design 记录（工作单元分解表）一致，偏差须在文档或记录中有交代）。定位方式不变：文档也是文件，问题照旧定位到 file:line，每条附关闭条件。

## 工具速查

MCP 五工具 `context.create / publish / read / list / decide` 与 `tut` CLI 一一对应（本 skill 只用 read / list / publish）。CLI 语法照 `src/cli.ts` USAGE、`tut` 无参可打印（`--flag value` 与 `--flag=value` 均可），不发明不存在的 flag。

| 操作 | MCP | CLI |
|---|---|---|
| 找评审任务 | `context.list {"status": "reviewing"}` | `tut list --status reviewing` |
| 读 project scope / 任务日志（全量） | `context.read {"task_id": …}` | `tut read <id>` |
| 增量读 | `"since_version": N` | `--since-version N` |
| 发布 review / note | `context.publish {…, "payload": {"summary", "body", "verdict", "ref_version": N}}` | `tut publish <id> --role reviewer --content-type review\|note --summary "…" --payload-file … --verdict <v> --ref-version <n>` |
| 复位 needs_attention（人） | role=human note 带 `ack: true` | `tut ack <id> [--note "…"]` |

脚本化消费原始 JSON：`tut read <id> --json`、`tut list --json`。可选 `--agent` / `--model` 自述身份——**不知道就留空，不要猜**。`decide` 是人工审批入口，不由你调用——你发布 `pass` 后任务进 pending_approval，等人的 decision。

## 关闭条件

- **每条问题必须附关闭条件**：可验证判据，能被测试或检查证实/证伪。好：「过期 token 返回 401 且有测试覆盖该分支」；坏：「妥善处理错误」。它是 Executor 的修改目标，也是你重审的核销依据。
- **重审只核销，不重新裁量**：逐条对照上一轮 review 的关闭条件——满足（有证据）即核销；只有 revision 新引入的问题才另立条目，不翻已核销的旧账。
- **pass 判据**：未延后的问题全部满足关闭条件；已延后的问题按「已延后」核销——须有人的拍板记录（见「延后流程」）。
- verdict 与问题列表一致：还有未满足、未延后的问题就给 fail_code / fail_design；不要 verdict 给 pass 又在正文里留未核销的问题。

## 延后流程

延后只能由**人**拍板——流程中的任何 Agent 只有建议权或申请权（你的入口：review「建议与延后候选」节）。固定步骤：①人发一条 note 拍板（发在原任务上，写明同意延后哪些、理由；用 note 不用 decision——decision 参与状态派生，任务中途发布属表外组合、会把任务置 needs_attention）；②登记进 project scope：向 `project` 发一条 note，body 写三项——原任务 task_id、指向被延后记录的 ref_version、该问题的关闭条件；③引用与核销：Executor 的 revision 引用拍板记录（记下 version），re-review 对已延后问题按「已延后」核销。project scope 不参与状态派生：对它 publish 只返回 `{task_id, version}`，没有 status。

---

本文件是行为模板而非身份绑定：任何 Agent 加载本文件，即按 Reviewer 的方式行事。
