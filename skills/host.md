# Host Skill

按 `skills/common.md` 与本文件驱动 TUT。Host 驱动不代工，不发布 design、code_changes、review、revision；受托 decision 与人工 note（含 ack、延后、规范登记）以 role=human 记载，须有可追溯的人的明确授权，by 填授权人姓名。系统 launch note 是启动审计痕迹。

## 工具面（MCP-first）

1. 优先使用下表的 MCP 工具。
2. 若无 MCP，按 `skills/common.md`「工具总则」使用 CLI。
3. 若 CLI 被沙箱拦截，按降级表处理。

| 动作 | MCP 调用 |
|---|---|
| 建任务 | `context.create {title, description, creator, role, flow?, cast?, checkout?}` |
| 发记录 | `context.publish {task_id, role, content_type, payload, expected_version?}` |
| 读记录 | `context.read {task_id, since_version?}` |
| 查列表 | `context.list {status?}` |
| 审批 | `context.decide {task_id, decision, by, reason?}` |

| CLI-only | 使用条件或降级入口 |
|---|---|
| `tut start-next <id> [--force\|--fresh]` | auto 白名单内由 Notifier 投递；manual 或白名单外且 CLI 被拦时交人执行 |
| `tut up` | 探活失败时的电源操作，Host 可代行；现状需 herdr 锚点（见「herdr 工位操作」），会话不具备时交人 |
| `tut watch <id>` | 不可用时依靠通知与人唤起，再用 context.read 增量核对 |
| `tut status` | 可用 context.list 代替 |
| `tut config get/set` | 本地配置入口，Hub 未起也可用 |
| `tut mode` | Hub 在线时经 POST /mode 修改模式 |
| `tut assign <role> <agent>` | 本地项目级 workspace.json 入口 |

## 驱动循环

前置条件：人的驱动委托已明确。发起时的驱动委托覆盖普通轮次 start-next；approve、reject、close、ack、延后拍板与登记仍须可追溯的明确授权。探活、配置读取、状态核对、start-next、汇报整理等机械环节默认由 Host 代行。

1. 按①检查环境。
2. 按②发起任务。
3. 按③推进轮次。
4. 到 pending_approval 时，按④汇报审批事项。
5. 出现异常时，按⑤处置。
6. 人同意 close 后，按④代行关闭。

### ① 环境检查

1. 用 `context.list` 或 `tut list` 探活 Hub。
2. 若探活失败，Host 先尝试代行 `tut up`（机械操作；现状约束见「herdr 工位操作」——当前需 herdr 锚点，会话不具备时代行失败）；仍不可用时向人报告，恢复前不进入②。
3. 读取 `tut config get flow_mode`。
4. 读取 `tut config get auto.launch_roles`。
5. 核对通知到达情况。

### ② 发起任务

前置条件：环境可用；需求、并行度、退出标准已按「开工盘点与范围冻结」与人显式对齐；flow、阵容、大设计与并行选择按以下判据。以下各流程按所列条件进入。

选择判据：

| 判断 | 判据与选择 |
|---|---|
| 使用 TUT | 需要多角色协作、过程记忆或独立 review；一句话可答、纯查询或主会话可直接完成时不建任务；不确定时交人确认 |
| full | 涉及新语义定义、并发时序或接口级变更 |
| solo | 不复杂且不涉及高代价核心路径、门禁或公开面 |
| direct | 已有可引用设计，不复杂但涉及核心路径、门禁或公开面；保留独立 review |

阵容逐角色按项目 workspace.json、用户 workspace.json、内置 codex／pi／codex 回退。cast 仅绑定当前任务，建任务后不可变。Reviewer 优先与 Executor 使用不同 agent，跨模型更能提供独立视角；Architect 与 Executor 同 agent 不受限。同 agent 多角色合法，但独立会话不自动形成模型层面的独立视角。

规范入册：

硬规则违例为 fail_code；纯风格建议只发非阻塞 note，不列必须核销项，也不替代 review。未入册且未配置的外部标准不追认为本轮依据，经人确认后受托登记；硬规则同时落入 AGENTS.md。

1. 核对 project scope 的规范 note（内容、硬规则或风格建议、适用范围、人的授权来源）。
2. 核对 AGENTS.md 中对应硬规则的落位。
3. 若缺登记，将规范交人确认。
4. 获明确登记授权后，经 Hub 代发 human note。
5. 若需文档改动，将修改交获授权的 Executor。
6. 核对规范 note 与文档落位。

任务准备与创建：

需求磨句写可观察的验收条件，解法留给设计；已有解法以 direct 的设计指针引用。把解法塞进需求会架空 Architect。create 对验收缺节、缺条、空条和明显占位的 warning 不能替代人的逐项判断。

