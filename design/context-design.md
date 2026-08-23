# 上下文设计（Context Design）

本文档回答两个问题：**Context Hub 放什么**（内容模型，第 2 节），**怎么管理**（第 3 节）。payload schema 只是内容模型中的一小节（2.3）。

---

## 1. 定位：存什么、不存什么

### 1.1 三层上下文

Agent 协作需要的上下文分三层，各答一个问题（层与层之间有受控的耦合，见下）：

| 层 | 回答的问题 | 维护方与方式 |
|----|-----------|------------|
| 项目设计及开发文档 | 「现在是什么样、该怎么做」 | 人直接改文件（git 工作流）——**修订**，活文档 |
| 项目决策流 | 「为什么是现在这样」 | 经 Hub 写入（MCP 发布）——**追加**，append-only |
| 任务日志 | 「这件事进行到哪」 | 经 Hub 写入（MCP 发布）——**追加**，append-only |

分层的分界是**维护方式**（修订 vs 追加），不是物理位置——Hub 存储的物理形态（本地 JSON 或 git repo）由存储设计决定（见 3.1），无论哪种形态，这两条维护通道不变。

**Context Hub 只承载 append-only 的过程记录（任务日志、项目决策流）；项目设计及开发文档放在 git 里维护，是从 Hub 记录汇编出来的产物**——由人（或未来的 supervisor Agent）汇编。设计文档是活文档，要随设计演进不断修订才能保持「当前有效」；若让 Hub 也存一份并负责更新，就多出第二个需要同步的副本——每次设计变更都得有人记得去改它，少更新一次就过时一次，重演「设计文档与代码脱节、缺乏维护」的老问题。因此文档只放 git 一处，修订由 project scope 的决策记录触发。

**决策流与设计文档的耦合关系**：它们是同一变更的两半——结论进文档，理由进决策流，重复的只有「决定」这个引用点。三个性质使这个耦合保持良性：同步是单向的（文档变更只需追加决策，旧决策永不改写）；权威是明确的（不一致时以设计文档为准，决策流是历史证据）；漂移是可检测的（改文档不发决策 = 理由丢失，发决策不汇编 = 文档落后）。要防的是把决策流当第二份设计文档维护——改结论、删过时条目都会破坏 append-only。

### 1.2 仓库拓扑

系统有两个 git 仓库，**代码不与上下文同库**：

| 仓库 | 内容 | 写入通道 |
|------|------|---------|
| 代码 repo | 代码，及与代码工程绑定的约定文件（如 AGENTS.md） | 常规开发流 |
| context repo · `design/` | 项目设计及开发文档 | PR 修订 |
| context repo · `tasks/` | 任务日志 | 直 push 追加 |
| context repo · `project-scope/` | 项目决策流 | 直 push 追加 |

代码不进 context repo 的三个理由：

1. **生命周期不同**：决策流与任务日志是跨任务、跨项目的记忆，不应随某个代码 repo 的归档而丢失
2. **git 流量不同**：代码 repo 的 PR 流低频、重 review；上下文记录高频、append-only 直 push——混库会让代码历史与通知被上下文流量污染
3. **权限模型不同**：团队读分区（按团队分 context repo）与代码写权限（CODEOWNERS）各管各的

**代价与缝合**：上下文与代码版本失去直接关联（无法直接回答「commit X 时生效的是哪版设计」），由任务记录的 `commits` 字段引用 git commit 来补。

**待定**：AGENTS.md 这类与代码工程绑定的 Agent 约定文件的最终归属（倾向代码 repo，Agent harness 自动加载）。

### 1.3 原则

- **读者是下一个 Agent 和人，不是 Server**。Hub 不做入口校验、不处理内容；payload 为 LLM 的阅读效果优化，不为机器处理优化
- **外层结构化，内层完整叙述**（谁、何时、什么类型、第几版、针对谁 + Markdown 正文保推理过程）
- **append-only**：记录是快照不是活文档——design 被打回后新发一条，不回头改旧的

## 2. 内容模型：放什么

### 2.1 两种 scope

**task scope（默认）**：一个任务一条版本日志，有生命周期，状态由记录序列派生（designing → … → closed，规则见主设计第 3 节）。

**project scope**：一个长期的特殊 scope（task_id 固定为 `project`），**不参与状态机派生**——没有生命周期，就是一条持续的记录流。存跨任务的记忆：

- 架构决策及理由（ADR 式：背景、决定、否决项）
- 项目级约束与不变量（「零运行时依赖」「schema 只增不改」）
- 延后问题清单（含原任务、ref_version、关闭条件——被有意搁置的问题，等待被捡起）
- 教训与坑

