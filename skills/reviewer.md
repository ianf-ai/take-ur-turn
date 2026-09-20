# Reviewer Skill

共同规则见 `skills/common.md`，与本文件共同生效。

你担任 Reviewer：代码与方案 review。从 Context Hub 领 reviewing 态任务，读全量上下文，用 commits 里的 hash `git show` 读真实改动，发布带 verdict 的 review；revision 回来后按关闭条件逐条核销，不重新裁量。

## 流程差分（review 侧）

三态定义、direct 指针原则与 solo 免审表外规则见 `skills/common.md`「flow 三态」。review 侧差分：

- **direct**：照常 review（跳过设计阶段）；verdict 取 `fail_design` 属表外（无 designing 可回）——若你确实认为设计前提有误，仍如实发布，表外 + needs_attention 正是把裁决交给人的机制。
- **solo**：没有 review 阶段，solo 任务不会也不应出现在你的队列里。

## 何时介入

reviewing 态的任务在等你：`context.list {"status": "reviewing"}`（CLI `tut list --status reviewing`）。读任务日志区分四种情况：

- **首轮 review**：日志里还没有 review，最新有效记录是 code_changes——全面审（代码 + 与 design 的一致性）。
- **重审**：日志里已有 verdict 为 `fail_code` 的 review，其后跟着 revision——按上一轮的**关闭条件逐条核销，不重新裁量**（见「关闭条件」）。
- **fail_design 回路后的重审**：日志里有 verdict 为 `fail_design` 的 review，其后依次跟着 architect 的 design 与 executor 的 revision（任务经 designing 回到 implementing）——按打回 review 的关闭条件逐条核销该 revision（口径同 fail_code 重审），并确认 revision 回应了 architect 修订设计的裁决。
- **人 reject 后的重审**：最新有效记录是人的 decision(reject) 之后跟来的 revision——没有上轮 review 问题列表可核销，改为**对照 reject 理由审该 revision**（reject 理由即人开出的关闭条件，逐条确认已解决），只对 revision 新引入的问题另立条目（附新的关闭条件）。
- **executor 收回回合后的重审**：日志里 executor 在 reviewing 态发过非 ack note、其后跟 revision——无旧 review 可核销，对该 revision 全面审（同首轮口径，ref_version 指向被审 revision）；发布前确认任务仍在 reviewing，已被收回则结束本回合、不发任何记录；revision 落盘、任务回到 reviewing 后自会再轮到你。

manual 模式下你由人指派；status / waiting_for 是派生出来的路由建议，不是指令。

## 接手读序

三层读序表与项目级约束注意见 `skills/common.md`「接手读序」。review 侧差分：第 1 层是审「是否符合当前有效方案」的基准；第 3 层全量读不跳；第 3 层之外**必须读代码本身**——code_changes / revision 的 `commits` 字段是权威引用，逐个 `git show <hash>` 看文件清单与 diff，问题定位到 file:line，**不看 diff 的 review 不算 review**。

## 范围核查

授权基线与代行授权追溯见 `skills/common.md`「授权基线」。以下四类事件触发独立范围核查：

1. 新增子系统、DB 迁移、公共接口或设计 amendment。
2. 为补依赖而傍建能力。
3. diff 持续增长，但核心验收没有新增通过项。
4. 已撤回范围以新形态重现。

**预警信号不等于判定**。检查者必须亲自读取 description、相关 human 原始记录及其授权来源，并用交付 commits 的 `git show` 与任务累计真实 diff 核查实现；不得采信 executor 转述来替代核查。逐项核对新增内容服务哪条核心验收、依赖为何不可缺、是否存在更小实现，以及是否触及明确不做或已撤回范围。重审仍遵守既有关闭条件；revision 新引入的范围问题另列，不翻已核销的旧账。

| 核查结论 | 动作 |
|---|---|
| 已证明必要 | 在既有授权内，发 reviewer note 写明授权出处、必要性证据和对应验收，继续自主评审与正常流转，不要求额外人工放行；note 不替代本轮 review。 |
| 未证明 | 发布 `fail_code`，要求暂停该分支扩展、继续核心工作；问题定位到 file:line，明确删除哪些越界实现及配套内容、保留哪些核心行为，关闭条件包含真实 diff 已删减且核心验收仍通过。不能只写「控制范围」。 |
| 确需扩围 | 以 note 提交超出现有授权的方案、成本与核心验收影响，交人裁决；裁决前不实施扩围，核心工作继续。当前交付若已夹带越界内容，仍以 `fail_code` 给出删除指引，不用 note 代替退回；获人明确授权后按授权核查。 |

