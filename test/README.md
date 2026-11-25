# Running tests

Use an isolated checkout with Node >=20 and dependencies installed. Do not copy
`.context-hub` into it: notifier fixtures use cwd as a rig. Fixture TEMP must also
have no ancestor `.context-hub`. On Windows, put the installed Git cmd and bin
directories on PATH and use native PowerShell/.NET to compile executable fixtures.
An unusable Git/sh environment exits 2 before tests start. Real coding-agent
credentials are not required.

```sh
npm run build
npm run typecheck
npm run test:profiles
npm run test:dev-mac         # macOS only
npm run test:win32-gate      # native Windows only
npm run test:component -- component:herdr
npm run test:component -- component:agents
npm test                     # release-full
npm run test:inventory       # full selection and process budgets
node scripts/test/run.mjs win32-gate --list
```

| Profile | Selection | Exclusions |
| --- | --- | --- |
| `dev-mac` | All non-measure layers, including Herdr and power; usage-audit Node suites and profile contracts | `measure/`, declared native-process budget tier, case-level measurements |
| `win32-gate` | `core`, `lanes/detached`, `lanes/windows`, `integration`; usage-audit Node suites and profile contracts | Herdr, shared launcher lane, power, `measure/`, case-level measurements |
| `component:<name>` | Matching component across all layers; a layer name selects its whole layer; `component:usage` also includes usage-audit Node suites and profile contracts | Existing per-case platform declarations |
| `release-full` | All layers, usage-audit Node suites and profile contracts | Existing per-case platform declarations |

Use `--list` to inspect any profile on any platform. Executing `dev-mac` requires
macOS; executing `win32-gate` requires native Windows. Jobs run serially. The
Windows gate runs native acceptance immediately after core and gives each lane
suite its own watchdog process. Every selected job runs even after an earlier
failure; the runner returns nonzero if any job fails.

## Suite organization

| Layer | Responsibility |
| --- | --- |
| `core/<component>` | Hub, config, state, notifier and component contracts |
| `lanes/herdr` | Herdr launcher, delivery and pane surface |
| `lanes/detached` | Detached execution, admission, observation and run lifecycle |
| `lanes/windows` | Win32 broker, supervisor, file safety and native acceptance |
| `lanes/shared` | Shared launcher resolution, checkout and fixture contracts |
| `integration/<component>` | Real component chains, CLI/HTTP/MCP and agent compatibility |
| `power/<component>` | Standalone and Windows power/listener behavior |
| `measure/<component>` | Wall-clock-sensitive measurements |

Register every suite in `suites.json` with exactly one environment/component
owner. Keep filenames stable. `suites` preserves the original baseline identities;
`additionalSuites` records extracted cases and their original owner. The inventory
check rejects undeclared files, duplicate owners, baseline count drift and paths
outside the two-level layout. Shared fixtures live in `test/bin`, `test/fixtures`,
`test/helpers` and `test/rig-fixtures.ts`. Use current paths in scripts and docs;
use manifest `previousPath` to correlate historical evidence without rewriting it.

## Clock and native-process declarations

Use `measurement` from `test/environment.ts` for case-level wall-clock
measurements. It has the Vitest `it` collector API. Both gates skip these cases;
direct Vitest, component and release-full runs execute them with their original
assertions and timeouts. Existing per-case platform skips remain in effect.

Declare whole-suite measurements under `measure/`. A logical clock alone does
not make a throughput-sensitive test suitable for gates: repeated real Store
polling can still measure host speed. Keep product deadlines and measurement
assertions intact when declaring such tests.

The manifest's `native-process` budget tier covers close-audit, run,
run-cooperative, run-resume, launcher-detached and power-standalone. These suites
remain in release-full and component runs. The Windows gate retains every
selected detached suite. `nativeFixtureTimeoutMs` gives detached native fixtures
a 360-second Windows host budget, separate from inner waits, product deadlines
and the process watchdog.

## Process budgets and results

| Process tier | Watchdog budget |
| --- | --- |
| close-audit (separate process) | 600,000 ms |
| observation (separate process) | 300,000 ms |
| measure layer (release/component) | 900,000 ms |
| Other layer / individual Windows lane suite / Node suites | 1,800,000 ms |

Watchdogs are independent of case/hook timeouts and product deadlines. Expiry
fails the gate with exit 124 and kills that runner-owned process tree. Investigate
it; do not convert it to a pass or automatic exclusion. If the root has already
exited, descendants are reported as unverified and inherited pipes are closed;
the watchdog does not signal a potentially recycled PID or process group.

Results go to a new OS temporary directory. Set `TUT_TEST_RESULTS_DIR` to an empty
destination to retain them elsewhere. Each job writes its log, Vitest JSON when
applicable, and a receipt in `summary.json` containing selected files, elapsed
time, budget, natural exit code, signal, watchdog and interruption flags.
Platform and measurement skips remain visible in the original report.
