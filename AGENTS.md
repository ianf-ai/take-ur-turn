# AGENTS.md

本文件给参与本仓库开发的 coding agent（Codex CLI / ZCode / Pi 等）提供项目约定。

## 项目简介

TUT（Take Ur Turn）：多 coding agent 协作系统。核心是 Context Hub——本地 MCP Server，作为 Agent 之间的共享记忆；任务状态由记录序列派生（纯函数，写入永不因流程被拒），Notifier 轮询状态变化、按 manual/auto 模式驱动设计 → 实现 → Review → 修改的流转，人只做关键节点审批。

当前有效方案是 [design/system-design.md](design/system-design.md)（系统设计文档），开发以它为准。开发前必读：

- `design/system-design.md` — 架构、状态派生规则、MCP 工具 schema、代码结构
- `design/context-design.md` — 上下文放什么、怎么管理（scope、记录类型、正文内容要求）

## 技术栈

- **语言**：TypeScript（Node.js ≥ 20）
- **MCP SDK**：@modelcontextprotocol/sdk
- **存储**：本地 JSON 文件（`.context-hub/` 目录，按 task 组织，每次写入带版本号）；全部读写经 Store/HTTP 接口进行，新功能不得绕过接口直接操作存储文件
- **依赖原则**：当前零运行时外部依赖（MCP SDK 除外，zod 与 SDK 并列显式声明以保单实例），不引入数据库

## 目录结构（约定）

```
take-ur-turn/
├── design/
│   ├── system-design.md               # 系统设计（当前有效方案）
│   ├── context-design.md              # 上下文设计（放什么、怎么管理）
├── skills/            # Agent skill 文本
├── scripts/           # 粘合脚本（信号源 / 启动器契约）
├── src/               # Context Hub 源码
├── test/              # vitest 测试
└── .context-hub/      # 运行时数据（gitignore）
```

## 开发约定

- 开发机全局 `tut` 命令必须指向安装版（`npm i -g take-ur-turn`），禁止 npm-link 到仓库 live dist——并发 build 会中断所有 tut 消费者（含 TUT 自身迭代时的 hub/launcher）。


- 完成编码后必须运行测试/构建验证，不允许只改代码不验证就交差
- 状态派生规则以 `design/system-design.md` 3.1 节的规则表为准，修改规则属于设计变更，先在 system-design.md 中更新
- MCP 工具的输入输出 schema 保持向后兼容；破坏性变更需在任务中明确说明
- 并发写入同一任务时需处理文件锁或乐观并发
- 提交信息使用英文，格式：`type: summary`（如 `feat: add context.publish tool`）

## 不变量（所有 Agent 必须遵守）

- **记录永不删除**：`.context-hub/` 落盘的记录是不可变的审计材料；处置误写的正确动作是 `tut decide close` 或补一条说明 note，绝不是删文件
- **写入永不拒绝 ≠ 许可**：Hub 不做流程执法是信任设计，任何 Agent 不得利用写入自由绕过人工审批门
- **预写答案的评测材料存放纪律**：预先写明答案或预期结果的材料（预写答案的评测方案、含预选结果的实验材料）不得放入本仓库——Agent 会读到预写内容——存于仓库外

## 角色分工（多 Agent 协作时）

| 角色 | 职责 | 典型载体 |
|------|------|---------|
| Architect | 需求分析、技术方案、架构决策 | Codex CLI (GPT) |
| Executor | 编码实现、按 review 反馈修改 | Pi (GLM) |
| Reviewer | 代码与方案 Review | Codex CLI (GPT) |
| Host（驱动者） | 主会话驱动：环境检查、任务发起与范围冻结、轮次推进、审批点汇报、异常处置与纠偏落实——驱动不代工 | 任一主会话 Agent（ZCode / codex 等）；担任时加载 `skills/host.md` |

**approve = 工作验收**。仓库层质量门不属于任务生命周期，任务层不模拟 PR 循环，不设置或复活 hold 门等仓库层质量门；approve 后的修改诉求以新任务承载。

授权基线为建任务 description 与 role=human 的记录；worker 记录只是提案，批准局部修订不等于扩大整体授权。人可授权任一 agent 代行机械操作，但代行的授权必须可回溯到人的原话，role=human 标签不能替代人的授权证据。

各 Agent 通过 Context Hub 的 MCP 工具发布/读取上下文，不依赖手工维护的中转文件（传统 design.md / review.md 转交模式）。
