# Common Rules（全角色共同规则基座）

本文件为全角色共同规则，与各角色 skill 共同生效；各角色 skill 只保留角色差分。

## 写通道与身份

- 写通道双份：有 MCP 用 MCP 工具（`context.*`）；没有 MCP（纯 bash 环境）用 `tut` CLI，两者等价。
- role 字段固定写你担任的角色（约定枚举：architect | executor | reviewer | human，精确小写）。

## flow 三态

flow 由发起侧建任务时选定（create 的 `--flow` / MCP `flow` 字段，缺省 `full`），落库后不可变——选错只能 close 重建：

- **full**（缺省）：design → 实现 → review → 人审批的完整四阶段。
- **direct**：repo 已有现成设计，任务从 implementing 开始，日志里的 design 记录只是参考（不转态）。**description 即指针**：direct 单的设计指针在任务 description（如「按 design/X.md 第 N 单元…」），接单即按指针读文档开工，无需等 design 记录、也不必自发发参考 design note。
- **solo**：小改动免审——code_changes 直接进 pending_approval 由人拍板；被打回（reject）时回到 implementing 重做，重做后仍发 code_changes——solo 里没有 revising，revision 记录属表外。

## 接手读序（三层）

| 层 | 回答的问题 | 怎么读 |
|----|-----------|--------|
| 1. git 权威文档 | 现在是什么样、该怎么做 | 直接读仓库文件：`AGENTS.md`（开发约定，含「完成编码后必须运行测试/构建验证」的硬规则）、`design/` 下本任务相关的设计文档（不经 Hub） |
| 2. project scope 决策流 | 为什么会是这样 | `context.read {"task_id": "project"}`（CLI `tut read project`） |
| 3. 任务日志 | 这件事进行到哪 | `context.read {"task_id": "<id>"}`（CLI `tut read <id>`） |

第 2 层注意项目级约束与不变量（如「零运行时依赖」「schema 只增不改」）——违反约束即问题，实现会被 review 打回。

## 版本与增量

- 增量读取：read 返回的 versions 数组每条带 version，之后用 `"since_version": N`（CLI `--since-version N`）只取新记录。
- **expected_version 的正确用法**（两种通道通用）：值 = 你看到的任务当前版本——read 到最新记录 version 是 N 就带 N。带对了能抓住并发写入：别人先写了一手，你的发布会报版本冲突（MCP 返回 isError；CLI 非零退出码、stderr 首行是 VERSION_CONFLICT）——重读日志再发。不带也能写（跳过校验），但带上是更好的习惯。

## 工具总则

- MCP 五工具 `context.create / publish / read / list / decide` 与 `tut` CLI 一一对应。CLI 语法以 `tut` 无参打印的 USAGE 为准（`--flag value` 与 `--flag=value` 均可），不发明不存在的 flag。
- 脚本化消费原始 JSON：`tut read <id> --json`、`tut list --json`。
- 可选 `--agent` / `--model`（MCP 同名顶层字段）自述身份，供追溯——**不知道就留空，不要猜**，自报字段宁可空、不可错。
- `decide` 是人工审批入口，worker（architect / executor / reviewer）不调用；host 的代行属受托执行，同样只在人的明确授权下发生。

## 授权基线

**授权基线 = 建任务 description + role=human 的记录**。worker 的 design、交付、review 或 note 只是提案，不能自行扩围；符合设计文档不等于属于当前任务。批准局部修订不等于扩大整体授权。代人行操作的授权必须可回溯到人的原话（会话原文或 Hub 记录位置）；role=human 标签本身不替代人的授权证据。

## 延后流程

Agent 只有建议权或申请权，延后入口随角色（见各角色 skill）。拍板（原任务 note、非 decision）与 project scope 登记都由人自行或明确委托的 Agent 执行——未受托不要代登记，也不由你跟进后续；引用拍板记录的 version，已延后问题按拍板核销。