落地成本≈零：实现上就是一个派生函数跳过的特殊任务。工具接入：`read` 天然可用；`list` 结果包含它（带 `scope: "project"` 标识，无 status）；`/state` 不含它（无可派生状态）——接入点见主设计 3.1、4.1、4.3。

### 2.2 记录类型（content_type）

| content_type | 典型发布者 | 语义 | 对派生的影响 |
|--------------|-----------|------|-------------|
| design | Architect | 设计方案与推理 | 按 flow（主设计 3.1）：full/solo 中 designing → implementing；direct 中为**参考记录**——implementing 态不转态，其余态表外 |
| code_changes | Executor | 实现、验证结果 | 触发流转 |
| review | Reviewer | 评审意见（含 verdict） | 触发流转（verdict 决定去向） |
| revision | Executor | 对 review 的修改与回应 | 触发流转 |
| note | 任何人 | 补充说明、问题标记 | 无 |
| decision | 人 | 拍板（approve/reject/close，或 project scope 里的决策） | 按主设计 3.1（仅 task scope；project scope 无流转） |

### 2.3 payload 信封（schema）

```json
{
  "summary": "一句话摘要",          // 必填。list 展示、通知文案用
  "body": "Markdown 正文",          // 必填。完整推理过程，写给下一个 Agent / 人看
  "verdict": "pass",                // 仅 review：pass | fail_code | fail_design
                                    //   派生消费字段之一（另有 ack / decision）；缺失/非法 → needs_attention
  "commits": ["a1b2c3d"],           // 仅 code_changes / revision 可选：对应的 git commit
                                    //   权威的文件清单与 diff 从 commit 取（git show）
  "ref_version": 2                  // 可选：本条针对的记录版本
}
```

| 字段 | 必填性 | 消费者 |
|------|--------|--------|
| summary | 必填 | context.list、Notifier |
| body | 必填 | 下一个 Agent、人 |
| verdict | review 必填（其余类型不出现） | **派生函数**（review 的流转依据） |
| ack | note 可选（`ack: true`） | **派生函数**（note 的 ack=true 清除累计 warnings） |
| decision | decision 可选 | **派生函数**（approve/reject/close 的状态依据） |
| commits | 可选 | 读者（`git show` 取权威清单与 diff）、未来工具链 |
| ref_version | 可选 | 读者（链路回溯） |

信封字段**只增不改**；Server 不做入口校验（与主设计 4.1 一致）。

**cast 不进信封**：任务级点将（role → agent）是 TaskMeta 字段，随 create 落库、随 read/list/state 暴露——它是路由参数不是记录内容，信封 schema 零改动（见主设计 4.1/6.2）。

### 2.4 body 模板（由 skill 教给 Agent，不进 schema）

**design**
```markdown
## 背景与目标
## 选定方案及理由
## 被否决的方案
（考虑过但放弃的选项，以及放弃的原因）    ← 原始痛点点名要保的东西
## 对实现的要求
（验收口径、边界条件、必须跑的测试）
## 风险与开放问题
```

**code_changes**
```markdown
## 实现概述
## 关键决策与偏差
（与 design 不一致的地方及原因）
## 验证结果
（测试/构建输出摘要——必须真实跑过）
## 遗留问题

（改动清单与 diff 不写在这里——commits 字段引用 commit，读者用 `git show` 查看；
 需要在正文里讨论某段代码时，按需摘录关键 hunk 作为说明的一部分）
```

**review**
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

**revision**
```markdown
## 对 review 的逐条回应
（针对 ref_version 指向的 review，每条说明属于哪种：
 满足关闭条件——给出证据（测试、commit）；
 申请延后——引用人的拍板记录；
 反驳——给出理由）
## 改动说明
## 验证结果
```

**note**：无模板。**decision**：body 写决定理由，一到三句。

**延后问题的流程**：延后有两个发起入口——Reviewer 在 review 的「延后候选」中提出，或 Executor 在 revision 中申请。无论哪个入口，**延后由人拍板**：人发一条 note 写明同意延后哪些问题、理由。拍板用 note 而非 decision——decision 参与状态派生，任务中途（如 reviewing 态）发布属于表外组合、会置 needs_attention；note 在任何状态都安全。revision 引用该拍板记录，re-review 按「已延后」核销。拍板的人（或委托的任一 Agent）随即将延后问题以一条 note 登记进 project scope（带原任务、ref_version、关闭条件），成为跨任务记忆，不随任务关闭而丢失——将来哪个任务把它捡起来，不用考古。

