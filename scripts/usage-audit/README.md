# Usage audit

Opt-in local measurement harness shipped in the package
(`scripts/usage-audit/`), Node ≥20, no added dependencies. `tut up` starts the
watcher when `usage_audit` is `"on"` in config.json (default **off** — nothing
runs and nothing reads agent data unless you enable it). Hub, launcher,
notifier and worker skills never import or start it. It never publishes
records, makes decisions, launches agents, or changes task state; message
bodies are discarded at parse time and never leave this machine.

## Running

```sh
npm run build
node scripts/usage-audit/run.mjs --backfill --root /path/to/project --url http://127.0.0.1:3003
node scripts/usage-audit/run.mjs --since 2026-09-01T00:00:00Z --task task-id --url http://127.0.0.1:3003
node dist/cli.js config set usage_audit on --root /path/to/project/.context-hub
node scripts/usage-audit/run.mjs --watch --root /path/to/project --url http://127.0.0.1:3003
node dist/cli.js config set usage_audit off --root /path/to/project/.context-hub
```

Exactly one of `--watch`, `--since ISO8601`, `--backfill` is required. Unknown
or duplicate flags and invalid dates fail. `--root` means **project root** for
this harness (unlike `tut config --root`, which names `.context-hub`). The
HTTP Hub must already be running; default URL is `http://127.0.0.1:3001`.
Specify the correct port: `/state.hub_root` must match the canonical project
root. No offline fallback or direct meta/record parsing occurs. All task
lists and full record histories come through the existing Hub MCP client.

Optional flags:

- `--task ID`: limits output, still reads other tasks to detect competing rounds.
- `--pi-root DIR`: defaults to `~/.pi/agent/sessions`.
- `--codex-root DIR`: defaults to `~/.codex/sessions`. Note: codex sessions are
  scanned machine-wide, so one unreadable/corrupt rollout from any project can
  mark that round unresolved for all codex rounds in the same pass (conservative:
  the corrupt file's cwd is unknowable). Deleting stale broken rollouts restores
  resolution.
- `--interval-ms N`: positive integer, default 5000.
- `--timeout-ms N`: optional positive integer watch lifetime; default unbounded.
  At the deadline no new pass starts; a pass already in progress completes.
  Each Hub request has the existing client's bounded timeout.

`usage_audit` is a top-level `"off" | "on"` config key, absent means off.
It controls **only watch**. Explicit since/backfill requests run while off.
Starting watch while off reads configuration once, then returns without Hub,
private session, usage, lock or timer work. Bad configuration stops visibly.
Running watch checks the switch each pass, between measurement operations,
and immediately before committing a snapshot; off ends it and releases its
lock. An already submitted filesystem operation may finish. Re-enabling
requires explicitly starting watch again — via `tut up` (which starts the
watcher whenever the switch is `"on"`) or a manual `--watch` run.

Watch performs an initial reconciliation of existing deliveries, then repeats
it, so restart does not miss a delivery already recorded. Partial JSONL tails
and missing native ends are unresolved and retried on subsequent passes.
No idle-file timeout pretends a round ended. Use `--timeout-ms` for a bounded
watch run, or SIGINT/SIGTERM to release the lock; backfill can retry later.
Session files unchanged since the previous pass (same mtime and size) are not
re-read; task record histories come fresh from the Hub each pass. No on-disk
checkpoint is kept — a fresh process re-reads everything once. Repeated
identical pass failures are logged on the first occurrence and then every
20th, so a long hub outage cannot flood the log. Report lines are likewise
deduplicated: a task or diagnostic re-emits only when its content changes
(first sight, a changed snapshot, or a different unresolved set), so a
permanently-unresolved task cannot flood the log either.

## Attribution and measurement

Round ordinal is the ordered launch-marker number, including unfulfilled
launches (gaps are meaningful). Marker role, frozen route agent, launch time,
delivery version/time and task checkout cwd define a candidate. Legacy markers
may use the delivery's recorded agent, never today's workspace cast. Only
architect/design, executor/code_changes|revision, reviewer/review pair.
Repeated outstanding launches are diagnosed; missing markers, missing route,
identity conflicts and unsupported agents cannot produce numbers.

Pi discovery uses `--<cwd without leading slash, slash replaced by hyphen>--`
(POSIX-path shaped; on Windows pi's own directory naming differs and pi
discovery yields nothing — codex discovery is path-shape independent) and
checks the session header cwd. Codex discovery recursively checks
session_meta.cwd and excludes parent_thread_id/subagent sources. Files need
not be newly created or have the latest mtime. Each candidate must have a
native kickoff between launch and delivery, and a native end covering delivery.
Codex uses matching task_started/task_complete turn_id; pi uses user through
assistant stop, bounded by the next user message. Same-file line order resolves
equal timestamps. Cross-role launches do not truncate another session's tail.
Ambiguous top-level sessions and overlapping windows across tasks are unresolved,
including under `--task`. No text, prompt, tool output or credentials are saved.
Cwd+time cannot identify genuinely indistinguishable concurrent work; it must
remain unresolved. This measures the top-level worker, not its subagent tree.

Token quadruple:

- Pi schema 3: sum unique assistant message IDs (line positions if no ID).
  Input = input + cacheRead + cacheWrite; output = output; total = totalTokens.
  This parser requires all five fields in the verified native shape. Reasoning
  is already included, never added again. Cost sums native cost.total without
  per-event rounding; absent native cost gives null.
- Codex: ending total_token_usage minus the last cumulative snapshot before
  kickoff, component by component. A fresh session starts from zero; continuation
  requires a baseline. Duplicate snapshots are not summed. Cache/reasoning
  are subsets, not additions. No native dollar field in the verified shape:
  cost is null, not zero and not estimated from a price table.
- Counters must be nonnegative safe integers, and native total must equal
  input + output. Decreasing cumulative snapshots, missing terminal usage,
  malformed values or conflicting duplicate message IDs are unresolved.

Locally inspected on 2026-09-25: pi CLI 0.85.1 (session version 3), Codex CLI
0.156.1 (session_meta and event_msg token_count/task_started/task_complete).
Older compatible histories were also measured; this is a shape contract, not
an assurance about every external CLI release. Unknown shapes fail visibly.

## Snapshot schema (version 1)

`<project>/.context-hub/tasks/<task_id>/usage.json` contains:

```text
schema_version: 1
rounds: [
  {round, agent, role, ts, launch_version, delivery_version,
   input_tokens, output_tokens, total_tokens, cost_usd,
   session_file, window_start, window_end, start_line, end_line, turn_id?}
]
unresolved: [{delivery_version, launch_version?, reason, preserved?}]
total: {rounds, total_tokens, cost_usd, complete}
```

Times are native ISO strings; `ts` is the Hub delivery timestamp. Line numbers
are one-based inclusive native-file positions. `turn_id` is present for Codex.
`session_file` is an absolute source locator, not a copy of the private file.
Numbers describe only successful measurements. `total.rounds` counts them;
`total.total_tokens` sums them. Any unknown round cost makes total.cost_usd
null. Coverage (`complete`, no unresolved entries) is separate from price
availability. A launch without delivery never writes a zero-cost round.

Upsert key is launch_version within task; output is ordered by that version.
Totals always recompute. Since preserves earlier successes; missing excluded
history is `not_selected`. Backfill corrects re-verifiable values but preserves
old successes when evidence disappears, marking `preserved:true` and incomplete.
No selected delivery means no new file. Unchanged content leaves mtime unchanged.
Invalid existing JSON/schema/totals or symlinks fail without overwriting originals.
Only Hub-confirmed task directories are eligible; worktree cwd never changes
which Hub task owns the output.

All modes share a canonical-root SHA-256 lock in the OS temporary directory.
A competing process fails nonzero with its lock path. The lock contains pid,
root and start time. After a crash (SIGKILL) the lock file survives; on the next start the
harness detects the recorded pid is gone, re-verifies the on-disk owner is
unchanged and dead (twice), and removes it automatically — but only when the
pid is provably dead (ESRCH). Empty, corrupt, or EPERM (foreign-user live
process) locks are treated as ALIVE and refused: delete them by hand only
after confirming no writer is alive. A live watcher's lock is never stolen.
A reused pid (a new process happens to own the dead lock's recorded pid) is
indistinguishable from alive and keeps the lock refused — conservative by
design; remove it by hand once confirmed.
If a previous recovery was interrupted (crash between the recovery steps), a
`<lock>.reclaim` directory remains and the harness refuses while naming it in
the error; remove that directory by hand only after confirming no watcher is
alive.

Reports are JSON lines on stdout. Operational failures exit 1. Successfully
recorded unresolved measurements exit 0 with `complete:false` and diagnostics;
callers must inspect coverage instead of treating process success as accuracy.
Common diagnostics: missing_launch, missing_route, superseded_launch,
agent_conflict, unsupported_agent, missing_session_or_end, ambiguous_sessions,
overlapping_rounds, partial_jsonl_tail, missing_baseline, cumulative_reset,
invalid_pi_usage, missing_terminal_usage, no_matching_rounds.
Tasks with no extracted delivery rounds (for example, a launch without delivery)
emit `{ "task_id": "…", "changed": false, "reason": "no_matching_rounds" }`.
This task-level diagnostic has no measured totals or delivery-level unresolved
entries and does not create or modify `usage.json`; snapshot schema v1 is unchanged.
Watch emits it on first sight and deduplicates identical subsequent reports.
Backfill and since use the same diagnostic, independent of the since cutoff
because no delivery timestamp exists to filter. Tasks with delivery rounds all
before the cutoff remain excluded. A delivery whose native session has disappeared
instead retains the existing `missing_session_or_end` unresolved behavior.
Unreadable session candidates prevent
unique attribution for that agent; repair/restore the source, then backfill.
No unresolved condition is converted to zero.

## Verification

```sh
npm run build
npm run typecheck
npm test
node --test scripts/usage-audit/test/*.test.mjs
```

Tests use temporary generated mechanical schema data, real Store/HTTP interfaces,
subprocess lock contention, shutdown and injected rename failure. No private
session body is committed. Human reconciliation evidence and any evaluation
materials with preselected answers belong outside this repository or in the
Hub report. Real watcher dogfooding is only proven after the worker publishes
and its native final usage/end become available; publishing code does not
pre-approve that later evidence.
