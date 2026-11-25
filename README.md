# TUT — Take Ur Turn

[English](./README.md) | [简体中文](./README.zh-CN.md)

Multiple coding agents — different models, different CLI tools — collaborating in the same project: context is shared automatically, the workflow advances on its own, you drive it all from a conversation, and humans only step in at approval gates.

TUT is a multi-agent collaboration system that runs on your local machine. Its core is the **Context Hub** — a local MCP server acting as shared memory between agents (an append-only task log). Task state is **derived** from the record sequence by a pure function; the Notifier polls for state changes and drives the design → implementation → review → revision loop in manual or auto mode; humans make the call only at approval points.

## The Problem

The conventional way to coordinate multiple agents is file handoff (passing design.md / review.md around). It has three pain points:

- **Context travels by file handoff**: handoff files carry conclusions only — the reasoning and the discarded alternatives are lost. The next agent gets the "what", but not the "why"
- **The workflow is driven by hand**: the review–revision loop typically runs 2-3 rounds, each one manually triggered, with prompts retuned and context re-briefed every time
- **Tools are isolated from each other**: agent sessions cannot see one another; there is no unified state or orchestration entry point

TUT's answer: put the process memory into the Hub (writes are never rejected on workflow grounds), turn workflow state into a derived view of the log (never stored, never enforced), and make "who presses the start button" a two-mode choice — manual / auto. Humans are the workflow's critical gate, not its router.

## Core Mechanisms

- **Append-only records**: agents append records to the task log via 5 MCP tools (create / publish / read / list / decide) — design, code_changes, review, revision, note, decision. Records are never deleted; anyone starting from zero can reconstruct every decision and its rationale from the log alone
- **Derived state**: task state (where things stand, whose move it is) is not stored and not enforced — it is a view computed from the record sequence by a pure function. Combinations outside the state table (e.g. publishing a review in a solo task) still land on disk, but set `needs_attention` so a human can deal with it
- **Approval gate**: once a review passes, the derived state becomes `pending_approval`, and a **human** must publish a decision record (approve / reject) before anything continues. close is valid in any state — humans retain the authority to end a task at any time
- **Flow variants**: pick `--flow full|direct|solo` when creating a task — full runs the complete loop; solo skips the design round and review for small changes (starts implementing; review-free but not approval-free — straight to the approval gate); direct adds one review round to solo for simple changes that touch a risk surface (core paths / gates / public surface — expensive when wrong)
- **manual / auto progression**: in manual (the default), the human is notified when it is someone's turn and starts the next step; in auto, the Notifier launches the next agent directly through the launcher (with graded trust via the role whitelist), and humans only make decide calls; in either mode, a coding-agent Host session can run the whole loop on your behalf ([Host Mode](#host-mode-drive-it-from-a-conversation))

## Architecture

```
┌─────────────────────────────── local machine ────────────────────────────────┐
│                                                                              │
│  coding agent ──MCP read/write──► Context Hub ──► storage (local JSON)       │
│       ▲                            (memory + state projection)               │
│       │ launch                          ▲                                    │
│  Agent Host ──state events──► Notifier ─┘                                    │
│  (signal source + launcher)              │ reads derived state (GET /state)  │
│  two host profiles:                      │                                   │
│    herdr — agents live in TUI panes      │                                   │
│    standalone — agents run as detached   │                                   │
│    supervised runs                       │                                   │
│                                          │                                   │
└──────────────────────────────────────────┼───────────────────────────────────┘
                                           ▼ notifications
                                        Channel ──► human
     manual: the human starts the next one | auto: the Notifier starts it via the launcher
     power layer: tut up / tut down — power.mode picks the host profile (herdr | standalone)
     watch it read-only (Kibitz): /board · tut ps / attach / live-view
```