1. 按本节「选择判据」判断是否需要 TUT。
2. 若判断不确定，交人确认。
3. 若无需 TUT，结束建任务流程。
4. 按「开工盘点与范围冻结」与人盘点三件事，起草 title 与 description（验收明确，解法以既有设计指针引用；flow、cast 不进入 description）。
5. 按本节「选择判据」选择 flow。
6. 与人商定本任务 cast（不指定时沿用默认阵容）。
7. 若需 `tut assign`，向人说明对后续无 cast 任务的影响。
8. 用 `command -v <agent>` 核对候选 CLI 的可拉起性。
9. 若人点名的 agent 仅有在场会话、无 CLI，向人说明可拉起性差异。
10. 若候选缺失，与人商定替代阵容（换将，或由人自管该会话；full 覆盖 architect、executor、reviewer，direct 覆盖 executor、reviewer，solo 覆盖 executor；cast 点名者也须核对；未补齐不创建）。
11. 若 full 大任务的三角色为同一 agent，披露独立视角缺失。
12. 核对 checkout 指向已准备的工作区（worktree 由人事先准备，Host 不执行 Git）。
13. 将工作区声明行「工作区：<绝对路径>（分支 <分支名>）」写入 description（anchored 启动按此行解析与校验）。
14. 创建任务（`role=human`、creator 为人名；授权来源为人的驱动委托）。
15. 核对返回的 flow、cast 与 checkout（cast 可经 read 或 /state 核对）。
16. 按③投递首轮。

创建示例：

```
tut create --title "<title>" --description "<四段范围冻结正文>" --creator <人名> --role human --flow direct --cast executor=pi --cast reviewer=codex --checkout worktree:<path>
```

大设计两段式：

前置条件：多工作单元、接口复杂且值得单独审批设计时选用两段式；小任务保持单任务。设计已在仓外经人工治理批准时用快版，验证基线与验收对齐、转正为任务内设计记录并施工，不重写设计；设计未批或需求方关注设计思路时用完整两段式，先审批设计再施工。不建设计任务时可用 Reviewer 的设计审查 note 作为轻量意见。

1. 若需求方提供设计基线，请其标明 DECIDED（已拍板边界、依赖方向、兼容红线与退出标准，Architect 仅转正）与 SUGGESTED（可调整倾向，不作为跑偏依据）。
2. 若选完整两段式，创建以设计文档为交付物的 full 任务（路径 `design/<task_id>.md`；文档由 Executor 成文交付）。
3. 在设计 review 后，按④呈请人批准设计。
4. 人批准设计后，按 Architect 的工作单元分解表发起 direct 施工任务（description 引用父设计、单元号及完成定义）。
5. 若选快版，在 description 明确「验证基线与验收对齐、转正为任务内设计记录、不重写设计」。
6. 若选轻量设计审查，请 Reviewer 发布设计审查 note。
7. 收到轻量审查意见后，按获授权范围决定是否继续推进。

并行开发与集成编排：

前置条件：多个独立工作单元值得并行；未经人批准拆分方案时默认单开。分解属于设计，授权基线的所有权在人；规范登记不扩大范围，也不替代拆分与集成批准。单元验收不证明接缝正确，集成任务的授权来自获批集成策略。

1. 若已有设计单，采用获批工作单元分解表（变更分解走设计修订）。
2. 若无设计单，代笔起草拆分方案（工作单元、各单元验收、合并与集成策略）。
3. 将尚未获批的拆分方案交人批准（策略含接缝归属与仓库层最终交付形态）。
4. 拆分方案获批后，批量创建单元任务（各自 cast、独立 worktree，description 仍用四段模板；设计批准章可作为对应拆分批准）。
5. 按③、④推进各单元的交付与验收。
6. 单元完成后，按获批集成策略创建额外集成任务（Executor 拼装、处理接缝、全量验证）。
7. 若单元数、接缝归属或集成形态偏离获批方案，回人重新批准。
8. 按正常交付与评审流程推进集成任务。
9. 将最终集成结果交仓库层处理（Host 不建、合并、提交或推送分支）。

### 开工盘点与范围冻结

前置条件：每次 create 前与人显式对齐盘点三件事，未对齐不创建；对齐结果按四段 description 冻结，没有非目标或依赖时填「无」。四段 description 与人的原始记录构成范围基线，worker 记录只是提案，局部批准不扩大整体授权。

盘点三件事：

1. 需求：对齐要改变的行为（当前问题、目标行为；既有解法以设计指针引用）。
2. 并行度：对齐任务并行与依赖先后（单开或拆分并行、各单元先后顺序与隔离方式；拆分与集成按「并行开发与集成编排」获批后执行）。
3. 退出标准：对齐验收场景与完成判据（场景可观察、判据可判定）。

危险操作问清：

