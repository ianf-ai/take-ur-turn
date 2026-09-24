import { DEFAULT_HUB_URL, DEFAULT_EVENT_PORT } from "./shared.js";

export const USAGE = `tut — Take Ur Turn Context Hub

Usage:
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
      Read / write project runtime config (.context-hub/config.json — the
      file serve re-reads every request, so writes take effect on the next
      poll cycle, no restart; works with the Hub down, same discipline as
      tut assign). Keys: flow_mode ("manual"|"auto" — the offline equivalent
      of tut mode), auto.remediate (off | enter-repress), auto.launch_roles (comma-separated bare role names —
      e.g. architect,executor,reviewer; "" clears the whitelist). get also
      reads notify (read-only: an object config,
      edit config.json by hand). Unknown keys and illegal values are
      rejected with the available keys and their value domains. Default
      --root: .context-hub (relative to cwd — run from the project root,
      the same root tut serve defaults to).
  tut start-next [<task_id>] [--url <u>] [--force] [--fresh]
      Human-confirmed launch of the next agent. Without task_id: pick the single
      task waiting on an agent (none → list human-waiting tasks; ambiguous →
      list candidates and ask to specify). Duplicate launches are blocked;
      --force permits a manual retry after inspecting the pane and outstanding calls. --fresh (orthogonal to
      --force): force-close the task's same-role pane and birth a brand-new
      one — the explicit outside-perspective choice (system-design 4.4);
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
      solo = small change, review skipped (code_changes → approval directly).
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
  tut up [--url <u>] [--event-port <p>] [--dry-run]
      Provision the workspace power switch (idempotent): hub + notify panes
      only — role/agent panes are no longer pre-provisioned: launchers
      raise agent panes on demand at hand-off time. --url targets a
      non-default local hub (loopback + explicit port; it must not equal the
      event port — up refuses the collision up front). --event-port moves the
      notifier's event listener off ${DEFAULT_EVENT_PORT}: up probes, provisions,
      and renders the notify command against the same port (a non-default port
      is passed through explicitly so the provisioned notifier cannot drift
      back to the default).
  tut ack <task_id> [--note <text>] [--url <u>]
      Acknowledge a task's anomalies as handled: appends a human note with
      ack=true — accumulated warnings clear and needs_attention resets on
      the next state pass. Existing records are never modified.
  tut status [--json] [--url <u>]
      Human overview: task totals (attention/closed counts) plus a table of
      every task — needs_attention first, then newest updates first.
      One-shot snapshot (continuous watching is tut notify's job); --json
      prints the same filtered/sorted snapshot for scripts.
  tut doctor [--root <dir>] [--url <u>] [--json]
      Report-only environment & assembly self-check: eight checks — hub
      reachability (/state), notifier event port, config & workspace chain,
      agent executables, storage health, path safety & probe endpoints,
      platform info, agent-channel network verdicts. Checks never modify
      anything; every problem comes with a fix command to run by hand.
      Exit 0 = no failing check (warnings allowed), 1 = at least one failing
      check; --json prints the machine-readable DoctorReport (the same
      report the text rendering draws from). Defaults: --root .context-hub
      (relative to cwd), --url the default hub.
  tut repair-meta <task_id> [--title <t>] [--description <d>] [--creator <c>] [--created-at <iso>]
                  [--flow <full|direct|solo>] [--cast <role=command>]... [--checkout <current|worktree:path>] [--url <u>]
      A-class storage repair (system-design 4.3): rebuild a corrupt/missing
      meta.json through the RUNNING hub (POST /repair-meta, its single-writer
      queue — same discipline as tut mode; a second process writing meta
      directly would race concurrent appends). version is computed
      server-side from the record files, never caller input. Rebuild fields
      are your best available archive (notifier snapshot, read response,
      notes); omit what is unknown — title falls back to the task_id, flow to
      full. A readable meta is refused (repair is not an overwrite path),
      records are never touched, and the repair itself does not close the
      task — decide close afterwards if that was the intent.
  tut recover-record <task_id> <record_file> --from <path> [--source <text>] [--url <u>]
      B-class recovery registration (system-design 4.3): register the
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