# Standalone 宿主

本文实现 [宿主契约](system-design.md#7-宿主契约)。

## 1. 服务电源

```sh
tut config set power.mode standalone
tut up
tut down
```

up 以同包绝对入口拉起 detached Hub、Notifier 及显式开启的 watcher，各服务独立进程组。PID、PGID、端口、启动时间与身份凭据落 `.context-hub/power.json`，日志留在本 rig 存储目录。复用前核对归属，只补缺服务；复用服务保留原 power session，没有本 rig 进程身份事实不授予发信号权限。

根定位与 Hub 身份发现见 [共享宿主契约](system-design.md#72-冻结计划与路由)。

新服务从 3001/3002 起选空闲端口对，显式事件端口保留。端口预检不提供预留，竞争由绑定及启动后复验可见失败；选定端口后再次发现同根 Hub，归属和唯一性复验失败即非零退出。

非 dry-run up 一律先取得 `.context-hub/up.lock`，显式 --url 也不例外，供给结束 finally 清理。锁含 pid / started_at，活 PID 拒绝，确认 ESRCH 才接管；stale 回收以 .reclaim mkdir 互斥并复核身份，内容不明或回收中断不得猜死亡。dry-run 不取得锁。

down 读取本 rig power.json，按 Notifier → watcher → Hub 逆序停服务。每组先 TERM，宽限复核后仍活才 KILL，再核对端口与原组消失；活 PID 不是归属证明，身份陈旧或不明不发信号。leader 已死而原组有成员时，仅存活成员经本 rig 登记和 TUT_POWER_SESSION 核验才可清理；标记绑定服务实例并由子进程继承，重复 up 不替换复用实例的会话。

down 失败不写已停止事实，重试仍重验，完全停机后重复调用幂等。run 使用独立进程组，down 列出活 run 并让其继续；Notifier 退出也不杀 detached run。

## 2. run 协议

四个本地命令不依赖 Hub 存活。--task 只关联任务，不授予实施权限、不隐式选 cast 或切 checkout；调用者先进入实际执行目录。

### 2.1 存储与身份

RunStore 是运行文件的唯一读写入口，与任务 Store 分离。hubRoot 按纯本地规则取 TUT_HUB_ROOT，否则向上找最近 .context-hub，找不到取调用 cwd；固定写入 `<hubRoot>/.context-hub/runs/<run-id>/`。TUT_PROJECT_ROOT、任务 checkout、在线 Hub 响应不重定向此根。

worktree 调用者通过 TUT_HUB_ROOT 钉共享根。目录独占创建，run-id 是紧凑 UTC 时间戳加八位十六进制随机数（如 `20261016T175330816Z-a1b2c3d4`），冲突重新生成；路径段、run 目录、meta/log 类型与符号链接均校验。目录 0700、文件 0600，尊重更严格 umask，不存完整环境变量。

每 run 一个只追加的 `log` 与原子更新的 `meta.json`，不自动截断、轮转或清理。失败目录保留，ps 显示 incomplete。meta 是可变快照；「只增不改」约束字段契约兼容性，不禁止生命周期更新。

临时文件和锁是操作材料，任务审计记录仍永不修改、删除。

| 字段 | 语义 |
|---|---|
| run_id / task_id? | 本地目录身份 / 调用者指定的关联任务；未知关联仍保留 |
| pid / pgid | 实际 command PID 与独立组 PGID；detached spawn 时相等，不填 CLI/监护 PID |
| argv / started_at | executable 与原始有序参数数组 / 成功 spawn 的 UTC 时间 |
| status | running、stopped 或 exited；stopped 仅表示停止请求落盘 |
| exit_code? / exit_signal? | 监护实际取得的 command 退出码/信号，未知省略，不推造成功 |
| agent_session_id? | 从本次完整原生 JSONL thread.started.thread_id 识别；不扫描其他会话、不猜测、不改 argv |
| stopped_by? / stopped_at? | 首次停止请求的 OS 用户及调用进程 / 请求落盘时间；不是人工审批证明 |
| supervisor_pid / cwd | 每-run 原监护 PID / 调用 run 的执行目录 |
| checkout? | anchored 模式工作区声明校验后的落点（绝对路径）；其余场景缺省不出现 |
| ended_at? | 实际根 exit 已取得、原组确认消失并完成本地收尾的时间；不是任意后代清零证明 |
| identity_probe? / identity_ack? | stop 新鲜随机挑战 / 原监护响应；仅活着的 PID 不够证明归属 |
| control_protocol? | 当前 run 为 cooperative-v1；缺少此字段的 run 仍可读 |
| stop_request? | 唯一停止请求、阶段、信号证据与最终结果；具体结构见下 |

未知字段读改写时保留。每 run 的短 meta 文件锁覆盖「重读 → 合并 → 同目录唯一临时文件 → rename」；跨进程写入不丢字段。只在 ESRCH 确认锁持有者已死后，以独立回收互斥与 inode/内容复核回收旧锁；

活锁、EPERM、损坏或归属不明的锁不强抢。meta 锁不跨信号等待、日志排空或网络。

running 表示未正常收尾且尚未记停止请求；leader 退出但原组仍有后代也保持 running。stopped 表示请求已落盘，不证明停止完成；监护后续保留 stopped 并补真实退出结果。

exited 是没有停止请求的正常生命周期收尾，非零退出同样是 exited。监护失联/重启可能留下陈旧快照；ps 如实展示，不改写或补造 exit_code。

### 2.2 启动、日志与围观

`tut run [--task <id>] -- <command...>`：分隔符前只解析 wrapper 旗标，之后逐项保留 argv（含空参数、引号字符、空格、美元符号、同名旗标），不经 shell、AgentRoute 或第二次分词。缺分隔符、缺 executable、未知/重复旗标报错；支持 --task=value。

短命 run CLI → detached 每-run 监护 → detached command 独立组。监护通过同包绝对模块路径和 process.execPath 启动，位于 command 组外；不监听端口，不自动重启，无全局 daemon。command stdin ignore，stdout/stderr 共享 append log FD，CLI 返回后输出仍可读，无整段内存聚合或 maxBuffer 限制。

wrapper 不延缓已写字节；程序自身缓冲、跨流因果顺序无法保证。半行、UTF-8、长行及无末尾换行保留，监护错误有 `[tut supervisor]` 前缀。

command spawn 成功、初始 meta 原子落盘后才确认；stdout 一行 run-id、退出 0，表示启动成功而非任务成功。启动握手最多 5 秒；ENOENT/EACCES、不可写 runs、初始 meta 失败响亮报错；

spawn 后初始化失败清理已知组。超时/调用者失联保留身份/目录，不能盲重试。监护取得真实 exit，并继续等待原组收尾；退出与停止请求在同一 meta 锁内合并，不留下 ended_at 已有而请求永久无结果的快照。

`tut ps [--json]`：只读目录与正 PID/负 PGID 存活；ESRCH 才表示 absent，EPERM/其他错误为 unknown。保留 runs/errors 与 pid_alive/group_alive/supervisor_alive/stale 等 JSON 字段，原 meta 的停止阶段、结果、范围也完整返回。人读表列 run-id、task、状态、PID/组存活、停止阶段/结果/范围、起始时间和 argv。

cooperative-v1 未收尾且监护确认消失标 stale；原组消失但监护仍在处理请求不提前解释为完成。无 runs 是空结果，不创建目录；坏/残缺目录逐项报告，其他健康项照常显示，汇总非零退出。

观察范围为根与原进程组。RunStore.logInfo 与 openLog 共用 O_NOFOLLOW 和普通文件验证，以 O_NONBLOCK 只读打开后 fstat，FIFO 无写端也不阻塞；检查失败与结束都关闭 FD，不读正文。

`tut attach <run-id>`：只读回放末尾 50 行（含末尾半行），再以独立字节游标、100ms 轮询跟随，处理背压。多个 view 互不影响。cooperative-v1 等监护合并最终结果/ended_at 后排空尾部退出，不因 stopped 或组暂已消失提前成功；停止结果 incomplete、已知监护死亡而无终态则排空后明确报错。

无 control_protocol 的 run 仅以原组结束作为只读判据。Ctrl-C 只结束当前 view、退出 130，不改 meta、不发信号给 run。

### 2.3 协作停止与预算

headless 协作停止由原监护向正根 PID 发一次 SIGINT，等待实际根 exit 与原组消失；不向非 TTY stdin 写 0x03 / Esc，不先对负 PGID 广播 INT。保留 command 原 argv，不猜或替换原生 child PID；shell wrapper 不转发信号时走既定熔断。

stop CLI 只通过 RunStore 写请求、读结果，不执行终止信号；原监护持有实际 ChildProcess 和 exit 事件，唯一执行停止。CLI 校验协议与原监护新鲜挑战（最多 1.5 秒）；监护校验初始 run_id、PID/PGID、supervisor PID、started_at、cwd 和协议。

失联/身份变动保守报 identity-unverified，不按历史号码恢复清扫。

挑战通过后，短锁内重读并一次原子写 status=stopped、首次 stopped_by/stopped_at 和 stop_request。id 为唯一随机请求 ID；requested_at/requested_by 与首次信息一致；phase 从 requested 经 cooperative/term/kill 到 completed 或 incomplete；

accepted_at 记录监护接受时刻，根已先退出则 reason=leader-already-exited。初始写盘失败零终止信号；锁内已完成正常退出则不伪造打断。

监护先落阶段与信号意图，再发一次**正根 PID SIGINT**；仅在实际 child 尚未观察到 exit 时发送。协作 5 秒内等待根 exit 与原组 absent 同时成立。根先退出、原组后代仍在时留足剩余协作时间；

请求开始时根已退出则跳过 INT，直接进入原组 TERM 兜底，不信号可能复用的旧根。

协作预算耗尽且原组仍在时，重读同一有效请求/身份后向**负 PGID SIGTERM**，再宽限 5 秒；仍在才**负 PGID SIGKILL**，最后最多 2 秒复核。每次升级重新探测，不向已确认消失的组重发。期限用单调时钟从实际信号系统调用计时，不因轮询/并发/重复请求重置；

内部测试注入点不作为公共调参旗标。

signals 数组最多三条：signal、target、intended_at 与 delivery；意图先落盘为 uncertain，系统调用返回后再记 sent/sent_at、esrch 或 error/error 文本。意图不是已发送证据，崩溃间隙不得据此重放。阶段/信号/最终结果写盘失败、EPERM、根退出未确认、组探测 unknown、预算耗尽均不能成功。

失败尽可能落 incomplete，落不下则保留中间阶段及 log 诊断，调用者有界报未确认。

result 保存 outcome（cooperative / forced-term / forced-kill / already-ended / incomplete）、success、completed_at、实际 root_exited/group_alive/exit_code?/exit_signal? 与错误原因。明确 scope=root-and-original-group、descendants_check=not-performed。成功必须实际根 exit 已取得、原组 absent 且最终结果和 ended_at 同一原子快照落盘；退出码本身不是协作完成证明。

CLI 返回 0 只代表这个可观测范围完成，输出必须点明阶段和范围，不能声称任意后代已清空。

请求落盘后 CLI 等最多 15 秒，超时/监护失联返回 incomplete/unconfirmed，不撤销或重发请求。并发调用共享首次请求/最终结果，或在首次请求初始化锁忙时明确报 in-progress；不覆盖首次操作者/时间，不重复 INT，不重启宽限。stop CLI 退出后监护继续；

完成后重复 stop 只读原结果。没有结果的旧请求不当作新请求，由现场处置。最终退出与请求合并在锁内重读后完成。

### 2.4 兼容数据与操作审计

无 control_protocol 的 run 可读取、围观；终态 stop 报 legacy/group-only，不发信号，活跃时 stop 报 legacy-control/unsupported，不投递无人消费的请求。log / meta 保持原样，不补造 cooperative 证据。

run/stop 可选 Hub 工作在同包短命子进程中，以 2 秒总预算隔离网络，接受 loopback HTTP，校验 `/state?include=closed` 返回的绝对 hub_root 与本地根一致；不发现/启动 Hub、不盲重试写入。run 独立成功后验证 --task 关联，缺失/降级/离线/旧 Hub 只提示未验证。stop 的唯一请求创建者在本地结果后 best-effort 发布 project note，携带 task_id?、run_id、请求/结果、实际阶段及范围；

role=human、agent=tut 沿用系统操作痕，正文明确不是人工审批/授权，不含 decision/ack/launch、不唤醒任务。重复/旁观 stop 不重复审计；创建者提前退出可能留审计缺口。网络失败只提示 note 未确认，不离线排队或盲重放，不改变本地事实。

run/stop 仅 macOS/Linux；Windows 在创建/发信号前报不支持，ps/attach 可只读历史文件，组探测显示 unknown。运行时不扫描进程表，不依赖 /bin/ps 或 /proc，不追踪/跨组强杀后代。进程组不是任意子进程树隔离容器，主动 setsid/setpgid 后代可能逃逸；

cooperative 只说明根和原组收尾，真实 Codex 是否自行清理跨组工具须在停止完成后用一次性独立 ps/pgrep 身份核验，不把人工补杀算通过。PID/PGID 探测与信号非原子操作，新鲜原监护不消除任意复用风险。已写文件/外部动作不能撤销；停止不自动回滚已发生的动作。

跨重启恢复、自动 GC、远程 run 均不属于 run 协议。

## 3. headless 发车链

本章对应共享宿主契约开关表中的 launch_mode=headless，独立于电源与 flow_mode 的选择。

### 3.1 计划与 checkout

headless 由 Notifier 自动启动，手动 run / resume 使用同一运行库。计划由 src/standalone/launcher-headless 构造，直接调用同包 RunStore / startRun / stopRun，不调用 PATH 上其他 tut，也不使用终端 birth / 按键。

共享根目录与 route 定义见 [冻结计划契约](system-design.md#72-冻结计划与路由)。

`launch.checkout` 精确接受 rig / anchored，缺文件 / 缺节 / 缺键为 rig，损坏或非法值拒绝当次启动。此键由人手改 config.json，不在 config get / set 引擎注册；每次合法启动现读并冻结。rig 按共享任务 checkout 解析，未声明 worktree 时 cwd 为 hubRoot。

anchored 只读取 description 的「工作区：<绝对路径>（分支 <分支名>）」声明，格式与 Host skill 一致，路径可含空格，至括注或顿逗截止。分支括注可省，写了却畸形即拒绝。无声明回 hubRoot 并记日志，TaskMeta checkout 不豁免此回落；有声明时依次校验：

1. 路径存在。
2. 是 git worktree，以文件判定，不执行 git；主 checkout 需 .git 下 HEAD / objects / refs。相对 .git 指针从声明目录解析；linked worktree 校验 gitdir 的 HEAD / commondir / gitdir 与公共仓布局，独立 gitdir 须自身完整。
3. 写明分支时，当前分支与声明一致。

声明畸形或任一事实失败拒绝，不回落。TaskMeta 与声明同路径时由声明校验裁定，不同路径报配置矛盾并点名两者。校验落点写 RunMeta.checkout，rig 模式不写此字段。

### 3.2 原生命令与会话

macOS / Linux 支持 Codex 原生 exec / exec resume 加 JSONL，Pi 原生 --print --mode json --session-id。prompt 保持单个参数，route 的模型 / 配置 / 权限参数保留，不自动增加 bypass 或批准参数；已含 exec 不重复插入，不能确认子命令或 session selector 则拒绝。其他 agent 报 unsupported-headless-agent，Windows 在 marker / spawn 前拒绝，不自动换后端。

每轮新 run / 进程组。Architect 总是新会话；Executor / Reviewer 按逗号分隔的 TUT_CONTINUITY_ROLES（缺省 executor,reviewer）只复用同 rig / task / role / route / checkout 且前轮完整结束的精确身份。Codex 用本 run thread.started 的已观测 ID；Pi 用首次指定的独占 UUID designated_session_id，不冒充 observed 身份。缺身份 fresh 并记原因，resume 失败不静默 fresh 重试，不猜 --last / --continue。

### 3.3 代次、准入与恢复

在线新增 note 仅接纳 role=human、非 ack、无 payload.launch 的人工指示，同拍合并到最新代次；worker / ack / 系统观察不唤醒。人工 note 不具有 approve 或扩围效力。既有 marker 也计启动证据；版本冲突重读一次，已覆盖则 skipped，否则失败，不用过期计划 spawn。

同任务所有角色串行。starting、running、停止无完成结果、根退出但原组仍在、身份或握手不明均占用；期间只保留一个候选，不阻塞其他任务。完整结束后重取状态 / 日志、判门、读 mode 再消费候选；显式 stop 清掉已待处理候选，之后须新的人工指示或合法下一轮。

切 tui 不停已有 run、不提前放行第二 writer；人工换后端须先结束原轮次，手动 TUI --force 不提供跨后端仲裁。

初始 meta 原子保存受限 headless 归属：role、attempt、base / trigger、route / 来源及 session 原因 / 指定身份 / 源 run，不覆盖 PID / PGID / 控制字段。attempt_id 与 run_id 不同。RunStore 的 headless-start.json 保存不含环境的启动意图，确认 spawn 失败写 failed，握手不明留 pending。原监护先记录实际 root_exited_at 和 exit，原组消失并完成合并才有 ended_at；Notifier 不缓存 stdout / stderr。

冷启动 restore 重建占用。每轮 syncNew 纳入 CLI 新建的受管 resume 和 pending headless-start 预留；pending 可接替已完成旧座位，不覆盖活跃或 unknown 座位，确认 known-failed 后释放该预留。close 观测沿取消候选、等待启动，再 stop 明确归属 run；approve 不停止，失败或 unknown 不直接 kill、不删目录。

自动启动在 admission 锁内重验当前 state / 增量日志。日志读取失败不放行；日志比 state fold 新则有界刷新一次，仍不一致拒绝。close / pending_approval / approved、角色改变、attention 或另一 attempt 的 marker 已服务本代时，丢弃过期 plan，仅日志、不发 give-up、不重放候选。接缝由 HeadlessRuntimeDeps 的 hubUrl / revalidate 和 createHeadlessRevalidate 提供。

`launch.catchup` 精确为 off / on，缺省 off；on 时仅 auto + headless 在启动基线完成 restore / syncNew / observe 后执行一次补判。每个在册 agent 等待任务复用门、白名单、launchBlocked 与自动启动，已有合法 marker 只记跳过，不补 marker 或通知。读取故障交同一路径重新检查并可见失败；配置不可读 / 非法只记 withholding，off 与 tui 不执行补判。该动作不参与后续常态轮询。

### 3.4 失败通知

真实 spawn / 握手失败，或非主动停止的根非零 / 信号退出，产生 headless give-up。按 attempt 先占 key 再 await Channel，FIFO 上限 1024，去重限 Notifier 生命周期；主动 stop 不报意外失败，失联 / 坏元数据报 unconfirmed，不编造退出码。mode / 平台 / checkout / agent 预检拒绝不伪装 spawn 失败。

正文含 task_id / title、role、agent、attempt_id、reason、received_at，已知时加 run_id 和实际 exit_code / signal，指引 ps / attach / read。不含 Enter 指引、不自动重投；通知失败只保留本地日志。

## 4. 精确续跑

```
tut resume <run-id> [instruction] [--fix-preflight]
```

- 源 run 只接受**完成证据**（`ended_at` 存在，且有 stop_request 时其 result.success=true）；running、仅 stopped、停止未完成、握手不明一律拒绝，且**绝不隐式 stop/kill 源 run**。
- 每次续跑生成**新 run-id、log、PID/PGID 与 attempt**；新 meta 记录 `resume` 溯源（schema、from_run_id、agent、session_id、身份来源 observed/designated/argv、requested_at/by）。旧 run 证据字节不动。
- 会话身份：
  - codex：只用源 meta 观测到的 `agent_session_id`，构造 `codex exec resume <id>`；不用 `--last`，不做 fresh 回退。
  - pi：`headless.designated_session_id` 或 TUT 构造 argv 中的 `--session-id <uuid>`；**必须**在本项目 pi 会话库（`~/.pi/agent/sessions/--<cwd-slug>--`，支持 `PI_CODING_AGENT_SESSION_DIR`）头部核验到精确 id+cwd。pi 的 `--session-id` 缺失时会**新建会话**，故核验失败=拒绝（`pi-session-not-found`），绝不伪造恢复。
  - 其他 agent / shell 包装 / 不可区分 positional：显式 `unsupported`。
- 指令是单个字符串参数（`--` 后可传连字符开头内容）；不提供指令时普通 run 用继续提示、受管 run 用 role 门铃。指令不被解释为 approve/ack/扩围证据。
- **准入**（`src/core/run/admission.ts`）：同一 rig 下，同会话身份（或受管任务任意角色）仍被未完成 run / pending 启动意图占用时拒绝 spawn；known-failed 意图不阻塞。会话匹配覆盖整条生命周期证据链：observed `agent_session_id`、`designated_session_id`、`resume.session_id` 溯源、以及结构化 argv 选择段（codex `exec resume <opts> <id> <prompt>` 允许 id 前有选项）。验证→预留（`resume-start.json` 在 fork 前落盘）→spawn 全程持 `admission.lock`；锁不跨越 agent 生命周期。
- **受管临界区**（`executeManagedResume`）：同根 Hub 在线（GET `<base>/state?include=closed` 校验 hub_root，先于任务查找）、任务 waiting `agent:<role>`、无 needs_attention、非 pending_approval/approved/closed。判门事实必须**版本一致**：日志最大版本若超过 /state fold 版本（两读之间有新记录落地），有界刷新一次 /state；仍不一致即拒绝（state-inconsistent）——过期状态永不授权 spawn。

  受管续跑随后扫描占用；乐观 expected_version 追加带 `resume_from_run_id` 的 via=manual 启动 marker（VERSION_CONFLICT 在同一锁内重新判门重试）；随后 spawn。源 run 自身的历史启动 marker 不阻挡显式续跑（其未完成排他由准入承担）；auto 候选的查重仍依赖追加的 marker。
- stdout 只输出新 run-id；退出 0=启动确认。项目 scope 的 `operation=resume` note 尽力发布（系统操作审计，非授权）；Hub 不可达仅 stderr 提示，不撤销已启动 run。

RunMeta.resume 为可选 ResumeSource，旧 meta / log 保持可读。

## 5. close 停止审计

- Notifier 观察任务进入 closed → 取消候选 → 等待该次启动 → 既有 `stopRun`（协作协议不变）→ 向**已关闭任务**追加系统 note：`role=human, agent=tut, content_type=note`，`ref_version` 指向日志确认的有效 decision(close) 版本（非任务最新版本）。
- payload 字段：`operation=close-stop`、`audit_id`（`close-stop:v<close版本>:<run|attempt>`）、task/run/attempt、stop 请求与结果（requested/success/result/phase/outcome/completed_at）、真实 exit、`scope=root-and-original-group`、`descendants_check=not-performed`。close 版本取使任务**进入** closed 的首条 decision(close)（吸收态下后续 close 为幂等重决，不替代有效关闭版本）。
- 已结束写 already-ended；只发起请求/异常/握手不明如实 incomplete/error；无归属 run 不造记录。audit_id 去重：双观察不双 stop、不重复审计。Hub 失败本地一行日志，不盲重试、不回滚 close 与停止结果。

## 6. 只读座位

```
tut live-view --layout <json-file>
```

- 布局 v1：`{schema:1, rows, columns, seats:[{id,row,column,label?,selector}]}`；selector 二选一：`{task_id,role}`（仅匹配**明确 headless 归属**，普通 task_id 关联不猜 role）或 `{run_id}`（固定，不追新 run）。非法输入在任何子进程之前报错。
- 座位解析：未完成 run 唯一→显示；多个→冲突；全部结束→最近 `started_at`。新 run 接替同座位：旧 attach 停止、缓冲清空、标新 run-id。
- 每座位仅运行同包 `node <abs dist/cli.js> attach <run-id>`，**stdin=ignore**（fd0=/dev/null），父进程不建任何键入通道，不调用 stop/resume/decide。Ctrl-C/关视图只结束本进程与 attach 子进程；被观察 run 不受影响（可用另一个 attach 围观）。座位在子进程 **close**（stdio 排空后）而非 exit 时收尾：正常退出前排出的最终尾流完整保留在最后画面；换座仍以座位当前 child 身份守卫隔离旧代次迟到数据。
- 渲染层净化：日志中的 CSI/OSC/转义序列与控制字符在视图层移除/替换，原始 log 字节不改。缓冲有界（2000 行/行 4096 字符），UTF-8 跨块安全，CJK 双宽对齐，resize 重绘。非 TTY 明确拒绝并指向 `tut attach`。

## 7. checkout preflight

- 检查目标=**实际执行 checkout**：run 的 cwd、resume 的源 cwd、auto 冻结的 checkoutRoot（与 hubRoot/routingRoot/安装根区分）。
- 适用面：有 package.json 且声明依赖→查 `node_modules` 存在可读；`name=take-ur-turn` 源码 checkout→查 `dist/cli.js` 与 `dist/core/run/supervisor.js`；无 manifest/无依赖→not-applicable（不妨碍任意命令与非 JS 项目）。权限/坏 manifest=error，不误报 missing。
- 默认仅诊断：run/resume/auto 在 marker/spawn 前拒绝并列修复命令；auto 永远 report-only。修复步骤失败（非零/信号/超时）一律拒绝，即使半途产物已使存在性复查变绿。
- `--fix-preflight`（run/resume/doctor）：仅修 preflight 项——锁文件下 `npm ci`、TUT checkout 依赖就绪后 `npm run build`；每步 raw argv、固定 cwd、有界、可见（输出经 stderr，机器 stdout 只承载命令结果）、失败即止、完成重查；不改 manifest/lockfile、不升级、不跨目录。doctor --fix-preflight 的修复步骤失败时退出码取更严者（不为半途修复报成功）。
- doctor 的第九项为 `checkout preflight`；`--checkout <dir>` 指定被查目录（缺省 cwd），`--root` 仍是存储目录。缺 dist 源码用**已安装** tut 自举：`tut doctor --checkout <源码路径> --fix-preflight`。Hub 不可达时本地 preflight 照常输出。

检查仅证明产物存在且可读，不保证依赖完整、版本正确或构建新鲜。

## 8. 用量 watcher

`scripts/usage-audit/` 是独立测量进程，usage_audit 为 off / on，缺省 off。Hub / launcher / Notifier / worker skills 不 import 或启动它；standalone up 在 on 时 detached 启动同包 --watch，日志为 .context-hub/usage-audit.log，脚本缺失或 spawn 失败提示但不阻断电源。

off 的 watch 只读开关后退出，不读 Hub、原生会话或 usage，不建锁 / timer；运行中每 pass、操作间及提交快照前检查，关闭后结束并释放锁，重新开启须显式再启动。显式 since / backfill / recover 不受 watch 开关限制。任务及记录通过同根在线 Hub 接口读取，无离线直读回落。

canonical root 的 SHA-256 对应 OS tmpdir 中的单实例锁；仅 ESRCH 确认死 PID 后，以 .reclaim mkdir 互斥回收，空 / 坏 / EPERM 锁按活处理。每次 Hub 读取含握手和响应体限时默认 30s，TUT_USAGE_AUDIT_TIMEOUT_MS 可指定正整数；watch 的 --timeout-ms 限总寿命，到期不发起新 pass，在途 pass 可完成。

初次协调已有交付，此后每 pass 重读 Hub 任务历史；原生文件按 mtime + size 缓存未变化项，消息正文解析即弃，只留元数据。重复相同失败首次及每第 20 次记日志，结果变化才重报。watch 每 60s 独立 stderr heartbeat，含 timestamp / last_successful_pass / consecutive_failures / in_request；结束移除 timer，off 和单次模式无 heartbeat。

只访问本机 Hub，不外传正文；诊断不含内容，usage 落盘剥离 cwd / task_id / launch_ts 路径信息。