| Module | Responsibility |
|--------|---------------|
| **Context Hub** | Shared memory (append-only log) + state projection (derived view). Exposes MCP tools to agents and a read-only GET /state to the Notifier. **Responsible for memory only — no workflow enforcement** |
| **coding agent** | Several of them, across three roles (Architect / Executor / Reviewer); the role is a cast (per-task role casting), not a fixed binding |
| **Agent Host** | The host environment for local agents, with two pluggable parts: signal source (agent state events) + launcher. Two host profiles selected by `power.mode` — **herdr** (a TUI rig: agents live in terminal panes) / **standalone** (no terminal multiplexer: services and agent runs are detached process groups) |
| **Notifier** | The notification and progression hub: polls derived state, notifies the human when it is someone's turn, cross-checks whether agents delivered |
| **Channel** | Notification output (local desktop notification / webhook) |
| **Kibitz** | The read-only observation surface: the `/board` page over state and runs, plus `tut ps` / `attach` / `live-view` — no write controls anywhere |

TUT runs entirely on your local machine, organized into three planes around the Context Hub: a **state plane** (shared memory and derived task state), a **runtime plane** (the agent sessions doing the work), and a **monitoring plane** (observation, notification and progression). A **power layer** (`tut up` / `tut down`) provisions the services in one of two host profiles (`power.mode`: `herdr` / `standalone`). Watching all of it is a read-only surface — the Kibitz board and the run-view commands — that never carries write controls.

**State plane.** The Context Hub is a local MCP server acting as shared memory between agents: an append-only task log on local JSON storage. Task state — where things stand, whose move it is — is a pure function of the record sequence, derived on read and never enforced by the Hub. Consumers (the Notifier, the Kibitz board, CLI commands) all read the same view through GET /state; the Hub is responsible for memory only.

**Runtime plane.** Agent sessions are provisioned by the Agent Host's launcher, in one of two places: `tui` launches put each agent in a terminal pane of the Herdr rig, with the kickoff typed into the pane; `detached` launches run agents as supervised detached runs — the run protocol (`tut run / ps / attach / stop / resume`), native non-interactive invocations, precise resume. The backend is selected by `launch_mode`, independently of the power profile; the natural pairings are herdr + tui and standalone + detached. In every case role context reaches agents only through the Hub — sessions never talk to each other directly.

**Power layer.** `tut up` / `tut down` are the power switch for the rig: idempotent up, ordered down. `power.mode` picks the implementation — `herdr` provisions the rig as two system panes; `standalone` raises the Hub and Notifier as detached process groups with their facts in `.context-hub/power.json`, stopped by identity-gated, group-scoped signals — stale or unverifiable groups are never signaled.

**Monitoring plane.** The Notifier polls the derived state (GET /state) and consumes side evidence — pane agent-state events for tui launches, run outcomes for detached ones — then notifies the human through the Channel when it is someone's turn. In manual mode the human starts the next round; in auto mode the Notifier launches the next agent directly, gated by the per-role launch whitelist. Approvals remain a human decision in both modes.

**Read-only observation (Kibitz).** The Kibitz board at `/board` shows approvals first, then warnings, delivery rounds and live runs; `tut ps`, `tut attach` and `tut live-view` give the same read-only stance from the terminal. Watching never becomes acting: stopping a run and approving a task go through the CLI / human workflow.

Task state is derived from the record sequence:

```
designing → implementing → reviewing ─┬─ pass       → pending_approval → human decide(approve) → approved → closed
                                       ├─ fail_code  → revising → revision → back to reviewing
                                       └─ fail_design → sent back to designing
```

## Quick Start