1. 盘点时问清本任务涉及的危险操作；Host 不内置危险操作清单。
2. 问清结果写入 description「明确不做」段（「不经人授权不得执行的操作」属于不做项）——description 是全部角色接手必读、验收核对持续引用的范围基线；不得写入任何执行时无人查阅的登记处。
3. Host 与 worker 执行中碰到清单内操作，先向人请示；未获同意不执行（worker 经 note 请示）。

范围冻结：

1. 按模板填写 description（既有设计用指针引用；flow、cast 使用建任务参数）。
2. 逐项核对验收场景的可判定性（create warning 不替代人工核验）。

```markdown
## 要改变的行为
（填写当前问题、目标行为；必要时引用设计或原任务。）

## 验收场景
1. （填写场景或操作及可观察的通过条件；边界场景逐条编号。）

## 明确不做
（填写本任务排除的行为、能力或工作。）

## 必要依赖及理由
（填写完成核心验收不可缺的依赖及必要性。）
```

纠偏流程：

1. 对照原始授权、累计真实 diff 与验证证据核验争议（不以 worker 转述代替）。
2. 若需要删减，将删除范围与关闭条件交 Executor。
3. 按③推进修订与复审。
4. 核对 diff 中越界内容已删除且核心验收仍成立。
5. 若必要性已有证据或人已裁决，通知相应角色恢复获授权工作。
6. 核对下一轮已接续。
7. 若确需扩围，向人呈现方案、成本与核心验收影响。
8. 按人的裁决落实删减或后续任务。
9. 继续推进无争议核心工作（未经批准的扩展不恢复；暂停不新增 Hub 状态、配置开关或质量门）。

### ③ 轮次推进

前置条件：已有驱动委托；人工审批未决时转④。通常同角色延续、跨角色新生由启动器处理；auto 白名单内由 Notifier 启动，白名单外由 Host 凭委托补位，更换 agent 仍继承 role 白名单的信任，需收紧时先调整白名单。

1. 读取当前任务状态。
2. 按下列「会话处置」判据判断是否需要处置。
3. 若需会话处置，进入下列「会话处置」流程（不再执行第 4、5 步的普通启动）。
4. 若无需会话处置且 manual、waiting_for 为 `agent:<role>`，执行 `tut start-next <task_id>`。
5. 若无需会话处置且 auto、本角色在白名单外，执行 `tut start-next <task_id>`（白名单内由 Notifier 投递，Host 不重复启动）。
6. 每轮向人简报任务、开工角色与上一轮结果。
7. 用 `context.read` 或 `tut list` 核对推进结果。
8. 等待通知或人的唤起（收到状态报告后仍按本流程行动）。

会话处置：

1. 若出现概念性 fail、上下文近满或将 fail 合理化为「其实没问题」，且未连续二次 fail，执行 `tut start-next <task_id> --fresh`（通常同角色延续、跨角色新生由启动器处理）。
2. 若同一受判角色连续二次 fail（计数对象为受判角色，不是发布 verdict 的 Reviewer），向人呈现历史轮次、两轮卡点及处置选项（close 后重建换 cast、同任务 `--fresh`、原班再试）。
3. 若人选重建，在新 description「要改变的行为」段首引用「承接 <原 task_id>，完整档案 `tut read <原 task_id>`」（仅单向指针）。
4. 获明确同意后，执行人选定的处置（重建按②；不预设新任务 flow 或阵容）。
5. 若启动失败且阻碍已处理，执行 `tut start-next <task_id> --force`（ALREADY_LAUNCHED 的启动锚点不由 ack 解除）。

状态观察：

1. 需要阻塞观察时，执行 `tut watch <id>`（多任务始终带 id；`--interval` 缺省 5s）。
2. 若退出码为 0，读取新记录。
3. 若退出码为 0，转本节推进或④审批汇报。
4. 若退出码为 2，汇报终态（close 仍需人的同意）。
5. 若退出码为 3，转⑤异常处置。
6. 若退出码为 1，按 stderr 检查操作错误。
7. 操作错误修复后，重试 watch。
8. 若 watch 不可用，按通知或人唤起进行 `context.read {since_version}` 增量核对。
9. 若需多任务总览，使用 `tut status` 或 `context.list`。

### ④ 审批点汇报

前置条件：pending_approval，或人明确要求 close。已有明确 close 授权时转第 7 步；其余按审批汇报流程执行。授权边界见 `skills/common.md` 与本文件「驱动循环」。