### 2.5 链路回溯：ref_version

- review `ref_version` → 它审的 code_changes
- revision `ref_version` → 它回应的 review
- 修订轮次多时，这是唯一可靠的对应关系来源

### 2.6 上下文获取路径（写进 skill）

任务 description 随 context.read / `tut read` 返回（加法修订）——direct/solo 流程里任务要求不经 design 记录承载，读日志即见需求。

Agent 接手工作时的读序，三层各答一个问题：

1. 读 git 权威文档（AGENTS.md、design/）——「现在是什么样、该怎么做」
2. 读 project scope 决策流——「为什么」
3. 读任务日志——「进行到哪」

## 3. 管理方式：怎么管理

### 3.1 存储与版本

- 本地 JSON 文件（`.context-hub/` 目录，按 scope 组织，每次写入带版本号），结构见主设计 4.2
- 存储层可插拔，可替换为 git/GitHub 后端，MCP 接口不变
- append-only：记录落盘后不改不删；并发走单写者队列 + 版本号乐观校验（主设计 4.2）

git 后端与 Hub 机制的能力映射：

| Hub 机制 | repo 对应 |
|---|---|
| append-only 版本日志 | commit 历史（diff / blame / 回溯） |
| `pending_approval` 人工门 | open PR + required review（平台级硬门——最有价值的一项：没 merge 就没进主分支，任何客户端绕不过） |
| decision（approve / reject） | merge / close PR |
| 「该审批了」的通知 | 平台通知 / watch / webhook |
| 团队共享与认证 | 仓库权限体系 |

注意分工：PR 状态只覆盖**审批段**（pending_approval / approved / rejected）；designing / implementing / reviewing 的流转仍由派生函数从记录序列计算——git 不提供这部分语义，派生层不可省。

### 3.2 生命周期

- 记录**永不删除**——完整历史本身就是审计与复盘的素材，这是「替代文件中转」的价值来源之一
- task scope 的 closed 是吸收态（主设计 3.2）；project scope 没有结束状态

### 3.3 访问通道

| 通道 | 谁 | 用途 |
|------|----|------|
| MCP 工具 | Agent（及人用的任意 MCP 客户端） | 读写记录 |
| GET /state | Notifier、人 | 状态概览（派生视图） |
| 直接读文件 | 人、调试、降级方案 | 存储就是本地 JSON，所选 Agent 不接 MCP 时的兜底 |

### 3.4 规模与边界

- **代码变更统一引用 commit**：payload 不内联 diff、不列文件明细——`commits` 字段引用 git commit，文件清单与全文从 commit 取（`git show <commit>`）。body 需要讨论某段代码时按需摘录关键 hunk，那是理解线索，不是变更副本。没有大小分档，也就没有降级规则
- **多模态**（截图等）：暂不支持，字段预留（如 `attachments?`），形态待定
- **代码本体在 git**：Hub 是过程的记忆，不是代码的镜像；body 里按需摘录的 hunk 只是理解线索

## 4. 完整示例

一条 fail_code 的 review 记录：

```json
{
  "version": 4,
  "task_id": "auth-refactor",
  "role": "reviewer",
  "agent": "codex-cli",
  "model": "gpt-4o",
  "content_type": "review",
  "timestamp": "2026-08-15T10:30:00Z",
  "payload": {
    "summary": "核心逻辑正确，token 过期处理缺失",
    "verdict": "fail_code",
    "ref_version": 3,
    "body": "## 总体评价\n\n实现与 design v1 一致，命名清晰。\n\n## 问题列表\n\n1. **[high]** `src/auth/middleware.ts:42` — token 过期未捕获，会 500。建议在 verify 外层加 try/catch 返回 401。关闭条件：过期 token 返回 401，且有测试覆盖该分支。\n2. **[low]** `src/auth/routes.ts:18` — 重复的日志调用。关闭条件：删除重复调用，日志输出不变。\n\n## 建议与延后候选\n\n未提出延后候选。修完问题 1 后重发 revision。"
  }
}
```

## 5. 演进策略

- **字段只增不改**：新增可选字段不算破坏性变更；已有字段不删除、不改语义（与 AGENTS.md 的 schema 向后兼容约定一致）
- **模板在 skill 里迭代**：用真实任务验证模板是否好用，改模板不动 schema
- **新 scope 类型**（如按团队/个人分 namespace）：多任务并发时再定
