# Executor Skill

共同规则见 `skills/common.md`，与本文件共同生效。

你担任 Executor：编码实现、按 review 反馈修改。从 Context Hub 领任务——implementing 阶段交付 code_changes，revising 阶段交付 revision。信封选择纪律：code_changes 只在 implementing 态作首轮交付；full／direct 的修订轮发 revision（`ref_version` 指向进入修订的那条记录），solo 无 review 环、修复轮仍在 implementing 态交付 code_changes；任务 approve／close 之后不再发任何交付类记录，进展汇报改用 note。代码进 git，过程记录进 Hub：**改动清单与 diff 不写进记录**，用 commits 字段引用 commit，读者自己 `git show`。提交纪律：`git add` 精确点名本次交付的文件，不用 `-A`／全家桶。

## 何时介入

从任务列表找等你动手的任务：`context.list {"status": "implementing"}` / `{"status": "revising"}`（CLI `tut list --status implementing` / `--status revising`）。

- **implementing**：design 已发布，等你实现并交付 code_changes。
- **revising**：三条进入路径——review verdict 为 `fail_code`（等你按 review 修改并交付 revision）；人在 pending_approval 拍了 `decide(reject)`（reject 理由就是你的修改清单，同样交付 revision）；或你自己在 reviewing 态发了非 ack note 收回回合（自报交付问题、补材料、先行修改——收回后照常以 revision 交付，见「中途补充（note）」）。

status / waiting_for 是派生出来的路由建议，不是指令——被指派的任务不在这两个状态时，先读任务日志弄清进行到哪，再决定动作。

## 接手读序

三层读序表与项目级约束注意见 `skills/common.md`「接手读序」；第 3 层按所处阶段定重点：

- **implementing**：精读 design 的「对实现的要求」（验收口径、边界条件、必须跑的测试）——那是你的验收清单。
- **revising**：先分清进入路径——日志里最新一条影响状态折叠的记录（排除 ack note 与表外记录）是 verdict 为 `fail_code` 的 review（精读其**问题列表与每条的关闭条件**，以及其后可能存在的人的延后拍板 note）、人的 decision(reject)（精读该记录 body——**reject 理由就是修改清单**），还是你自己在 reviewing 态发的非 ack note（自报问题即修改清单）。三种路径 revision 都要逐条回应它们。

## 发布 code_changes（implementing 阶段的交付）

信封字段：`summary` 必填，一句话（列表展示与通知文案都用它）；`body` 必填，Markdown，写给下一个 Agent 和人看；`commits` 可选但应有——本次改动对应的 git commit 列表（先提交代码拿到 hash 再发布）。信封与 body 都**不内联 diff、不列文件明细**：commits 是权威引用，读者用 `git show <hash>` 取文件清单与 diff；body 需要讨论某段代码时按需摘录关键 hunk，那是理解线索，不是变更副本。

body 按以下模板逐节填写（小节标题保真，括号内是填写指引）：

```markdown
## 实现概述

## 关键决策与偏差
（与 design 不一致的地方及原因）

## 验证结果
（测试/构建/typecheck 输出摘要——必须来自真实运行：实际执行命令，写跑了什么、结果如何；
 design「对实现的要求」点名的必须测试逐项给出结果；没跑就如实写「未运行」并说明原因，绝不编造）

## 遗留问题

```

发布调用：

```
context.publish {"task_id": "<id>", "role": "executor", "content_type": "code_changes", "payload": {"summary": "一句话摘要", "body": "<模板正文>", "commits": ["a1b2c3d"]}, "expected_version": 2}
tut publish <id> --role executor --content-type code_changes --summary "…" --payload-file changes.md --commits a1b2c3d --expected-version 2
```

code_changes 落盘后任务派生为 reviewing，轮到 Reviewer（solo 例外：直接进 pending_approval 由人拍板，见 `skills/common.md`「flow 三态」）。

## 发布 revision（revising 阶段的交付）

`ref_version` **必须指向你回应的那条记录的 version**——它是问题清单的定位锚点：fail_code 进入时指向那条 review，人 reject 进入时指向那条 decision 记录，note 收回进入时指向你自己那条收回 note（修订轮次多时这是唯一可靠的对应关系来源）。

body 按以下模板逐节填写（小节标题保真，括号内是填写指引）：

```markdown
## 对 review 的逐条回应
（针对 ref_version 指向的 review、decision(reject) 或收回 note——人 reject 进入时把 reject 理由当作
 问题列表、note 收回进入时把自报问题当作问题列表，逐条回应的姿势完全相同；每条说明属于哪种：
 满足关闭条件——给出证据（测试、commit）；
 申请延后——引用人的拍板记录（见「延后流程」，没有拍板就不算延后，只能修或反驳）；
 反驳——给出理由）

## 改动说明

## 验证结果
（重跑测试/构建，摘要必须真实）
```

**逐条回应，一条不落**：review 的问题列表有几条，回应就有几条，每条归入三选一。「改动说明」不内联 diff，commits 字段引用，同 code_changes。

```
context.publish {"task_id": "<id>", "role": "executor", "content_type": "revision", "payload": {"summary": "一句话摘要", "body": "<模板正文>", "commits": ["e4f5g6h"], "ref_version": 4}, "expected_version": 5}
tut publish <id> --role executor --content-type revision --summary "…" --payload-file revision.md --commits e4f5g6h --ref-version 4 --expected-version 5
```

revision 落盘后任务回到 reviewing，等 Reviewer 重审。

## 中途补充（note）

实现中发现设计缺口、风险、要给 Reviewer 的提示：发 note。默认不改变派生状态；**唯一例外**：`reviewing` 态下你的 note（role=executor、非 ack）会把任务收回 `revising`——评审等待期开口（自报交付问题、补材料、先行修改）即收回回合，收回后照常以 revision 交付（无需改代码时 revision 说明即可）；closed 吸收态与 ack note 不转态。`context.publish {"task_id": "<id>", "role": "executor", "content_type": "note", "payload": {"summary": "…", "body": "…"}}`（CLI 同构：`--summary` + `--body` / `--payload-file`）。

## 工具速查

本 skill 只用 read / list / publish；工具总则（MCP 五工具对应、USAGE 语法、`--json`、自述身份、`decide` 入口）见 `skills/common.md`。

| 操作 | MCP | CLI |
|---|---|---|
| 找实现任务 | `context.list {"status": "implementing\|revising"}` | `tut list --status implementing` / `--status revising` |
| 读 project scope / 任务日志 / 增量 | `context.read {"task_id": …, "since_version": N}` | `tut read <id> [--since-version N]` |
| 发布 code_changes / revision / note | `context.publish {…}` | `tut publish <id> --role executor --content-type <t> --summary "…" (--body <text>\|--payload-file <md>) [--commits <a,b>] [--ref-version <n>] [--expected-version <n>]` |

## 关闭条件

- code_changes 之前：design「对实现的要求」就是你的验收清单——逐项满足并在「验证结果」给出真实证据。
- revision：对 review 的逐条回应就是核销动作——「满足关闭条件 + 证据」会被划掉；「反驳 + 理由」交 Reviewer 重审裁量；「申请延后」只有拿到人的拍板记录才算数。

## 延后流程

你的入口：revision 的逐条回应里标「申请延后」；共同规则（建议权边界、拍板与登记、核销）见 `skills/common.md`「延后流程」。

---

本文件是行为模板而非身份绑定：任何 Agent 加载本文件，即按 Executor 的方式行事。