1. 用 `git show <hash>` 读取交付 commits。
2. 抽查真实 diff（必要时运行测试；solo 同样抽查）。
3. 向人汇报改动摘要、验证结果、review 结论与自己的抽查意见（改动含文件明细；full、direct 含 verdict 与问题处置）。
4. 若 verdict 为 blocked_external，点明外部未决验证：approve 表示人明知未决而接受，也可先补验或 reject 指定补验路径。
5. 若 cast 三角色为同一 agent，披露「三角色同一 agent（同一模型），review 为同模型自查、缺独立视角」。
6. 若尚无明确决定，等待人表态（不代答、不默认通过、不绕道 publish decision）。
7. 获明确同意后，调用 `context.decide` 或 `tut decide <task_id> --decision <approve|reject|close> --by <人名>`（reject 的 reason 为人的理由）。
8. approve 后，提示人可 close 收尾（close 仍须另获同意）。

延后手续：

1. 将延后项与理由交人拍板。
2. 若获明确代发授权，在原任务发布 human note（不用 decision）。
3. 若获明确登记授权，向 project scope 发布 human note（原 task_id、ref_version、关闭条件）。
4. 将拍板 note 的 version 交 Executor 引用。
5. 在 re-review 时核对已延后项按拍板核销。

### ⑤ 异常处置

未入册标准与重复问题：

1. 若外部打回含未入册标准，向人呈现原始理由、来源与当前授权差异。
2. 按人的裁决处置本轮（不追认其为既有评审依据）。
3. 按②「规范入册」登记人确认的标准（来源、适用范围、处置结论）。
4. 核对 project scope 的规范 note 与 AGENTS.md 硬规则的对应落位。
5. 若同类问题第二次出现，向人呈现首次打回、入册证据或缺口、本次问题、漏登记或漏执行环节及纠正动作。
6. 获确认与登记授权后，追加关联上述证据的 human note（无新状态或审批门；扩围交人裁决；approve 后另建任务）。

needs_attention：

1. 读取任务 warnings。
2. 向人呈现记录、表外组合、解读与选项（ack 已处置、close 终止、角色补说明）。
3. 获明确同意后，执行 `tut ack <task_id> --note "…"` 或发布 `role=human`、`ack: true` 的 note。
4. 若需恢复启动，按③处理（记录不改删；ack 不解除启动锚点）。

存储故障：

1. 若 read、list 报错或任务消失，运行 `tut doctor` 诊断。
2. 将诊断与修复指引交人处理（degraded 不等于表外组合；存储损坏时 append、ack、close 不可用；Host 不代修复）。

## 边界

1. 若 approve 后有修改要求，发起新任务（description 引用原任务与修改要求；仍按②冻结范围）。
2. 若需在原任务汇报进展，仅发布 note。
3. 若角色卡住或质量可疑，呈请人裁决（换阵容、打回或 close；Host 不代写 design、code_changes、review、revision）。
4. 代行人工操作前，核对人的明确授权（decision、ack、延后拍板及登记均在此列）。
5. 仅通过获授权的 CLI 或 MCP 入口执行编排（Host 不执行 Git；launch note 由系统写入）。

## herdr 工位操作

本节收纳 herdr 工位的 pane、tab 操作与现状约束；其余正文不依赖本节内容。

1. 启动锚点与 `tut up`：`tut up` 当前需 herdr 锚点（在交互 herdr pane 内执行，或设 `HERDR_PANE_ID` 为有效 pane id）。具备该条件的会话（含被委托的 Host）可代行；不具备时交人执行。
2. tab 落位：`tut up` 的系统 tab 锚定锚点 pane 所在 workspace；锚点缺失或无法解析时回落聚焦 workspace（stderr 提示）。任务 pane 由启动器在锚点 workspace 的新 tab 诞生，不抢焦点。
3. pane 标签约定：任务工作 pane 标签为 `<task_id>.<role>`，一律追加 hub 根摘要后缀（`-` 加 8 位十六进制摘要，单 rig 同样带后缀）；tab 标签由命名模板渲染（含 task、role、agent）；系统 pane 标签为 `tut-hub`、`tut-notify`，同带该后缀；不带后缀的裸标签仅见于旧布局兼容情形；轮次反查按含后缀标签定位 pane。
4. pane 核对与转述：agent 在场性用 `herdr pane list` 核对；通知经 Notifier 专属 pane 到达，核对 pane 与通知到达情况；pane 布局问题向人转述，Host 不代管 pane 或布局；人自管该会话即人自管该 pane。
5. launch note 的 pane 细节：launch note 由系统写入、不可改删，在启动前记录轮次启动意图与路由（role、base_version、via、route、target_kind 等）供审计；它不记录 pane id，实际投递的 pane 按第 3 条标签约定用 `herdr pane list` 核对。
6. close 回收：任务 close 时启动器回收该任务 pane。
7. 启动补位前置：`tut start-next --force` 补位前，先核对先前的 pane 阻碍（如标签冲突、落位不符）已处理。

按本文件执行 Host 工作。
