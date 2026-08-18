# TUT — Take Ur Turn

[English](./README.md) | [简体中文](./README.zh-CN.md)

Multiple coding agents — different models, different CLI tools — collaborating in the same project: context is shared automatically, the workflow advances on its own, and humans only step in at approval gates.

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
- **Flow variants**: pick `--flow full|direct|solo` when creating a task — full runs the complete loop; direct skips the design stage (the repo already has a design); solo skips review for small changes — review-free but not approval-free (straight to the approval gate)
- **manual / auto progression**: in manual (the default), the human is notified when it is someone's turn and starts the next step; in auto, the Notifier launches the next agent directly through the launcher (with graded trust via the role whitelist), and humans only make decide calls

## Architecture

```
┌─────────────────────────────── local machine ────────────────────────────────┐
│                                                                              │
│  coding agent ──MCP read/write──► Context Hub ──► storage (local JSON)       │
│       ▲                            (memory + state projection)               │
│       │ launch                          ▲                                    │
│  Agent Host ──state events──► Notifier ─┘                                    │
│  (signal source + launcher, pluggable)   │ reads derived state (GET /state)  │
│                                          │                                   │
└──────────────────────────────────────────┼───────────────────────────────────┘
                                           ▼ notifications
                                        Channel ──► human
     manual: the human starts the next one | auto: the Notifier starts it via the launcher
```

| Module | Responsibility |
|--------|---------------|
| **Context Hub** | Shared memory (append-only log) + state projection (derived view). Exposes MCP tools to agents and a read-only GET /state to the Notifier. **Responsible for memory only — no workflow enforcement** |
| **coding agent** | Several of them, across three roles (Architect / Executor / Reviewer); the role is a cast (per-task role casting), not a fixed binding |
| **Agent Host** | The host environment for local agents, with two pluggable parts: signal source (agent state events) + launcher; current implementation: Herdr |
| **Notifier** | The notification and progression hub: polls derived state, notifies the human when it is someone's turn, cross-checks whether agents delivered |
| **Channel** | Notification output (local desktop notification / webhook) |

Task state is derived from the record sequence:

```
designing → implementing → reviewing ─┬─ pass       → pending_approval → human decide(approve) → approved → closed
                                       ├─ fail_code  → revising → revision → back to reviewing
                                       └─ fail_design → sent back to designing
```

## Quick Start

