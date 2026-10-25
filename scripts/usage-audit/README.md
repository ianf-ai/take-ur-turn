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
node scripts/usage-audit/run.mjs --recover --root /path/to/project --url http://127.0.0.1:3003 --task task-id
node dist/cli.js config set usage_audit off --root /path/to/project/.context-hub
```

Exactly one of `--watch`, `--since ISO8601`, `--backfill`, `--recover` is required. Unknown
or duplicate flags and invalid dates fail. `--root` means **project root** for
this harness (unlike `tut config --root`, which names `.context-hub`). The
HTTP Hub must already be running; default URL is `http://127.0.0.1:3001`.
Specify the correct port: `/state.hub_root` must match the canonical project
root. No offline fallback or direct meta/record parsing occurs. All task
lists and full record histories come through the Hub's existing MCP tools.

Optional flags:

- `--task ID`: limits output, still reads other tasks to detect competing rounds.
- `--pi-root DIR`: TUT's session parent (defaults to `~/.pi/agent/sessions`
  on POSIX). Windows discovery rules and flat-directory overrides are below.
- `--codex-root DIR`: defaults to `~/.codex/sessions`. Note: codex sessions are
  scanned machine-wide, so one unreadable/corrupt rollout from any project can
  mark that round unresolved for all codex rounds in the same pass (conservative:
  the corrupt file's cwd is unknowable). Deleting stale broken rollouts restores
  resolution.
- `--interval-ms N`: positive integer, default 5000.
- `--timeout-ms N`: optional positive integer watch lifetime; default unbounded.
  At the deadline no new pass starts; a pass already in progress completes.

All modes bound each Hub read (`/state`, MCP list and each task history) to
30 seconds, including initialization, response headers and response body/SSE.
Set `TUT_USAGE_AUDIT_TIMEOUT_MS` to an integer in 1..2147483647 to override this
I/O deadline; invalid values fail visibly. This is separate from the
`--timeout-ms` watch lifetime. A timed-out read aborts its HTTP I/O and reports
`HUB_TIMEOUT` with the endpoint and deadline. Watch uses the existing failure
logging and interval retry path; one-shot modes exit nonzero and release the lock.

The same deadline covers local config reads, session discovery/stat/read, task
directory checks, and usage snapshot reads/writes/rename/cleanup. A pending
local read rejects with `LOCAL_IO_TIMEOUT`, counts as a failed pass (including
config checks at both pass boundaries), and retries on the next interval.
Read APIs that accept an abort signal receive one; an uninterruptible native
read can still finish later, but its result cannot resume the failed pass or
commit a snapshot. Ordinary malformed configuration remains fatal.

A submitted mutation cannot safely be abandoned. At its deadline the watcher
counts the failed pass and immediately warns on stderr, keeps the writer lock,
and waits for that operation to settle before cleanup/retry. It never starts a
second pass or releases the lock while a late write/rename can still execute.
If the filesystem remains stuck, the warning and heartbeat remain visible;
when it recovers, cleanup and collection resume. This is an in-process guard,
not a forced native-I/O cancellation or a cross-process watchdog.

`usage_audit` is a top-level `"off" | "on"` config key, absent means off.
It controls **only watch**. Explicit since/backfill/recover requests run while off.
Starting watch while off reads configuration once, then returns without Hub,
private session, usage, lock or resident heartbeat work. Bad configuration stops visibly.
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

While enabled, watch emits a JSON heartbeat to **stderr every 60 seconds**,
independently of pass completion and retry sleeps:

```json
{"event":"heartbeat","timestamp":"2026-10-16T00:01:00.000Z","pid":1234,"pass_id":3,"phase":"hub-read","last_progress_at":"2026-10-16T00:00:59.000Z","last_successful_pass":null,"consecutive_failures":2,"in_request":true,"stalled":false}
```

`last_successful_pass` is the completion time of the most recent successful
pass (null until the first); `consecutive_failures` counts all failed passes
since then and resets on success. `in_request` covers the current Hub read,
including its MCP handshake and body consumption. The heartbeat timer is
removed after cleanup when watch ends; disabled watch and one-shot modes emit
no heartbeat. `pid`, `pass_id`, `phase` and `last_progress_at` identify the
process, attempted pass and latest operation boundary. A phase ending in
`:draining` means a timed-out mutation still owns the writer lock.

If no pass has succeeded, the success-age clock starts at watcher startup.
If the last success or operation progress is older than
`max(120000, 2 × I/O deadline + poll interval)` milliseconds, the next heartbeat
sets `stalled: true` and emits a separate `PASS_STALLED` stderr alarm once per
stall episode. Successful progress clears it and arms a future alarm. This
also detects repeated failures whose changing pass IDs would otherwise look
healthy. With default settings the threshold is two minutes, checked every
60 seconds; local I/O timeouts report sooner, at 30 seconds.
Missing heartbeats indicate that the watcher is no longer responding. A
pending HTTP read still emits heartbeats: detect lack of progress using the
success time, failure count and request flag as well as missing heartbeats.

## Recovery and diagnosis

If usage stops advancing, inspect `.context-hub/usage-audit.log` (for watchers
started by `tut up`) or the manual watcher's stderr for heartbeats and
`HUB_TIMEOUT`, `LOCAL_IO_TIMEOUT`, `PASS_STALLED` and pass failures. Verify that the Hub is running at the specified
URL and belongs to the project root, then run:

```sh
node scripts/usage-audit/run.mjs --recover --root /path/to/project --url http://127.0.0.1:3003
# Optional: add --task TASK_ID to limit repaired snapshots.
```

Recovery reports the lock path, recorded pid and status (`dead`, `alive`,
`unknown`, or `absent`) as a JSON line on stderr. Only a provably dead owner
(ESRCH) permits automatic stale-lock removal; recovery reuses the normal
reclaim mutex and liveness rechecks, then holds the lock throughout backfill.
A live or unidentifiable owner is refused before Hub/session reads. Inspect
the reported process and stop it manually if appropriate, then retry;
**recovery never kills a process or clears a live lock**. Unknown owners and
interrupted `.reclaim` recovery require manual inspection as described below.

With no live writer, recovery runs the same backfill as `--backfill`, including
optional `--task` filtering and cross-task ambiguity checks. It runs while
`usage_audit` is off. Reports stay on stdout; after successful backfill and lock
release, stderr recommends inspecting coverage and rerunning `--watch` with
the same root, URL and session roots (enable `usage_audit` first if off).
Backfill failure releases the acquired lock and exits nonzero without success
advice. Recovery does not start watch automatically or change configuration.

## Attribution and measurement

Round ordinal is the ordered launch-marker number, including unfulfilled
launches (gaps are meaningful). Marker role, frozen route agent, launch time,
delivery version/time and task checkout cwd define a candidate. Legacy markers
may use the publication's recorded agent, never today's workspace cast. A
launch pairs with the **next publication by the same worker role**, regardless
of content type (including checkpoint notes, scope-check notes and custom
types). Human notes and other roles' publications do not close it; launch
markers are control records, not publications closing another round.
Further publications before that role's next launch belong to the same native
session and do not create additional rounds or missing-launch diagnostics.
The first publication is only the attribution anchor: measurement still runs
through the native end, so later notes and a subsequent formal delivery in
that session are included exactly once. Ordinary notes without a launch are
ignored; formal deliveries by a role with no launch history retain the legacy
`missing_launch` diagnostic. Repeated outstanding launches are diagnosed only
when a new launch arrives before any same-role publication (mode-split: see
dispositions below). Missing markers, missing route, identity conflicts and
unsupported agents cannot produce numbers. `tut stats` accepts these anchors
without counting notes as workflow deliveries; preserved v1 formal-delivery
anchors remain readable, with new note-anchor coverage shown as incomplete
until recomputed.

### Unresolved-shape dispositions (2026-10-18 headless findings)

The write path is never gated on coverage: a task with any delivery round
writes its snapshot (resolved rounds plus an honest `unresolved[]`), and
unresolved rounds never drop the rest of the ledger (a task with zero
resolved rounds still lands a rounds=0 snapshot; only a task with no delivery
round at all writes nothing). The three headless-era unattributed shapes and
their dispositions:

- `superseded_launch` — a re-launch replaced an outstanding launch before any
  same-role publication. A note already published ends the round and cannot
  be superseded by the next launch. Tui markers keep the conservative
  whole-round diagnostic. Headless markers (`launch_mode: "headless"`)
  split the accounting: the delivering
  (rescue) round measures its own session normally; every launch it replaced
  stays unaccounted and is anchored as an `unresolved[]` entry
  (`{delivery_version, launch_version, reason}`, all existing schema-v1
  fields; the disclosure also survives `--since` replays that preserve the
  delivering round's measurement). Usage is never merged from a replaced
  launch into the round; its burned usage is explicitly unmeasured rather
  than silently discarded or represented by the rescue round's tokens.
- `overlapping_rounds` (including `ambiguous_sessions`) — concurrent rounds
  sharing one cwd (the 0.9.0 default `launch.checkout: "rig"` mode runs all
  headless agents in the rig root, so a parallel task batch's sessions become
  candidates for each other's rounds). Cwd+time cannot distinguish genuinely
  concurrent work; no assignment is fabricated and both rounds stay
  unresolved (a headless rescue delivery that newly collides absorbs the
  conflict alone, preserving other rounds' attribution). Per-task cwd
  isolation (anchored checkout) prevents the shape at
  the source; the audit side only reports it honestly.
- `missing_session_or_end` — no native end covering the delivery (for example
  an executor that exited early). Retried every pass, never zero-filled.

Pi discovery checks the session header cwd. POSIX retains its existing
`--<cwd without leading slash, slash replaced by hyphen>--` directory and
`--pi-root` behavior (including ignoring `PI_CODING_AGENT_SESSION_DIR`).
On Windows, the default parent is `%USERPROFILE%\.pi\agent\sessions`
(or `PI_CODING_AGENT_DIR\sessions`); pi's shared path leaf encodes the cwd
by removing one leading slash/backslash and replacing `/`, `\` and `:`
with `-`. For example `C:\repo` becomes `--C--repo--`.

Windows pi's nonempty `--session-dir` takes precedence over
`PI_CODING_AGENT_SESSION_DIR`. Both name the **final** session directory,
without another cwd component. Relative native overrides resolve against
the launch cwd; tilde and supported MSYS/WSL/Cygwin drive paths follow the
same rules as Windows resume. Unknown effective settings/trust and file URLs
are refused as `invalid_pi_session_directory`, rather than guessed.
Windows detached launches use the exact task/role/attempt/base-version run
association from RunStore, then its frozen `pi_session` directory, layout,
UUID and cwd. Later environment changes do not redirect their lookup.
Missing, duplicate, unreadable or inconsistent run evidence stays unresolved
(`missing_windows_run`, `ambiguous_windows_run`, `unreadable_windows_runs`,
`invalid_windows_launch`, `invalid_windows_session`). No current-environment
fallback replaces missing frozen evidence.

An explicit Windows `--pi-root` changes only this audit's lookup: for default
or frozen `cwd-encoded` storage it is a parent with the cwd slug appended;
for native CLI/env overrides or a frozen `flat` session it is the final
directory. It never changes the
run's UUID/cwd association. Header cwd comparison is normalized and exact;
case/junction aliases are not guessed. Repeated discoveries of one file are
parsed once per pass, including shared flat roots. Native null pi cost is
unknown (`null`) on Windows; absent/invalid token usage remains unresolved.

Codex discovery recursively checks
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
A `superseded_launch` unresolved entry anchors a launch replaced before the
delivery named by its `delivery_version` (headless markers only; see
dispositions). No selected delivery means no new file. Unchanged content
leaves mtime unchanged.
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