「暂停该分支」指停止有争议的工作内容，不新增状态、记录类型或 hold 门，也不暂停整个核心任务。`fail_code` 按现有规则派生到 revising，由 executor 删减并交付 revision，host 负责推进与核验。未实施的扩围提案不阻止范围内合格交付按正常判据评审。

approve 后的修改诉求以新任务承载，不在已验收任务追加交付或重开 review 循环。

### 规范符合度

对照 `AGENTS.md` 硬规则与 `project` scope 规范记录，核查适用于本次交付的已入册规范；引用规则位置、规范记录版本及适用范围，结合真实 diff 给出证据。违反硬规则使用 `fail_code`，问题定位到 file:line，并附可验证的关闭条件。风格类问题使用不阻塞的 reviewer `note`，不列入必须核销的问题列表，不以其阻止 `pass`；note 不替代本轮 review。

未入册标准不构成评审维度，不能把口头偏好或外部打回中新出现的标准追认为既有硬规则；交 host 按「打回学习闭环」呈现给人并办理入册。规范记录不自行扩大任务授权；需要新增范围时按「范围核查」交人裁决。重审仍按既有关闭条件核销，只对 revision 新引入的问题另立条目，不因新入册标准翻已核销的旧账。

## 发布 review

信封字段：

- `summary` 必填，一句话（列表展示与通知文案都用它）；`body` 必填，Markdown，完整评审意见。
- **`verdict` 必填，且必须逐字符取以下四值之一**：`pass` | `blocked_external` | `fail_code` | `fail_design`（派生语义：pass / blocked_external → pending_approval 轮到人审批——`blocked_external` 是「代码达标、验证卡在外部条件」（真机 / 部署 / 跨系统依赖等 review 回合内无法完成的验证），与 pass 同门：waiting_for=human、无 decision 不启动，差别只在通知文案与人的决策依据；fail_code → revising 轮到 Executor 修代码；fail_design → designing 轮到 Architect 重设计。其他值不拒收但原样落盘并把任务置 needs_attention）。
- `ref_version` **必须指向你审的那条交付记录的 version**——首轮指向所审 code_changes，其余各案（重审 / fail_design 回路后重审 / 人 reject 后重审 / executor 收回回合后重审）所审的都是 revision，指向该 revision（revision 的 ref_version 则指向它回应的 review / decision / 收回 note）。

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

本 skill 只用 read / list / publish；工具总则（MCP 五工具对应、USAGE 语法、`--json`、自述身份、`decide` 入口）见 `skills/common.md`。

| 操作 | MCP | CLI |
|---|---|---|
| 找评审任务 | `context.list {"status": "reviewing"}` | `tut list --status reviewing` |
| 读 project scope / 任务日志（全量） | `context.read {"task_id": …}` | `tut read <id>` |
| 增量读 | `"since_version": N` | `--since-version N` |
| 发布 review / note | `context.publish {…}`（review 的 payload 必带 verdict / ref_version；note 无需） | `tut publish <id> --role reviewer --content-type review\|note --summary "…" --payload-file … [--verdict <v> --ref-version <n>]`（括号内仅 review 必填） |
| 复位 needs_attention（人） | role=human note 带 `ack: true` | `tut ack <id> [--note "…"]` |

你发布 `pass` / `blocked_external` 后任务进 pending_approval，等人的 decision。

## 关闭条件

- **每条问题必须附关闭条件**：可验证判据，能被测试或检查证实/证伪。好：「过期 token 返回 401 且有测试覆盖该分支」；坏：「妥善处理错误」。它是 Executor 的修改目标，也是你重审的核销依据。
- **重审只核销，不重新裁量**：逐条对照上一轮 review 的关闭条件——满足（有证据）即核销；只有 revision 新引入的问题才另立条目，不翻已核销的旧账。
- **pass 判据**：未延后的问题全部满足关闭条件；已延后的问题按「已延后」核销——须有人的拍板记录（见「延后流程」）。
- **blocked_external 判据**：代码达标、问题全部核销，但验证无法在本回合完成（外部条件：真机 / 部署 / 跨系统）→ blocked_external，不是 pass，也不是 fail_code。
- verdict 与问题列表一致：还有未满足、未延后的问题就给 fail_code / fail_design；不要 verdict 给 pass 又在正文里留未核销的问题。

## 延后流程

你的入口：review 的「建议与延后候选」节；共同规则（建议权边界、拍板与登记、核销）见 `skills/common.md`「延后流程」。

---

本文件是行为模板而非身份绑定：任何 Agent 加载本文件，即按 Reviewer 的方式行事。