Prerequisites: Node.js ≥ 20, Herdr (the Agent Host, providing the terminal panes agents live in; install with `brew install herdr`, project homepage https://github.com/herdrdev/herdr), and at least one coding agent CLI. **Platforms: macOS / Linux only** (the launcher is a POSIX shell; Herdr's Windows support is still in beta).

```bash
git clone https://github.com/ianf-ai/take-ur-turn.git
cd take-ur-turn
npm install
npm run build
```

The build output is `dist/cli.js`. Use `npm link` to put the `tut` command on your PATH; if you prefer not to link, `node dist/cli.js <subcommand>` always works (referred to as `tut` below).

**Start the workspace** (the power switch, idempotent — two system panes: hub pane + notify pane):

```bash
tut up
```

**Kick off a task** (sends a one-sentence requirement to the Architect's pane; then poll `tut list` until the task appears):

```bash
tut new "add a --url flag to the CLI's mode subcommand"
```

From there, agents push the task forward by reading and writing the Hub through MCP tools from their own panes; `tut status` shows the overview, the Notifier notifies you when an approval is due, and you make the call with `tut decide <task_id> --decision approve --by <your-name>`.

The Notifier's side channels (instant blocked alerts, done cross-checks) rely on Herdr forwarding each pane's agent state changes to `scripts/on-agent-event.sh` — a one-time environment setup (a Herdr plugin); see the wiring instructions in section 7.2 of [design/system-design.md](design/system-design.md).

## Agent CLI Onboarding (one-time)

The Hub exposes its MCP tools over **Streamable HTTP** at `http://127.0.0.1:3001/mcp` (online as soon as `tut serve` is up; stateless, no session stream). Configure once for every Agent CLI that will take part:

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.tut]
url = "http://127.0.0.1:3001/mcp"
```

Other MCP clients that support Streamable HTTP: point them at the same URL.

Once configured, the agent sees 5 tools: `context.create` / `context.publish` / `context.read` / `context.list` / `context.decide`.

**CLIs without MCP-over-HTTP support**: use the equivalent CLI channel — the `tut create / publish / read / list / decide` subcommands map one-to-one onto the MCP tools, so an agent can simply call them from the shell (the per-role "tool cheat sheets" in the skills — an MCP | CLI mapping — are made for exactly these CLIs; the two channels can be mixed; on the same task, each role using its own channel is fully compatible).

**Environments with no way to configure MCP** (e.g. sandbox restrictions in some sessions): fall back to the CLI channel as above.

## Command Overview

Running `tut` with no arguments prints the full USAGE. Quoted verbatim:

```
tut serve [--port <n>] [--root <dir>]
tut notify [--url <u>] [--interval <s>] [--event-port <p>] [--stall-timeout <m>]
tut mode <manual|auto> [--url <u>]
tut start-next [<task_id>] [--url <u>] [--force]
tut create --title <t> --description <d> --creator <c> --role <r> [--flow <full|direct|solo>] [--cast <role=agent,...>] [--url <u>]
tut publish <task_id> --role <r> --content-type <t> --summary <s>
             (--body <text> | --payload-file <md>)
             [--verdict <pass|fail_code|fail_design>] [--commits <a,b>]
             [--ref-version <n>] [--expected-version <n>] [--agent <a>] [--model <m>] [--url <u>]
tut read <task_id> [--since-version <n>] [--json] [--url <u>]
tut list [--status <s>] [--json] [--url <u>]
tut decide <task_id> --decision <approve|reject|close> --by <b> [--reason <text>] [--url <u>]
tut new "<one-sentence requirement>" [--pane <label>]
tut assign <role> <agent>
tut up [--url <u>] [--dry-run]
tut ack <task_id> [--note <text>] [--url <u>]
tut status [--json] [--url <u>]
```

The agent-side equivalent channel is the 5 MCP tools (`context.create` / `context.publish` / `context.read` / `context.list` / `context.decide`); the CLI subcommands map onto them one-to-one.

## Typical Workflow

```
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

- **direct**: the repo already has a design, so the design stage is skipped — the task starts in implementing; review and human approval proceed as usual
- **solo**: small changes skip review — code_changes derives pending_approval directly for a human approve / reject. Review-free, but not approval-free: approve is still the human's gate

## Configuration

Three configuration surfaces, different in nature and in location:

### ① Project runtime config — `.context-hub/config.json` (gitignored, one per project)

Governs Hub and Notifier behavior. Changes take effect on the next polling cycle — no restart needed:

| Key | Purpose | Default |
|---|---|---|
| `flow_mode` | `"manual"` / `"auto"` — who presses the start button at round handoffs (the human, or the Notifier auto-launching via the launcher). Prefer switching with `tut mode <manual\|auto>` | `manual` |
| `notify` | Notification channels: `channels` (desktop / webhook, etc.) and `webhook_url` | unset = terminal bell plus notify-pane log |
| `auto.launch_roles` | Launch whitelist for auto mode (keyed by role, e.g. `["executor","reviewer"]`). **Empty by default = every round falls back to notifying the human** — rounds not on the whitelist are never auto-launched and leave no launch trace; the human's manual starts are unaffected | `[]` |

### ② Workspace config — `scripts/workspace.json` (shipped with the repo)

Default lineup: role → `{ label, agent }` (pane label + the Agent CLI occupying that seat). Resolves for tasks created without an explicit cast; edit with `tut assign <role> <agent>`. `routes.json` remains as a legacy-format fallback.

### ③ Invocation parameters — CLI flags and environment variables

| Parameter | Applies to | Default |
|---|---|---|
| `--port <n>` | listen port for `tut serve` | `3001` |
| `--url <u>` | Hub address override (for `tut up` and the context/approval commands; accepts loopback addresses with an explicit port only) | `http://127.0.0.1:3001` |
| `--interval <s>` / `--event-port <p>` / `--stall-timeout <m>` | polling interval / agent event port / stall timeout for `tut notify` | `5s` / `3002` / `30min` |
| `--root <dir>` | storage root for `tut serve` | current directory |
| env `TUT_UP_CLI_SELF` | path of the tut CLI itself, used when `tut up` provisions panes | auto-detected (dist layout) |
| env `TUT_SPLIT_BASE` | base pane for on-demand provisioning of splits | auto-detected |

There is also one piece of one-time environment setup: the Herdr event-wiring plugin (see the wiring note at the end of [Quick Start](#quick-start)).

## Development

Dependencies are listed in [package.json](package.json): the runtime dependencies are @modelcontextprotocol/sdk + zod (zod declared explicitly so it shares a single instance with the SDK); there are no other runtime dependencies.

```bash
npm install        # install dependencies
npm test           # run tests (vitest)
npm run typecheck  # type-check
npm run build      # compile to dist/
```

Behavioral instructions for the agent roles live in [skills/](skills/) (architect / executor / reviewer / host — behavior templates, not identity bindings: any agent that loads one can do that kind of work).

## Documentation

- [design/system-design.md](design/system-design.md) — **System design (currently authoritative)**: architecture, state derivation rules, MCP tool schemas, module contracts, technology choices
- [design/context-design.md](design/context-design.md) — **Context design**: what goes in (scope / record types / payload envelope and body templates) and how it is managed

Design docs and skills are currently Chinese-language; code, CLI output, and commit conventions are English.

## Troubleshooting and Known Limitations

**Troubleshooting**:

- **Agent reports it cannot see the context.* tools**: make sure `tut serve` is running (`curl http://127.0.0.1:3001/state` responding means it is alive); check that the CLI's MCP config points at the `/mcp` endpoint; some CLI sessions may be sandboxed off from localhost loopback — in that case have that agent use the CLI channel (`tut read` / `tut publish`) instead; behavior is fully equivalent
- **Port 3001 already in use (EADDRINUSE)**: switch ports with `tut serve --port <n>` and point the remaining commands at the new address via `--url` (`tut up`'s provisioning probe included)
- **Custom lineup lost after `npm i -g`**: `tut assign` writes the package-internal `scripts/workspace.json` (inside node_modules), which an upgrade resets — if you need a custom lineup/layout, clone the repo and install from it

**Known limitations** (design trade-offs, not bugs):

- An agent's pane is a single session: when multiple tasks wait on the same agent at once, round prompts arrive one after another in the same session (serialized execution, shared context)
- The Notifier observes state at polling granularity: intermediate states inside a polling window go unobserved (version numbers can be seen to jump); replaying the records is the source of truth, and any intermediate state can be reconstructed from the log
- In auto mode there is no cryptographic way to verify that a decision record "really came from a human" — the current fallback is notification auditing plus tracing through the by field; a more structured solution is left for the multi-machine deployment scenario

## Credits

Agent hosting powered by [Herdr](https://github.com/herdrdev/herdr) — a runtime prerequisite installed separately; this package does not distribute its code.

## License

[Apache-2.0](LICENSE)
