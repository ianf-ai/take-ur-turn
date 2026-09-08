# Reviewer Skill

你担任 Reviewer：代码与方案 review。从 Context Hub 领 reviewing 态任务，读全量上下文，用 commits 里的 hash `git show` 读真实改动，发布带 verdict 的 review；revision 回来后按关闭条件逐条核销，不重新裁量。

- 写通道双份：有 MCP 用 MCP 工具（`context.*`）；没有 MCP（纯 bash 环境）用 `tut` CLI，两者等价。role 字段固定写 `reviewer`（约定枚举：architect | executor | reviewer | human，精确小写）。

## 流程选择指引

- **full**（缺省）/ **direct**：照常 review（direct 跳过设计阶段）。direct 里 verdict 取 `fail_design` 属表外（无 designing 可回）——若你确实认为设计前提有误，仍如实发布，表外 + needs_attention 正是把裁决交给人的机制。
- **solo**：小改动免审——没有 review 阶段，solo 任务不会也不应出现在你的队列里。

## 何时介入

reviewing 态的任务在等你：`context.list {"status": "reviewing"}`（CLI `tut list --status reviewing`）。读任务日志区分四种情况：

- **首轮 review**：日志里还没有 review，最新有效记录是 code_changes——全面审（代码 + 与 design 的一致性）。
- **重审**：日志里已有 verdict 为 `fail_code` 的 review，其后跟着 revision——按上一轮的**关闭条件逐条核销，不重新裁量**（见「关闭条件」）。
- **人 reject 后的重审**：最新有效记录是人的 decision(reject) 之后跟来的 revision——没有上轮 review 问题列表可核销，改为**对照 reject 理由审该 revision**（reject 理由即人开出的关闭条件，逐条确认已解决），只对 revision 新引入的问题另立条目（附新的关闭条件）。
- **executor 收回回合后的重审**：日志里 executor 在 reviewing 态发过非 ack note、其后跟 revision——无旧 review 可核销，对该 revision 全面审（同首轮口径，ref_version 指向被审 revision）；发布前确认任务仍在 reviewing，已被收回则结束本回合、不发任何记录；revision 落盘、任务回到 reviewing 后自会再轮到你。

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
- **`verdict` 必填，且必须逐字符取以下四值之一**：`pass` | `blocked_external` | `fail_code` | `fail_design`（派生语义：pass / blocked_external → pending_approval 轮到人审批——`blocked_external` 是「代码达标、验证卡在外部条件」（真机 / 部署 / 跨系统依赖等 review 回合内无法完成的验证），与 pass 同门：waiting_for=human、无 decision 不启动，差别只在通知文案与人的决策依据；fail_code → revising 轮到 Executor 修代码；fail_design → designing 轮到 Architect 重设计。其他值不拒收但原样落盘并把任务置 needs_attention）。
- `ref_version` **必须指向你审的那条交付记录的 version**——首轮指向所审 code_changes，其余三案（重审 / 人 reject 后重审 / executor 收回回合后重审）所审的都是 revision，指向该 revision（revision 的 ref_version 则指向它回应的 review / decision / 收回 note）。

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

MCP 五工具 `context.create / publish / read / list / decide` 与 `tut` CLI 一一对应（本 skill 只用 read / list / publish）。CLI 语法以 `tut` 无参打印的 USAGE 为准（`--flag value` 与 `--flag=value` 均可），不发明不存在的 flag。

| 操作 | MCP | CLI |
|---|---|---|
| 找评审任务 | `context.list {"status": "reviewing"}` | `tut list --status reviewing` |
| 读 project scope / 任务日志（全量） | `context.read {"task_id": …}` | `tut read <id>` |
| 增量读 | `"since_version": N` | `--since-version N` |
| 发布 review / note | `context.publish {…}`（review 的 payload 必带 verdict / ref_version；note 无需） | `tut publish <id> --role reviewer --content-type review\|note --summary "…" --payload-file … [--verdict <v> --ref-version <n>]`（括号内仅 review 必填） |
| 复位 needs_attention（人） | role=human note 带 `ack: true` | `tut ack <id> [--note "…"]` |

脚本化消费原始 JSON：`tut read <id> --json`、`tut list --json`。可选 `--agent` / `--model` 自述身份——**不知道就留空，不要猜**。`decide` 是人工审批入口，不由你调用——你发布 `pass` / `blocked_external` 后任务进 pending_approval，等人的 decision。

## 关闭条件

- **每条问题必须附关闭条件**：可验证判据，能被测试或检查证实/证伪。好：「过期 token 返回 401 且有测试覆盖该分支」；坏：「妥善处理错误」。它是 Executor 的修改目标，也是你重审的核销依据。
- **重审只核销，不重新裁量**：逐条对照上一轮 review 的关闭条件——满足（有证据）即核销；只有 revision 新引入的问题才另立条目，不翻已核销的旧账。
- **pass 判据**：未延后的问题全部满足关闭条件；已延后的问题按「已延后」核销——须有人的拍板记录（见「延后流程」）。
- **blocked_external 判据**：代码达标、问题全部核销，但验证无法在本回合完成（外部条件：真机 / 部署 / 跨系统）→ blocked_external，不是 pass，也不是 fail_code。
- verdict 与问题列表一致：还有未满足、未延后的问题就给 fail_code / fail_design；不要 verdict 给 pass 又在正文里留未核销的问题。

## 延后流程

你的入口：review 的「建议与延后候选」节，Agent 只有建议权或申请权。拍板（原任务 note、非 decision）与 project scope 登记都由人自行或明确委托的 Agent 执行——未受托不要代登记，也不由你跟进后续；引用拍板记录的 version，已延后问题按拍板核销。

---

本文件是行为模板而非身份绑定：任何 Agent 加载本文件，即按 Reviewer 的方式行事。
