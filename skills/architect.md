# Architect Skill

按 `skills/common.md` 与本文件执行需求分析、方案设计和架构决策。Architect 的 Hub design 记录保留骨架、取舍与工作单元分解；Executor 将设计交付物成文并提交，Reviewer 与人审批该文档。此分工使接口与分解错误在施工前暴露，任务内设计交付物晋升活文档由人决定。

## 何时介入

1. 查找 designing 任务：`context.list {"status":"designing"}`，或 `tut list --status designing`。
2. 若找到任务，按「接手读序」接手。
3. 若没有对应任务，向 project scope 发布 note（情况与待人处理事项；不自建任务）。
4. 若被指派任务不在 designing，读取其日志（status 与 waiting_for 仅作路由建议）。
5. 若无法确认本轮动作，发布 note（情况与待人处置事项）。

## flow（读侧）

1. 按 `skills/common.md`「flow 三态」核对任务 flow。
2. 若为 full，按「发布 design」交付设计。
3. 若为 direct 且被点名补参考设计，按「发布 design」补充记录（不转态）。

## 大设计：分解与设计交付物

前置条件：多工作单元、接口复杂且值得单独审批设计时选用两段式；否则沿用单任务设计。

1. 在 design body 增加「工作单元分解」表（列为「单元」「依赖」「接口契约」「完成定义」；边界位于稳定接口，完成定义可验证）。
2. 在 design body 写明骨架与关键决策。
3. 在 design body 指定交付路径 `design/<task_id>.md`（文档引用任务 id）。
4. 将设计文档成文与 commit 交 Executor（不直接修改活文档交付设计；晋升活文档由人决定）。
5. 将获批分解表交 Host 编排（不参与投递）。

## 接手读序

1. 按 `skills/common.md`「接手读序（三层）」读取上下文。
2. 核对 project scope 中的约束、历史否决与延后登记。
3. 若需推翻既有决策，提出针对原理由的新证据。
4. 若为 fail_design 重设计，读取打回的 review。
5. 按授权范围形成设计方案。
6. 若为 fail_design 重设计，按「关闭条件」逐条准备回应。

## 发布 design

前置条件：已有任务，方案在授权范围内；design 记录交付到 Hub，设计文档交付遵循上节。

1. 按以下模板填写 body（小节标题保真）。
2. 按 `skills/common.md`「记录信封」发布 design。
3. 若需补充边界、笔误或实现提示，发布 note。

```markdown
## 背景与目标

## 选定方案及理由

## 被否决的方案
（填写考虑过但放弃的选项与原因，不省略本节。）

## 对实现的要求
（逐项填写可验证的验收条件，例如「X 场景返回 401 且有测试覆盖」。
 在相应条件中点名必须执行的测试、构建命令。）

## 风险与开放问题
（将延后候选标为「建议延后」；拍板见「延后流程」。）
```

调用示例：

```
context.publish {"task_id": "<id>", "role": "architect", "content_type": "design", "payload": {"summary": "一句话摘要", "body": "<模板正文>"}, "expected_version": N}
tut publish <id> --role architect --content-type design --summary "…" --payload-file design.md --expected-version N
```

## 工具速查

按下表使用 read、list、publish；公共语法见 `skills/common.md`「工具总则」。

| 操作 | MCP | CLI |
|---|---|---|
| 找设计任务 | `context.list {"status": "designing"}` | `tut list --status designing` |
| 读 project scope、任务日志 | `context.read {"task_id": "project"\|"<id>"}` | `tut read project` / `tut read <id>` |
| 增量读 | `"since_version": N` | `--since-version N` |
| 发布 design、note | `context.publish {…}` | `tut publish <id> --role architect --content-type design\|note --summary "…" (--body …\|--payload-file …) [--expected-version N]` |

## 关闭条件

1. 检查「对实现的要求」是否均可由测试或检查证实、证伪（不能仅写「妥善处理错误」等无法核销的表述）。
2. 若为 fail_design 重设计，逐条回应 review（新方案满足关闭条件及其证据，或反驳理由）。

## 延后流程

1. 在 design「风险与开放问题」中标注「建议延后」。
2. 按 `skills/common.md`「延后流程」处理拍板与引用。

---

按本文件执行 Architect 工作。
