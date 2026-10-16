# Common Rules（全角色共同规则基座）

与各角色 skill 共同使用本文件。worker 指 Architect、Executor、Reviewer；Host 不属于 worker。运行时以本文件的流程判据、任务记录及 CLI 原生约定为依据。

## 写通道与身份

1. 选择写通道（有 MCP 用 `context.*`；无 MCP 用 `tut`）。
2. 将 `role` 填为当前担任的角色（`architect | executor | reviewer | human`；Host 的受托记录见 `skills/host.md`）。

## flow 三态

1. 从任务日志读取 `flow`（建任务后不可变，缺省 `full`）。
2. 若为 `full`，按当前角色流程接手（已有 design 作为实现与评审依据）。
3. 若为 `direct`，按 description 的设计指针接手（无需等待或自发补 design 记录）。
4. 若为 `solo`，按角色流程交付 design 或 code_changes（免 review；reject 后仍交付 code_changes）。
5. 若发现 flow 选错，将 close 重建方案交人裁决。

## 流程判据

任务状态由记录序列派生；写入自由不代表获准绕过人工审批。status 与 waiting_for 仅作路由建议。full 从 designing 开始：designing 下 design → implementing，implementing 下 code_changes → reviewing；reviewing 下 review 的 pass / blocked_external → pending_approval，fail_code → revising，fail_design → designing。revision 将 revising（或 full 的 implementing）送回 reviewing。pending_approval 下人的 approve → approved，reject → revising；close 在任意状态终止任务，closed 为吸收态。

direct 从 implementing 开始，该状态下 design 仅为参考且不转态（其余状态为表外）；fail_design 和 implementing 下的 revision 属表外记录。solo 从 designing 开始，designing 下 design → implementing，implementing 下 code_changes → pending_approval，pending_approval 下 reject → implementing；review 与 revision 属表外记录。

note 通常不转态；仅 reviewing 下 Executor 的非 ack note 收回交付、转 revising，之后以 revision 重新交付。ack note 不收回交付。表外记录仍落盘但不参与流转，叠加 needs_attention，交人处置；不得通过自由写入规避流程。approved、closed 后仅用 note 汇报，修改另建任务。project scope 无任务状态。

## 接手读序（三层）

1. 读取 git 中的 `AGENTS.md`（含测试、构建要求）。
2. 读取 project scope：`context.read {"task_id":"project"}`，或 `tut read project`。
3. 读取任务完整日志：`context.read {"task_id":"<id>"}`，或 `tut read <id>`。
4. 按角色 skill 核对项目约束、历史决策及本轮要求。

运行时角色不主动读取项目设计文档。设计通过 Hub design 记录进入任务；description 明确锚定的设计指针（如 direct 单的 `design/X.md §N`）属于该任务授权读取范围，仅按指定范围读取。`design/<task_id>.md` 是设计交付物的写产物引用，不构成读取其他设计文档的授权。

## 版本与增量

1. 记下 read 返回的最新 version。
2. 需要增量时，以 `since_version` 读取指定版本起的记录（CLI `--since-version N`，含 N）。
3. 发布时，优先将可选的 `expected_version` 填为已读的当前最新 version。
4. 若返回 `VERSION_CONFLICT`（MCP `isError` 或 CLI 非零退出），重读任务日志。
5. 若发生版本冲突，按新日志重新核对待发布内容。
6. 若冲突核对后仍需发布，用新的 `expected_version` 重试发布。

## 记录信封

前置条件：已准备记录内容；code_changes 或 revision 涉及的代码改动已提交。记录正文保留完整推理过程，供下一个 Agent 与人核对；已有记录不可改删。

1. 填写一句话 `summary`。
2. 按角色模板填写 Markdown `body`（CLI 长正文用 `--payload-file`；信封与正文均不内联 diff、不列文件明细；关键 hunk 可作解释）。
3. 若涉及代码改动，填写 `commits`（权威文件明细与 diff 由 `git show <hash>` 获取）。
4. 若发布 review 或 revision，填写 `ref_version`（review 指向所审交付；revision 指向所回应的 review、人的 decision(reject) 或 Executor 收回 note；fail_design 回路指向打回设计的 review）。
5. 调用 `context.publish` 或 `tut publish`（字段取自当前角色模板；版本见「版本与增量」）。
6. 检查返回值（`needs_attention` 不为 true 时结束）。
7. 若 `needs_attention=true`，读取 warnings。
8. 用 note 披露 warnings。
9. 将异常交人处置（已有记录不可改删；ack 入口见 `skills/host.md`）。

## 工具总则

1. 按 MCP schema 或 `tut` 无参输出的 USAGE 组织调用（五工具与 CLI 对应；不自造 flag）。
2. 若脚本消费 CLI 结果，使用 `tut read <id> --json` 或 `tut list --json`。
3. 若自述 agent 或 model，填写已知身份（可选字段，未知留空）。
4. 若需人工审批，转交 Host 或人（worker 不调用 `decide`）。

## 授权基线

1. 从建任务 description 与 human 记录定位人的原始授权（会话原文或 Hub 记录位置）。
2. 以原始授权核对工作范围（符合设计文档不等于属于当前任务；worker 记录仅为提案；局部批准不扩大整体授权；role=human 标签不替代授权证据）。
3. 若需扩围，将方案交人裁决。

## approve 语义

1. 将 approve 视为工作验收；仓库层质量门不进入任务生命周期，不模拟 PR 循环，不设置或复活 hold 门。
2. 若 approve 后需修改，转交 Host 发起新任务。

## 延后流程

前置条件：延后建议与申请不等于批准；有效延后须有人的授权 note，记录问题与理由（不用 decision）；project 登记包含原任务、ref_version 与关闭条件，由人或明确受托的 Agent 发布。

1. 在角色指定小节提出延后建议或申请。
2. 若尚无人拍板，将延后请求交人处理（未受托不代登记、不代跟进）。
3. 若已有人的拍板 note，在交付中引用其 version。
4. 按人的拍板核销已延后问题。