Prerequisites: Node.js ≥ 20 and at least one coding agent CLI. The default terminal mode needs Herdr (`brew install herdr` on macOS/Linux; [Herdr releases](https://github.com/herdrdev/herdr/releases) on Windows); use standalone below without Herdr. See [Windows notes](#windows-notes) for platform boundaries.

**Install** — the npm package includes the built CLI, role skills and launchers:

```bash
npm install -g take-ur-turn
```

Run the one-time project hookup and start the workspace from the project root (both idempotent):

```bash
tut init
tut up
```

Without Herdr, first run `tut config set power.mode standalone`, then `tut config set launch_mode detached` for detached agent launches, followed by `tut up`. Stop standalone services with `tut down`. Connect your agent as described [below](#agent-cli-onboarding-one-time).

**Kick off a task** — requirements and acceptance live in the Hub; the task exists before its first round starts:

```bash
tut create --title "CLI --url flag for mode" \
           --description "Add --url to mode; acceptance: reaches the Hub call, both flag forms tested." \
           --creator your-name --role human
tut start-next TASK_ID
```

Replace `TASK_ID` with the returned task_id and `your-name` with your name. `start-next` is for manual mode; auto uses the Notifier's role whitelist. `create` accepts `--flow full|direct|solo` and per-task `--cast`; run `tut` for the full syntax.

Then use `tut status` for the overview; after an approval notification and checking the delivery, decide with `tut decide TASK_ID --decision approve --by your-name`.

Configure Herdr's [event hookup and terminal delivery](design/herdr-host.md) separately; source installation is under [Development](#development).

## Local statistics and metadata repair

`tut stats [task_id ...] [--root /path/to/.context-hub] [--json]` is offline and read-only: no Hub startup or file writes. The default batch is all local tasks except project scope; reports cover pass rates, first-review rates, revisions, blockers and role deliveries.
Quality metrics count workflow-advancing records; `blocked_external` is separate from `pass`, and solo redeliveries count as revisions outside review denominators.
No reviews means `null`/`n/a`; damaged tasks are separated from denominators; live reads are not an atomic batch snapshot.
Tokens are grouped by agent, never summed across agents; missing, stale, unresolved or invalid sidecars are coverage gaps, not zero, and unknown cost is `null`.
Usage follows worker-round attribution independently, including reference designs; see [usage measurement](scripts/usage-audit/README.md) for v1 source/line/window/counter/total constraints. `--json` includes metric definitions.

`tut repair-meta TASK_ID --from-snapshot /path/to/state.json` repairs corrupt/missing metadata through the running Hub; it refuses readable metadata and leaves records untouched.
Use a previously saved Notifier `/state` JSON file and check its provenance and age; lost in-memory snapshots cannot be retrieved after corruption.
Only title/flow/cast are prefilled; explicit flags win (cast per role), while description/checkout need manual input.
Missing/invalid snapshots warn and retain manual values/defaults; run `tut` for the full syntax.

`tut prune TASK_ID --by NAME --reason "local space reclamation" [--archive /backup/tasks]` removes one **closed** task through the running Hub, with human authorization. It first copies the entire task to `<archive>/TASK_ID` when requested, then appends and syncs an audit intent (task ID, timestamp, operator, reason, optional archive path, unique prune ID) to `.context-hub/tasks/.pruned.jsonl` before removal. Without `--archive` there is no backup; release-wide records archiving remains a manual operation.
The archive parent must be outside Hub storage; existing copies are refused. Copy/manifest failures retain the task, and partial archive copies remain for inspection. A removal failure retains its manifest intent, so inspect before retrying. The manifest is append-only, pruned IDs stay reserved, and run archives remain with their original references. `/state` exposes reserved `pruned` IDs and identifiable `prune_events`. The Notifier matches each disappearance to a new intent; restoring a task rearms disappearance alerts, including after a Notifier restart. Historical intents remain in the manifest. `--by` records authorization; it does not grant it.

## Host Mode: Drive It from a Conversation

Open an interactive coding-agent session in the project that can read the repo and run commands, then paste:

```text
Act as TUT Host and drive this task end to end: <request>
```

The AGENTS.md block maintained by `tut init` tells the agent to run `tut skill host` and load the [host skill](skills/host.md). You state the request; the Host checks the environment, shapes requirements and acceptance, creates the task, advances rounds, watches state and reports changes, validation and its spot-check at approval gates.
The kickoff delegation authorizes ordinary progression; approve/reject/close still need your explicit consent. In auto mode the Notifier launches rounds and the Host focuses on approvals and exceptions.
The Host **drives, it does not do the work**: worker sessions publish design/code_changes/review/revision. This role differs from the Agent Host runtime in the architecture.
When a CLI sandbox blocks networking, the Host uses the skill's MCP-first table and fallbacks, handing operations it cannot perform to the human.

## Agent CLI Onboarding (one-time)

Use the [bundled declaration instructions](skills/agent-onboarding.md) to describe
an installed CLI from its local `--help`; the same JSON can be filled in by hand.

```bash
tut agent add worker-x --from declaration.json  # or --from - for stdin
tut assign executor binding:worker-x
tut start-next TASK_ID
```

`agent add` saves minimal invocation intent in `.context-hub/config.json` without
TTY, session/resume samples or model probes. `binding:` is reserved for explicit
logical references; missing or invalid bindings fail without PATH/profile fallback.
Existing unprefixed commands retain their meaning. Basic bindings support managed
invocation with argv or stdin input; saving a declaration alone does not verify a launch or task delivery.
`agent setup ID [--from FILE]` optionally imports a minimal declaration or full
native profile. `agent probe ID` explicitly runs native diagnostics in an isolated
rig, may use the CLI/model, and preserves evidence and saved declarations on failure.

MCP clients use stdio `command=tut`, `args=["mcp"]` after `tut up`, launched from the intended workspace; if cwd is unreliable, set `TUT_HUB_ROOT` to the workspace directory (not `.context-hub`) and remove/update a global pin when switching projects.
Do not also configure a fixed URL for that server: it bypasses workspace discovery and can route writes to another rig. Restart the client's MCP connection after configuring it; the bridge does not change user configuration.

The bridge rechecks ownership before each HTTP request and reconnects with five bounded delays (250/500/1000/2000/4000ms), rediscovering the same-root Hub after a restart on another port. It never replays an interrupted tool call: a write may already have landed, so read the task before retrying.

Diagnostics go to stderr; stdout is reserved for MCP. Exit codes: 0 on stdin EOF, 1 for usage/internal errors, 2 for initial connection/identity failure, 3 when reconnect attempts run out; SIGINT/SIGTERM exit 130/143. After a failure, start the correct Hub and restart the MCP connection. See the [MCP bridge contract](design/system-design.md#431-agent-stdio-接入桥).
Without MCP configuration, use equivalent `tut create/publish/read/list/decide` commands; [role skills](skills/) map both channels.

### Herdr event hookup

Create `~/.config/herdr/plugins/tut-notify/herdr-plugin.toml` with top-level fields `id="tut.notify"`, `name="TUT agent events"`, `version="0.2.0"`, `min_herdr_version="0.7.0"`, `description="Forward agent status changes to TUT herdr-hook.mjs"`, `platforms=["macos","linux","windows"]` (one assignment per line).
Add an `[[events]]` table with `on="pane.agent_status_changed"` and `command=["<ABSOLUTE_NODE>","<ABSOLUTE_PACKAGE>/scripts/herdr-hook.mjs"]`. Substitute real absolute paths, without tilde/shebang/shell expansion; use forward slashes or escaped backslashes in Windows TOML paths.
Run `herdr plugin link ~/.config/herdr/plugins/tut-notify` and `herdr plugin list` to confirm enabled status. Start Hub/Notifier, run a pane agent and check notify logs for events. For a nondefault `--event-port`, set matching `TUT_EVENT_PORT_URL=http://127.0.0.1:PORT/agent-event` in the plugin/launcher's inherited environment (default 3002). The [signal contract](design/herdr-host.md#4-hook-信号线与通知接线) explains event handling.

## Read-only board

Open `/board` on the running Hub (for example `http://127.0.0.1:3001/board`). The self-contained page polls `/state` and `/runs` independently every 5 seconds, with bounded retries after failures. Approvals appear first; warnings, delivery rounds and the explicit cast remain visible. Runs show the recorded status, a separate PID existence observation, and at most 20 log lines / 64 KiB. A run ending does not mean its task is delivered.

The board reads `runs/` under the Hub's configured storage root. Missing or corrupt run files are marked degraded. Old snapshots remain visible as stale during disconnection; restarting the same Hub resumes polling automatically. A changed `hub_root` requires reloading. The page has no write controls; stopping and approval use the existing CLI / human workflow. No frontend build or additional dependency is required. Run previews use kernel-enforced opens on macOS 11+ or Linux with `/proc/self/fd`; where safe opens are unavailable, entries are marked `unsafe_path`/degraded without an unguarded fallback.

## Command Overview

Run `tut` without arguments for all commands and options; use `tut skill ROLE` (host / architect / executor / reviewer) for role procedures. For resume, read-only seats and checkout preflight, see the help entries for `resume` / `live-view` / `run` / `doctor`. Closing also appends a `close-stop` system audit note with the actual stop outcome; this is not human authorization.

## Typical Workflow

```
Host/human creates the task (tut create — requirement + acceptance in title/description, flow/cast as flags)
    ↓ first round is an ordinary round (tut start-next / auto)
Architect publishes design
    ↓ derived: designing → implementing
Executor reads context → codes the implementation (runs tests) → publishes code_changes
    ↓ derived: implementing → reviewing
Reviewer reads context → reviews (each finding carries a closing condition) → publishes review
    ├─ pass        → pending_approval → human decide(approve) → approved
    └─ fail_code   → revising → Executor publishes revision → back to reviewing
(The Notifier polls state changes: in manual mode it notifies the human to start the next step; in auto mode it can advance automatically)
```

The diagram above is the default flow, **full**. Variants are chosen when the task is created (fixed at create time, immutable once persisted):

- **solo**: small changes skip the design round and review — the task starts in implementing, design records are reference notes (no transition), and code_changes derives pending_approval directly for a human approve / reject. Review-free, but not approval-free: approve is still the human's gate
- **direct**: for simple changes that touch a risk surface (core paths / gates / public surface — expensive when wrong), solo gets one review round added — like solo, it starts in implementing (the repo already carries the design it works from) and proceeds through review and human approval as usual

## Configuration

### ① Project runtime — `.context-hub/config.json` (gitignored)

| Key | Purpose | Default |
|---|---|---|
| `flow_mode` | manual: human launch / auto: Notifier launch; `tut mode manual` or `tut mode auto` | `manual` |
| `auto.launch_roles` | Auto-launch role whitelist; empty means notify only, manual starts unaffected | `[]` |
| `launch_mode` | Launch backend tui / detached, independent of power and flow | `tui` |
| `power.mode` | `tut up/down` implementation herdr / standalone | `herdr` |
| `notify` | channels (desktop/webhook), webhook_url; edit JSON | Terminal bell and notify log |

Run `tut` for supported `config get/set` keys and domains; `config set flow_mode auto` is the offline equivalent of `tut mode auto`. Runtime settings apply on the next request/poll.
Use `tut config set launch_mode detached` for detached launches; the `headless` alias normalizes to detached on get/set, has no scheduled retirement or periodic warning, and leaves old marker/run/usage protocol identifiers untouched.
Standalone shutdown verifies identity and leaves independent runs alive; run `tut` for full power behavior and see [Windows notes](#windows-notes) for platform gaps.
OpenCode 2.2 detached routes require explicit `--auto`, e.g. `--cast 'executor=opencode --model zai-coding-plan/glm-5.3-flash --auto'`; missing it refuses before the marker. Routes cannot select a session or add another prompt; see help for observed-session resume and `start-next --fresh`. Windows is unsupported; usage is currently unattributed and excluded from tokens.

### ② Rig lineup and invocation intent

`.context-hub/config.json` is the rig's human intent file. `tut mode`, `tut config set`, `tut assign` and `tut agent add` share a key-preserving, atomic write port with cross-process locking. `flow_mode` and `auto.launch_roles` remain explicit local trust settings; assigning agents does not grant launch permission.

```json
{
  "flow_mode": "manual",
  "roles": {
    "architect": {"agent": "codex"},
    "executor": {"agent": "pi", "args": ["--model", "chosen-model"]},
    "reviewer": {"agent": "codex"}
  },
  "naming": {"tab_label": "TUT {role}"},
  "agent_bindings": {
    "custom": {"executable": "custom-cli", "args": ["run", "--quiet"], "prompt": {"kind": "argv", "index": 2}}
  }
}
```

Task `--cast` overrides a role. When `config.roles` exists, it is the complete roster: missing seats require an explicit assign or cast, and invalid declarations refuse. Routes and ordered args are consumed as a whole. Corrupt config blocks new launches, including cast launches. A shared rig's intent is selected independently of the execution checkout.

For existing rigs without `config.roles`, the compatibility chain remains project `.context-hub/workspace.json` → user `~/.config/tut/workspace.json` (`TUT_USER_CONFIG_DIR` override) → built-in architect=codex, executor=pi, reviewer=codex. `tut assign` targets the owning rig (`TUT_HUB_ROOT` or the nearest rig), including from task checkouts and subdirectories. First `tut assign ROLE COMMAND...` captures that effective roster into config, preserves project legacy extensions, and refuses conflicting keys. It never edits or removes workspace files; user defaults gain no new inheritance path. Legacy `label` is preserved but has no routing meaning.

`naming.tab_label` defaults to `TUT {role}` and supports `{role}`/`{task}`/`{agent}`; the machine pane key stays `<task_id>.<role>`. A present config naming section wins over legacy display settings. Codex gets `-c check_for_update_on_startup=false`, pi gets `env PI_SKIP_VERSION_CHECK=1`; `TUT_SUPPRESS_AGENT_UPDATE=0` disables these additions.

`tut agent add custom --prompt argv:2 -- custom-cli run --quiet` saves the declaration above. `--prompt stdin` declares standard input instead; argv indexes are insertion positions among the fixed args, from zero through their length. These declarations can be parsed now; basic launch consumption is a separate work unit. Existing setup/profile launch paths remain in use. Commands use the existing shell-neutral token grammar, preserve argument order and never infer vendor flags.

### ③ Invocation parameters and environment

Use the no-argument `tut` help for ports, URLs, polling and timeouts; `--root` means the storage directory for serve/config etc., but the rig directory owning `.context-hub` for up/down.
Common overrides: `TUT_HUB_ROOT`/`TUT_HUB_URL` select the owning Hub, `TUT_PROJECT_ROOT` overrides legacy lineup L1, `TUT_USER_CONFIG_DIR` overrides L2; `TUT_UP_CLI_SELF` overrides the power CLI, and `TUT_SPLIT_BASE` supplies the Herdr pane birth anchor.
See [system design](design/system-design.md) and [host documentation](#documentation) for implementation details.

## Development

Dependencies are listed in [package.json](package.json): the runtime dependencies are @modelcontextprotocol/sdk + zod (zod declared explicitly so it shares a single instance with the SDK); there are no other runtime dependencies. Source builds produce `dist/cli.js`; use `npm link` for `tut`, or run `node dist/cli.js <subcommand>` directly.

```bash
git clone https://github.com/ianf-ai/take-ur-turn.git
cd take-ur-turn
npm install        # install dependencies
npm run build      # compile to dist/ before tests and type-checking
npm test           # run tests (vitest)
npm run typecheck  # type-check
```

Behavioral instructions for the agent roles live in [skills/](skills/) (architect / executor / reviewer / host — behavior templates, not identity bindings: any agent that loads one can do that kind of work).

## Documentation

- [design/system-design.md](design/system-design.md) — **System design (root)**: host-independent core and host contracts
- [design/context-design.md](design/context-design.md) — **Context design**: what goes in (scope / record types / body content requirements) and how it is managed
- [design/herdr-host.md](design/herdr-host.md) — **Herdr host**: panes, power, hooks, terminal delivery and Enter remediation
- [design/standalone-host.md](design/standalone-host.md) — **Standalone host**: service power, runs, detached launch, resume, seats and preflight

Design docs and skills are currently Chinese-language; code, CLI output, and commit conventions are English.

## Troubleshooting and Known Limitations

### Windows notes

Standalone power needs no Herdr; it requires Node, PowerShell 5.1+ and CIM/NetTCPIP. `up`/`doctor` report unregistered services; `up --adopt` verifies and adopts same-workspace listeners, while `--dry-run` only previews.
Service facts use `process_scope: "windows-tree"`, `pgid: null`. Down verifies creation tokens, force-terminates the captured service tree, excludes run roots/supervisors (including in-flight ones), checks endpoints and records per-service completion for partial retries.
There is no Job Object or POSIX grace period; a leader gone before capture, unreadable identity or corrupt run metadata causes refusal. Orphaned/escaping descendants cannot be guaranteed reclaimed. Power support does not imply run/launch support; run `tut` for details.
Hub/MCP/CLI/flow driving with Herdr and PowerShell 5.1 have been verified; setup boundaries:

- Agent npm `.cmd` shims are not executed; use a native executable or direct Node entry, e.g. `tut assign executor node "%APPDATA%/npm/node_modules/@openai/codex/codex.js"`.
- If PowerShell blocks scripts, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.
- Herdr power needs a current pane or valid `HERDR_PANE_ID`; use `tut config set power.mode standalone` without one.
- Unavailable toast falls back to a bell; Do Not Disturb can silently suppress toasts. HKCU user AppUserModelID registration refreshes each attempt, with no admin install.
- Herdr's Windows zip needs `vc_redist.x64`; without it the binary may exit silently.

**Troubleshooting**:

- **Agent reports it cannot see the context.* tools**: run `tut status` in the intended workspace to verify its Hub is reachable; check that the MCP config runs `tut mcp` in the correct workspace (or pins `TUT_HUB_ROOT`); some CLI sessions may be sandboxed off from localhost loopback — in that case have that agent use the CLI channel (`tut read` / `tut publish`) instead; behavior is fully equivalent
- **Port 3001 already in use (EADDRINUSE)**: run `tut up` in the intended workspace. It verifies Hub ownership, discovers an existing local Hub for that workspace, or chooses a free Hub/notifier pair starting at 3003/3004 when the default pair is occupied. Ordinary CLI commands also discover the workspace's Hub; an explicit foreign `--url` is rejected. For a manually selected address use `tut serve --port <n>` and `--url`, and use `--event-port` to change the event listener (Hub and event ports must differ). Reusing a Hub does not imply its notifier is on the next port: `up` verifies the notifier's `hub_root` and `hub_url`, preserving both 3101/3002 and automatically assigned pairs. Notifiers must report identity fields to be reused; stop the existing notifier before moving its event port.
- **Startup lock errors**: `another up (pid N) is provisioning` means wait for that invocation to finish; only after confirming no other `tut up` instance is running may you remove the reported `.context-hub/up.lock` and retry. `cannot verify startup lock` can mean a damaged lock or a race with its initial write: retry first; if it persists, inspect the lock and confirm no other `tut up` is running before removing it. `startup lock recovery in progress` means another invocation is reclaiming a stale lock: retry; if recovery was interrupted, inspect the reported `.context-hub/up.lock.reclaim` directory and remove it only after confirming no other `tut up` is running.
- **Workspace lineup storage**: new lineup writes use `.context-hub/config.json`; legacy workspace files remain readable until explicitly replaced. See [Configuration](#configuration) for the workspace resolution chain

**Known limitations** (design trade-offs, not bugs):

- Role changes always birth a fresh pane/session (`<task_id>.<role>`, anchored to the hub's workspace/cwd, reaped by lifecycle hooks at the next hand-off or `tut decide close`); same-task same-role consecutive rounds (revision, re-review) continue the live same-role pane instead — deliver-only, no reap, no rebirth: context still flows through the Hub only and no role boundary is crossed, without the full re-read tax. Want an outside perspective on the same role? `tut start-next --fresh` force-closes the seat (working included) and births anew. Repeat launches of the same round are refused via the launch note (ALREADY_LAUNCHED; recover with `tut start-next --force`)
- A task abandoned without `decide close` leaves its panes behind (no automatic orphan reaping); close the panes manually or re-run any lifecycle hook
- The Notifier observes state at polling granularity: intermediate states inside a polling window go unobserved (version numbers can be seen to jump); replaying the records is the source of truth, and any intermediate state can be reconstructed from the log
- In auto mode there is no cryptographic way to verify that a decision record "really came from a human" — the current fallback is notification auditing plus tracing through the by field; a more structured solution is left for the multi-machine deployment scenario

## Credits

Agent hosting powered by [Herdr](https://github.com/herdrdev/herdr) — a runtime prerequisite installed separately; this package does not distribute its code.

## License

[Apache-2.0](LICENSE)

[Test environments and gate profiles](test/README.md)
