import { DEFAULT_HUB_URL, DEFAULT_EVENT_PORT } from "./shared.js";

export const USAGE = `tut — Take Ur Turn Context Hub

Usage:
  tut run [--task <id>] [--fix-preflight] -- <command...>
      Start a detached POSIX process group in the calling cwd; prints run-id.
      Offline log/meta: <hub-root>/.context-hub/runs/<run-id>/ (TUT_HUB_ROOT or nearest Hub root).
      preflight: when the cwd is a Node checkout declaring dependencies
      (or a TUT source checkout), missing node_modules/dist refuses the run
      with repair guidance; --fix-preflight runs the SUPPORTED repairs
      (npm ci under a lockfile, npm run build for TUT dist) in-checkout,
      bounded and visible on stderr, before re-checking. A FAILED repair
      step always refuses, even when half-applied artifacts exist. Non-JS/
      no-manifest directories are never gated.
  tut ps [--json]
      Read run snapshots and actual PID/group liveness; stale/incomplete runs stay visible.
  tut attach <run-id>
      Replay the last 50 lines and follow append-only log; Ctrl-C exits only this view.
  tut stop <run-id>
      Request root SIGINT (5s), then original-group TERM (5s), KILL and verify (2s).
      Original supervisor owns signals; shows cooperative/forced outcome and group-only scope.
      Legacy active runs are unsupported; optional project Hub audit is best-effort.
  tut repair-run <run-id>
      Disposition an unreadable run archive (tut ps: incomplete/unreadable).
      Protocol repair first: a complete meta.<hex>.tmp left by an interrupted
      atomic write is adopted as meta.json (invalid previous bytes preserved).
      Otherwise the invalid meta.json is isolated as meta.json.broken[.<hex>]
      — bytes preserved for forensics, tut ps shows a quarantined marker.
      Refused while the process group is alive/unprobeable or the identity is
      unparseable. The run log is NEVER touched or deleted (evidence material).
  tut resume <run-id> [instruction] [--fix-preflight]
      Continue a COMPLETED run's exact native session in a NEW run (new
      run-id/log/PID/PGID/attempt; the old evidence stays untouched).
      codex resumes via the observed agent_session_id; pi resumes only a
      session identity that is stored AND verified in this project's session
      store (a missing pi session is refused — pi would silently create one).
      The instruction is one string (default: a continuation prompt, or the
      role doorbell for managed runs); quote it, or put it after -- when it
      starts with a hyphen. An explicit instruction is never approval/ack/
      scope-widening evidence. Managed (headless-owned) resumes additionally
      require the same-root Hub online, the task still waiting for the same
      role (verified in BOTH /state and the task log, inside the admission
      critical section), no needs_attention, not pending_approval/approved/
      closed, and append a manual launch marker before spawn. Cross-process admission:
      an incomplete run or pending intent holding the session (or the task,
      for managed runs) refuses the spawn. stdout: the new run-id only; exit 0
      = startup confirmed, not task success. A best-effort project-scope
      operation note records the resume (audit, not authorization).
  tut live-view --layout <json-file>
      Read-only terminal seat grid. The layout declares schema:1, rows,
      columns, and seats [{id,row,column,label?,selector}] where selector is
      {task_id,role} (explicit headless ownership only) or {run_id} (fixed).
      Every pane is THIS package's tut attach child (stdin ignored — no
      typing channel, no stop/resume/decide). A task+role seat shows the
      single incomplete run, a conflict when several, or the latest complete
      one; new runs take over the seat in place. Ctrl-C closes the view and
      its attach children only; the observed runs keep running for any other
      attach. Requires a TTY (use tut attach <run-id> otherwise).
  tut mcp
      Bridge MCP stdio to this workspace's verified local Hub.
      Uses TUT_HUB_URL, TUT_HUB_ROOT/cwd and bounded discovery; stdout is MCP only.
      Exit: 0 EOF, 1 usage/internal, 2 initial connection, 3 reconnect exhausted.
  tut serve [--port <n>] [--root <dir>]
      Start the Context Hub (MCP + /state). Default ${DEFAULT_HUB_URL}; port 0 = ephemeral.
  tut notify [--url <u>] [--interval <s>] [--event-port <p>] [--stall-timeout <m>] [--working-timeout <s>]
      Run the Notifier (poll /state, receive agent events, notify via channels).
      Defaults: url ${DEFAULT_HUB_URL}, interval 5s, event-port ${DEFAULT_EVENT_PORT},
      stall-timeout 30min, launch-working timeout 300s. --interval is clamped
      to a 1s floor (polling faster self-excites against the hub).
  tut mode <manual|auto> [--url <u>]
      Switch flow_mode (takes effect on the next poll cycle).
  tut config get <key> [--root <dir>]
  tut config set <key> <value> [--root <dir>]
      launch_mode: tui (default) | headless; selects Notifier automatic launches.
      Read / write project runtime config (.context-hub/config.json — the
      file serve re-reads every request for runtime settings; works with
      the Hub down, same discipline as
      tut assign). Keys: flow_mode ("manual"|"auto" — the offline equivalent
      of tut mode), usage_audit (off | on; when on, tut up starts the shipped usage watcher), auto.remediate (off | enter-repress), auto.launch_roles (comma-separated bare role names —
      e.g. architect,executor,reviewer; "" clears the whitelist), review_standards
      (comma-separated non-empty file paths, e.g. standards/review.md,/shared/team.txt;
      missing or "" = disabled; item edges trimmed; no ASCII control characters
      or empty items; filenames containing commas unsupported). Reviewer loads
      configured files only at the first full review of a task; Hub does not
      load their contents.
      Relative paths resolve from the reviewed checkout's project root (the
      worktree root for worktree tasks); absolute paths are literal local paths,
      with no shell/glob/variable/tilde expansion. get also
      reads notify (read-only: an object config,
      edit config.json by hand). Unknown keys and illegal values are
      rejected with the available keys and their value domains. Default
      --root: .context-hub (relative to cwd — run from the project root,
      the same root tut serve defaults to). For review_standards, select the owning
      Hub's actual storage directory with --root, even from a worktree;
      TUT_HUB_ROOT is not automatically used by config.
  tut start-next [<task_id>] [--url <u>] [--force] [--fresh]
      Human-confirmed launch of the next agent. Without task_id: pick the single
      task waiting on an agent (none → list human-waiting tasks; ambiguous →
      list candidates and ask to specify). Duplicate launches are blocked;
      --force permits a manual retry after inspecting the pane and outstanding calls. --fresh (orthogonal to
      --force): force-close the task's same-role pane and birth a brand-new
      one — the explicit outside-perspective choice;
      the Notifier never passes it.
  tut launch [--fresh] <task_id> <role> [<agent> [<arg>...]]
  tut launch --cleanup <task_id>
      Internal launch entry used by start-next, Notifier, and the POSIX shim.
      Task routing applies to this legacy positional door too: the task's
      frozen checkout (and cast) are read from /state at planning, so a
      worktree task born here still lands on its checkout root.
  tut watch [<task_id>] [--url <u>] [--interval <s>]
      Watch a task until its derived state changes, then exit with a code
      for the situation: 0 = round boundary (a new record advanced the
      state — someone's turn, including the pending_approval human gate),
      2 = terminal state (approved / closed), 3 = needs attention,
      1 = operational error (unreachable Hub, unknown task, ambiguous
      selection). Baseline is the state at start; a task ALREADY terminal
      or needs-attention exits immediately. Without task_id: the single
      task waiting for an agent (same default selection as start-next).
      Default interval 5s; transient fetch failures are retried with a
      throttled warning.
  tut create --title <t> --description <d> --creator <c> --role <r> [--flow <full|direct|solo>] [--cast <role=command>]... [--checkout <current|worktree:path>] [--checkout-path <p>] [--checkout-ref <ref>] [--url <u>]
      Create a task; prints task_id, status, version. flow picks the workflow
      (immutable after creation, default full): full = design → implement →
      review → approval; direct = design already exists, starts implementing;
      solo = small change, starts implementing, no design round (design =
      reference note), review skipped (code_changes → approval directly).
      cast routes individual roles of THIS task to other agents (e.g.
      --cast executor=pi --cast 'reviewer=codex --model gpt-5.6'); routing
      only, immutable like flow. The legacy comma form remains supported;
      command values are shell-neutral argv words.
      checkout optionally freezes where this task's panes are born: use
      --checkout current (default) or --checkout worktree:<path> (equivalent
      to --checkout worktree --checkout-path <path>). The path must name a
      worktree prepared by the caller; TUT does not run git worktree create.
      A worktree checkout must carry the path: --checkout-ref is accepted
      only as an annotation next to a path, never instead of one — the
      launcher resolves the path and never creates worktrees, so a ref-only
      task could never start. Create warns (non-blocking) when the path does
      not exist yet.
      create is the initiating-side action (host/human): the task exists before
      any delivery, and the first round is an ordinary round — manual mode
      starts it with tut start-next <task_id>; auto mode lets the Notifier
      auto-launch it (per its whitelist).
  tut publish <task_id> --role <r> --content-type <t> --summary <s>
             (--body <text> | --payload-file <md>)
             [--verdict <pass|blocked_external|fail_code|fail_design>] [--commits <a,b>]
             [--ref-version <n>] [--expected-version <n>] [--agent <a>] [--model <m>] [--url <u>]
      Append a context record. --summary required; body via --body or --payload-file.
  tut read <task_id> [--since-version <n>] [--json] [--url <u>]
      Read a task's records + derived status. --since-version returns records
      with version >= n (n itself included). --json for machine output.
  tut list [--status <s>] [--json] [--url <u>]
      List tasks (optionally filtered by derived status).
  tut decide <task_id> --decision <approve|reject|close> --by <b> [--reason <text>] [--url <u>]
      Record a human decision. decide close also reaps the task's panes
      (best-effort; the decision itself never depends on the terminal).
  tut assign <role> <command...>
      Change which agent command occupies a role seat, writing the PROJECT-level
      .context-hub/workspace.json (cwd). Missing file → initialized from the
      currently effective lineup (all three roles) first; a corrupt file is
      never clobbered. User-level ~/.config/tut/workspace.json is maintained
      by hand (a low-frequency machine-wide declaration).
  tut up [--url <u>] [--event-port <p>] [--root <dir>] [--dry-run]
      Provision the workspace power switch (idempotent): hub + notify panes
      only — role/agent panes are no longer pre-provisioned: launchers
      raise agent panes on demand at hand-off time. --url targets a
      non-default local hub (loopback + explicit port; it must not equal the
      event port — up refuses the collision up front). --event-port moves the
      notifier's event listener off ${DEFAULT_EVENT_PORT}: up probes, provisions,
      and renders the notify command against the same port (a non-default port
      is passed through explicitly so the provisioned notifier cannot drift
      back to the default). --root names the rig root explicitly (the directory
      owning .context-hub; default: cwd's rig root — same locator as tut down).
      The config key power.mode selects the power implementation: "herdr"
      (default — the pane-provisioned rig above, unchanged behavior) or
      "standalone" — up itself raises detached process groups (hub + notifier,
      plus the opt-in usage watcher), records their pid/pgid/port facts in
      .context-hub/power.json, and tut down stops them. Illegal power.mode
      values (or an unreadable config) fail visibly before any provisioning.
  tut down [--root <dir>]
      Stop this rig's standalone services (power.mode=standalone): read
      .context-hub/power.json and stop in reverse start order (notifier →
      usage watcher → hub) — SIGTERM to each recorded process group, grace
      window, liveness re-check, SIGKILL escalation, final port re-check.
      Signals are identity-gated (a live pid is not ownership: recycled or
      unverifiable pids are never signaled) and group-scoped (a leader that
      exits first never masks stubborn members; completion requires the
      whole group gone). A leftover group whose recorded leader is gone is
      cleaned up only when a live member verifies against this rig's power
      member registry (a session marker bound to the SURVIVING service
      instance — repeated ups reuse services and keep their sessions —
      inherited by the services' launch children); otherwise it is refused
      visibly. A failed down never records a stop — repeated downs re-verify
      instead of trusting the marker. Idempotent once fully stopped. Runs are
      NEVER terminated by down — each run is an independent detached process
      group and survives the rig; down lists the surviving runs before
      stopping services. In herdr mode (power.mode=herdr, the default) down
      refuses with the herdr shutdown pointer (stop the tut-sys panes) —
      never a silent no-op.
  tut ack <task_id> [--note <text>] [--url <u>]
      Acknowledge a task's anomalies as handled: appends a human note with
      ack=true — accumulated warnings clear and needs_attention resets on
      the next state pass. Existing records are never modified.
  tut status [--json] [--url <u>]
      Human overview: task totals (attention/closed counts) plus a table of
      every task — needs_attention first, then newest updates first.
      One-shot snapshot (continuous watching is tut notify's job); --json
      prints the same filtered/sorted snapshot for scripts.
  tut doctor [--root <dir>] [--url <u>] [--checkout <dir>] [--fix-preflight] [--json]
      Report-only environment & assembly self-check: nine checks — hub
      reachability (/state), notifier event port, config & workspace chain,
      agent executables, storage health, path safety & probe endpoints,
      platform info, agent-channel network verdicts, checkout preflight.
      Checks never modify anything; every problem comes with a fix command to
      run by hand. --checkout names the directory the preflight check
      inspects (default: cwd — the run/resume execution target; --root stays
      the STORAGE directory and keeps its meaning). --fix-preflight repairs
      ONLY the preflight items (npm ci under a supported lockfile, npm run
      build for a TUT source checkout's dist), bounded and visible, then
      re-checks; a source checkout missing dist bootstraps via the INSTALLED
      tut: tut doctor --checkout <source-path> --fix-preflight. Exit 0 = no
      failing check (warnings allowed), 1 = at least one failing check;
      --json prints the machine-readable DoctorReport (the same
      report the text rendering draws from). Defaults: --root .context-hub
      (relative to cwd), --url the default hub.
  tut stats [task_id ...] [--root <dir>] [--json]
      Offline, read-only statistics from local records and usage sidecars via
      Store. Default batch = all tasks; task IDs select a batch. Project scope
      is excluded. --root names the .context-hub directory (default under
      TUT_HUB_ROOT or cwd). No sweeping, writes, launches, or Hub required.
      Reports strict review pass rate, first-review pass rate, revisions,
      current waiting blockers, per-role deliveries, and tokens BY AGENT.
      Missing/incomplete/invalid usage and degraded tasks are explicit; no
      reviews = null/n/a. Pi and Codex token totals use different native
      accounting. --json includes metric definitions and coverage.
  tut repair-meta <task_id> [--title <t>] [--description <d>] [--creator <c>] [--created-at <iso>]
                  [--flow <full|direct|solo>] [--cast <role=command>]... [--checkout <current|worktree:path>] [--url <u>]
                  [--from-snapshot <file>]
      meta-rebuild storage repair (system-design 4.3): rebuild a corrupt/missing
      meta.json through the RUNNING hub (POST /repair-meta, its single-writer
      queue — same discipline as tut mode; a second process writing meta
      directly would race concurrent appends). version is computed
      server-side from the record files, never caller input. Rebuild fields
      are your best available archive (notifier snapshot, read response,
      notes); omit what is unknown — title falls back to the task_id, flow to
      full. A readable meta is refused (repair is not an overwrite path),
      records are never touched, and the repair itself does not close the
      task — decide close afterwards if that was the intent.
      --from-snapshot reads a previously saved Notifier /state JSON response
      and prefills title/flow/cast for this task. Explicit flags override
      snapshot fields (cast overrides per role). An unavailable/invalid or
      unmatched snapshot warns and keeps manual fields/defaults. The Notifier
      currently keeps its snapshot in memory; this flag requires a retained
      file, not a live /state fetch after corruption. Check its provenance
      and age before repair; snapshots do not supply description or checkout.
  tut recover-record <task_id> <record_file> --from <path> [--source <text>] [--url <u>]
      record-recovery registration (system-design 4.3): register the
      recovered ORIGINAL bytes of a corrupt record file. Fetch them from an
      external snapshot yourself (backup / shared repo / team git — the hub
      never fetches backups); --from points at that copy, --source is the
      provenance note for the audit trail. The corrupt original stays on
      disk byte-for-byte (pinned evidence); the recovered copy lands as
      <record_file>.recovered and the fold substitutes it deterministically.
      Diagnosis of which file is corrupt: tut doctor (report-only).
  tut skill <host|architect|executor|reviewer>
      Print a role skill's full text. The skills directory is resolved
      module-relative (../skills — npm install, git clone, and npm link
      shapes all work), read locally, zero network: runs inside
      default-sandboxed agent sessions.
  tut init
      Full onboarding for this repo, one command, idempotent (a non-JS
      repo becomes a TUT project without any hand editing): creates
      .context-hub/, appends it to .gitignore (no duplicate entry when the
      ignore rule is already there), and maintains the TUT block in this
      project's AGENTS.md (creates the file when absent; an existing marked
      block is refreshed in place, never duplicated). The block tells
      agents receiving "act as TUT Host / drive this task" instructions to
      run 'tut skill host'; worker-role skills are supplied automatically
      by the launcher.

--url selects a Hub belonging to this workspace (verified via /state.hub_root).
Without --url, try TUT_HUB_URL or ${DEFAULT_HUB_URL}, then discover this
workspace's hub on local ports 3001–3199. Run tut up to start a missing rig;
up automatically selects a free hub/notifier pair. An explicit foreign
--url is rejected; use the matching workspace or correct the URL.
`;
