# Executor Skill

按 `skills/common.md` 与本文件执行实现、验证和修订。交付选择同时看 flow 与日志历史：full、direct 首轮用 code_changes，修订轮用 revision；full 在 fail_design 后即使回到 implementing，仍用 revision，ref_version 指向打回设计的 review。solo 的 reject 后用 code_changes；approved、closed 后仅用 note。

## 何时介入

1. 查找待实现任务：`context.list {"status":"implementing"}` 或 `{"status":"revising"}`（CLI `tut list --status implementing` 或 `--status revising`）。
2. 若已被指派任务，读取其日志（status 与 waiting_for 仅作路由建议）。
3. 若任务为 approved 或 closed，仅用 note 汇报进展（不进入实现与交付流程）。
4. 若任务仍在进行，按「接手读序」确定本轮工作。

## 接手读序

1. 按 `skills/common.md`「接手读序（三层）」读取上下文。
2. 若 project scope 为空，按 description 接手（首次确认空态即可；full 仍遵循 design）。
3. 若为 implementing，full 读取 design 的「对实现的要求」，direct 读取 description 指针，solo 直接按 description 接手（无需等待 design）。
4. 若日志存在 fail_design 后的新 design，读取打回设计的 review。
5. 若为 revising，定位进入修订的记录（排除 ack note 与表外记录；来源为 fail_code review、人的 decision(reject) 或自己的收回 note）。
6. 若为修订轮，读取所回应记录的问题与关闭条件（reject 理由、自报问题分别作为本轮问题列表）。
7. 若存在后续 human 拍板，读取对应记录。
8. 按授权范围实现本轮要求。
9. 按「关闭条件」核验交付。

## 发布 code_changes（implementing 阶段的交付）

前置条件：implementing 首轮，或 solo 的修复轮；验证已完成。full 的 fail_design 修订回路转「发布 revision」；approved 或 closed 只发 note。

1. 用 `git add <本次文件…>` 暂存交付文件（不用 `-A` 或全量暂存）。
2. 提交本次改动。
3. 按以下模板填写 body（所有小节标题保真）。
4. 按 `skills/common.md`「记录信封」发布 code_changes（commits 引用本次提交）。

```markdown
## 实现概述

## 关键决策与偏差
（填写相对 design 的偏差及原因。）

## 验证结果
（结果必须来自真实运行，绝不编造。逐项填写实际执行的测试、构建、typecheck 命令及结果；包含 design 指定验证。
 未运行的项注明「未运行」及原因。）

## 遗留问题

```

调用示例：

```
context.publish {"task_id": "<id>", "role": "executor", "content_type": "code_changes", "payload": {"summary": "一句话摘要", "body": "<模板正文>", "commits": ["a1b2c3d"]}, "expected_version": 2}
tut publish <id> --role executor --content-type code_changes --summary "…" --payload-file changes.md --commits a1b2c3d --expected-version 2
```

## 发布 revision（revising 阶段的交付）

前置条件：full 或 direct 的修订轮，包括 full 的 fail_design 回路；验证已完成。solo 使用 code_changes；approved 或 closed 只发 note。

1. 若有代码改动，用 `git add <本次文件…>` 暂存交付文件。
2. 若有暂存改动，提交本次改动。
3. 按以下模板逐条填写回应（每条问题均有回应；无代码改动时说明即可）。
4. 按 `skills/common.md`「记录信封」填写 `ref_version`。
5. 按 `skills/common.md`「记录信封」发布 revision。

```markdown
## 对 review 的逐条回应
（针对 ref_version 所指记录逐条填写回应，包括人的 reject 理由或自己的收回问题。
 每条选择一种回应：满足关闭条件（证据为测试或 commit）、申请延后（引用 human 拍板 note）、
 反驳（给出理由）。无拍板的延后申请不算已延后。）

## 改动说明

## 验证结果
（填写本轮实际重跑的测试、构建及结果；未运行项注明原因。）
```

调用示例：

```
context.publish {"task_id": "<id>", "role": "executor", "content_type": "revision", "payload": {"summary": "一句话摘要", "body": "<模板正文>", "commits": ["e4f5g6h"], "ref_version": 4}, "expected_version": 5}
tut publish <id> --role executor --content-type revision --summary "…" --payload-file revision.md --commits e4f5g6h --ref-version 4 --expected-version 5
```

## 中途补充（note）

前置条件：存在设计缺口、风险或补充材料。reviewing 下的 Executor 非 ack note 会收回交付、转 revising；其余状态不转态，ack note 不收回交付。

1. 发布 Executor note（CLI 使用 `--summary` 与 `--body` 或 `--payload-file`）。
2. 若在 reviewing 发了非 ack note，按「发布 revision」重新交付（无需代码改动时仅说明）。

```
context.publish {"task_id":"<id>","role":"executor","content_type":"note","payload":{"summary":"…","body":"…"}}
```

## 工具速查

按下表使用 read、list、publish；公共语法见 `skills/common.md`「工具总则」。

| 操作 | MCP | CLI |
|---|---|---|
| 找实现任务 | `context.list {"status": "implementing\|revising"}` | `tut list --status implementing` / `--status revising` |
| 读 project scope、任务日志、增量 | `context.read {"task_id": …, "since_version": N}` | `tut read <id> [--since-version N]` |
| 发布 code_changes、revision、note | `context.publish {…}` | `tut publish <id> --role executor --content-type <t> --summary "…" (--body <text>\|--payload-file <md>) [--commits <a,b>] [--ref-version <n>] [--expected-version <n>]` |

## 关闭条件

1. 运行项目要求的测试与构建（含 design 或 description 指定的验证）。
2. 逐项核验 design 或 description 的验收要求。
3. 在「验证结果」中填写每项真实证据。
4. 若为 revision，逐项核对所回应问题的关闭条件（已延后项引用 human 拍板；反驳交 Reviewer 裁量）。

## 延后流程

1. 在 revision「对 review 的逐条回应」中标注「申请延后」。
2. 按 `skills/common.md`「延后流程」处理拍板与引用。

---

按本文件执行 Executor 工作。
