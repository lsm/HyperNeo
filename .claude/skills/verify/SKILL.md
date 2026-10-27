---
name: verify
description: Prove a HyperNeo change works by running an isolated daemon and web UI and driving it like a user. Use before saying a change is done.
---

# Verify HyperNeo

Run the change where a user would meet it: an isolated daemon, its RPC door and
its web UI. Lint, types and unit tests are not proof. Every helper named here
lives next to this file in `.claude/skills/verify/`. Run commands from the repo
root of your worktree.

## Rules

- Never start, stop or mutate the human's daemon. Isolated runs never use port
  8399, `~/.hyperneo` or a copy of a real database. Journey 15 only reads logs.
- No provider key in the environment, real or fake. `launch.sh` starts from
  `env -i` with `NODE_ENV=test`, a temp `HOME`, and its own data dir and DB, so
  credential discovery is off and keys stay in that DB, never the keychain.
- Model turns go to a local mock of the Anthropic API (`mock-api.ts`, the same
  server CI's dev-proxy mode uses) on the mock port (8000 unless VERIFY_MOCK_PORT
  overrides it). Give the isolated daemon the
  dev-proxy key over RPC (step 3 below), never through its environment.
- GitHub is normally a stub: `gh` on the daemon's `PATH` answers `gh pr view` from
  `<run>/pr.json`, refuses everything else (including `gh auth token`) and logs
  every call to `<run>/evidence/gh.log`. Nothing reaches github.com.
  When the user requests real quota measurement, `journeys/coding-ledger-live-cost.md`
  defines the read-only public-metadata exception: a parent CLI bridge, fresh
  daemon homes and no credentials passed to the daemon. Other journeys retain
  the refusing stub and network isolation.

## Launch

```bash
cd packages/web && bun run build && cd ../..
.claude/skills/verify/launch.sh 9311 "$RUN"
```

- Pick any free port except 8399. `launch.sh` refuses a busy port, and refuses
  if the mock API's port is taken. The mock defaults to 8000; set
  `VERIFY_MOCK_PORT` to run parallel isolated sessions beside each other (the
  daemon's dev-proxy base URL follows it).
- If the host denies `taskpolicy` or `nice` priority changes, set
  `VERIFY_NORMAL_PRIORITY=1`; isolation is unchanged. `VERIFY_REPO` selects
  the source checkout for shared upgrade tooling only.
- `$RUN` is a fresh `hyperneo-verify.*` directory. Create it by wrapping the
  journey in `with-run.sh`, which removes it on success, failure and interrupt
  (`VERIFY_KEEP_RUN=1` keeps it and prints the path), or by hand with
  `mktemp -d "${TMPDIR:-/tmp}/hyperneo-verify.XXXXXX"` plus
  `trap 'rm -rf "$RUN"' EXIT` in the owning shell. It holds `data/`
  (DB), `home/`, `bin/gh`, the logs, the pid files and `evidence/`.
- Ready signal: `ready: http://127.0.0.1:<port>  run dir: <run>`. The daemon log
  shows `HyperNeo Test Server` and `Database: <run>/data/daemon.db`.
- The daemon logs nothing in test mode. Set `VERIFY_LOG_LEVEL=error` (or `info`,
  `debug`) on `launch.sh` to see its errors in `daemon.log`.
- Keep launch and proof in the same owning shell with a `stop.sh` EXIT trap;
  exiting a tool shell can terminate its children before the next tool call.

Headless browser helpers accept `VERIFY_BROWSER` for an installed Chromium
executable and `NODE_PATH` for existing Playwright dependencies. A cached browser
directory may be incomplete: if launch reports missing framework files, retain
the error and report browser proof as pending. An aborted launch is not a pass;
do not change browser permissions or system settings to work around it.
An installed browser that aborts with `SIGABRT` or `EPERM` is blocked too. Keep
its launch log and use component evidence as a fallback, explicitly leaving
screenshots and visual layout unverified.
If browser origin approval is denied, retain that refusal and leave visual proof
unverified. Do not retry through another browser or transport to bypass it;
release the helper and preserve its daemon evidence before cleanup.
Trust the wrapper exit status, not a helper's PASS line. A closed-database error
from background Neo recovery during shutdown makes the daemon proof fail, even
if its reader assertions passed. Retain the log; ask-bookkeeping-actions provides
a listener-free MCP/public-reader/audit proof, without claiming daemon startup
or shutdown verification.

The shared proof-run.sh wrapper forwards only these explicitly selected browser
dependency paths, alongside VERIFY_CLAUDE. Other parent environment values stay
scrubbed; set the browser paths on the wrapper invocation when using --web.

Give it a model, once per run (stored in the run's DB only):

```bash
VERIFY_PORT=9311 bun .claude/skills/verify/rpc.ts rpc:providers.create \
  '{"params":{"providerId":"anthropic","displayName":"Anthropic (dev proxy)","kind":"built_in","authType":"api_key","isEnabled":true,"isDefault":true,"sortOrder":0},"credentials":{"apiKey":"sk-devproxy-test-key"}}'
```

## In-process RPC proofs

On macOS, run `bash .claude/skills/verify/resource-check.sh` before every heavy
verification job or dependency install. It checks `memory_pressure` and disk
space; stop if free memory is below 25% or disk space below 25 GiB. Run only
one heavy job at a time (proof daemon, suite, full check or build), and wait
for it to finish and clean up before starting the next. Reuse one checkout
and its dependencies; do not create baseline worktrees just to compare proofs.
The resource check must succeed before launching a job; chain it with `&&`
or use a shell with `set -e`. For example:

```bash
bash .claude/skills/verify/resource-check.sh && bun run check
```

In a standalone clone beneath a directory named `tmp`, Biome can ignore its `.`
target because the repository excludes `**/tmp`. If `format:check` reports zero
files, run the same check chain with that one command replaced by
`bunx biome format packages scripts .github *.json *.md`. Keep the failure log
and report the explicit-directory equivalent separately; do not change the
repository's ignore rules to accommodate a temporary checkout.

If bare macOS `mktemp` still chooses a restricted system temp directory, run
the shell-based guards under Bash with `mktemp() { /usr/bin/mktemp -p "$TMPDIR"
"$@"; }; export -f mktemp`, where `TMPDIR` is the writable directory already
selected above. Explicit-template calls and proof isolation remain unchanged.

For a metadata-only Bun helper taking `[arguments] <run>`, use:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory "$PROOF" verify
```

For a dual-runtime native-filesystem helper, repeat with `VERIFY_PROOF_RUNTIME=deno`
and the pinned Deno on PATH. The wrapper uses `deno run -A` and keeps its cache
inside the disposable run; the default remains Bun.

The wrapper checks disk space, creates a disposable HOME/data/TMPDIR, saves
the helper's evidence JSON and log outside that run, then immediately removes
its temporary daemon data. It preserves failure status and never deletes the
run if saving evidence fails. Keep baseline and fixed evidence in separate
directories; the helper must close its resources in finally.

Reader proofs that trap SDK-message SQL must finish startup body copying before
measuring reader work or acquiring a competing writer. After seeding fixtures,
call `waitForSdkBodyCopy(raw)` from `wait-for-sdk-body-copy.ts`, then capture body
hashes and enable the measurement guard. It waits for the real completion or
rollback marker with a deadline; never seed those markers to bypass migration.
Use the transcript/single-message helpers' `--defer-body-copy` mode to exercise
late startup copying deterministically.
The wrapper and Deno smoke trim TMPDIR's trailing slash so HOME/data paths match helpers'
normalized run paths, including macOS's default TMPDIR.
For native Unix-socket fixtures, select `TMPDIR=/private/tmp` when invoking the
wrapper to keep the fresh HOME's socket paths within the OS path-length limit.
If the allowed temporary root is longer, `VERIFY_PROOF_PREFIX=r-` shortens the
wrapper's run name without changing its isolation or cleanup.
Export a writable TMPDIR for web tests, build tooling and git commands too;
their temporary files can otherwise fail before verification starts.
The wrapper forwards NODE_PATH and VERIFY_BROWSER for browser helpers; its
child environment remains otherwise scrubbed.
Set TMPDIR to an existing writable temporary directory when the host restricts
the default temp location; the wrapper creates its disposable run there.
For a Node compatibility-adapter proof, `VERIFY_PROOF_RUNTIME=node` selects
`node --import tsx` with the same isolated environment and cleanup. This tests
the Deno/Node adapter seam; Node remains unsupported as a daemon runtime.

The Deno boot smoke also honors `TMPDIR`. Its fixture-isolation journey is
`journeys/deno-smoke-fixture-isolation.md`; it runs the real smoke with a
competing writer when fixtures overlap the booted daemon.

If a metadata helper cannot bind its own listener (for example EPERM or an
ephemeral port 0 reported as EADDRINUSE), preserve its log and mark daemon proof
blocked. Use a journey's listener-free proof only for the narrower surface it
explicitly covers; unit results do not establish a successful daemon run.
Helpers requiring /private/tmp also need TMPDIR=/private/tmp. Never weaken host
protections to make a proof run.


The wrapper forwards an explicitly selected VERIFY_CLAUDE path for native SDK
proofs. It does not forward provider credentials or the human's configuration.

Some journeys provide a `PROOF` helper that owns its daemon and mock servers.
Use this shared setup with the helper path named in that journey:

```bash
for port in "${VERIFY_MOCK_PORT:-8000}" 8001; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "verification port $port is busy"; exit 1
  fi
done
# The proof helpers below bind fixed ports and never read VERIFY_MOCK_PORT, so the
# preflight must always cover 8000 even when a parallel session uses an override.
if [ -n "${VERIFY_MOCK_PORT:-}" ]; then
  if lsof -nP -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "proof helper port 8000 is busy"; exit 1
  fi
fi
RUN=$(mktemp -d /private/tmp/hyperneo-rpc-proof-XXXXXX)
mkdir -p "$RUN/home" "$RUN/tmp"
env -i HOME="$RUN/home" PATH="$PATH" TMPDIR="$RUN/tmp" NODE_ENV=test HYPERNEO_USE_DEV_PROXY=1 \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn bun "$PROOF" "$RUN"
```

SDK proof helpers disable external registry MCP servers through `mcp.registry.list`
and `mcp.registry.setEnabled` before opening sessions. Inline operation tools remain
available; startup must not depend on downloading an external MCP executable.

When the host restricts the SDK's default `/private/tmp/claude-<uid>` scratch
directory, set `CLAUDE_CODE_TMPDIR` to a fresh directory inside the owned run,
alongside `TMPDIR`. Keep the native SDK sandbox enabled for OS write proofs.

The helper creates its own GitHub stub, uses an ephemeral daemon port, seeds
only its synthetic DB, and closes its resources in finally. Keep its evidence
before removing the run directory. The journey names the checks and any
additional ports; do not also start `launch.sh` for these helpers.

For disk-bounded runs, keep `evidence/` outside the disposable daemon data.
After stopping and waiting for the owned daemon, remove its synthetic data,
HOME and temporary files immediately; retain the evidence and cleanup receipt.
The worker-question-answer-routes helper does this in finally, including failures.

Await session creation through the daemon DB facade before inserting dependent
synthetic SDK or task records. Session writes use the asynchronous DB writer;
an unawaited creation can race a foreign-key insert. When a metadata helper mixes
WebSocket writes with synchronous in-process operation transactions, await a
DB-facade session write before invoking the next transaction, so earlier writer
work has committed. `neo-rule-answers.ts` uses this barrier.

When a journey specifies an ephemeral model mock, omit the 8000/8001 preflight.
That helper must bind its model listener to port 0 and redirect both session and
title requests to the assigned loopback URL. Never reuse another run's listener.

A helper that starts another proof process must preserve the selected TMPDIR
or give that child its own temporary directory inside its fresh run. A scrubbed
child environment must not silently fall back to the host's default temp path.

For a helper whose journey specifies no provider turn or only a synthetic ACP
agent, omit the 8000/8001 preflight loop when it specifies no HTTP mock. Such
helpers own their ephemeral listeners; the remaining isolated environment and
data-directory setup applies.

SDK helpers that explicitly support `HYPERNEO_TEST_DISABLE_SANDBOX=1` may use
that setting for synthetic transport-only checks. Their journey must say so;
this exercises the SDK/MCP path but is not evidence of OS sandbox enforcement.

## Doctor

Dispatch helpers use `codex-desktop-peer.ts` for a synthetic Desktop IPC peer.
They put their run's `bin` first on PATH; the helper stubs `ps` and refuses
`open`, so owner discovery cannot inspect or open the real desktop app.
Explicit Desktop steering and thread creation require the IPC peer. Automatic Codex
sends route by Desktop ownership: while the stubbed probe reports Desktop running
they deliver through owner discovery plus follower steer or turn start, and their
proofs must show no app-server `thread/resume` or native queue call; while it
reports Desktop not running they use the native app-server queue, checking the
loaded list and resuming saved unloaded threads before settings or enqueue, with
already loaded threads never resumed.

```bash
.claude/skills/verify/doctor.sh 9311 "$RUN"
```

Read-only. It checks test mode, that the DB is inside the run dir, that the web
UI is served, that RPC answers, and that the mock model API is up. It ends with
`usable` or `not usable`.

## Drive

- RPC: `VERIFY_PORT=<port> bun .claude/skills/verify/rpc.ts <operation> '<json>'`
  invokes an operation; `rpc:<method>` calls a plain RPC method. A third
  argument keeps the socket open that many seconds and prints the events that
  arrived.
- State: read the run's DB read-only, e.g.
  `sqlite3 -readonly "$RUN/data/daemon.db" "SELECT ..."`. Only the seed and
  check scripts write to it: `seed-todo.sh`, `todo-pr-claims.ts`, `todo-pr-concurrency.ts` (journey 3) and
  `seed-ledger.sh` (journey 4),
  `merge-check.sh` (journey 24), `archive-guard-check.sh` (journey 10) and
  `seed-start-question.sh` (journey 14), `quote-summary-check.mjs` (journey 18),
  `seed-schedule-interrupt.ts` (journey 22), `external-reply-check.ts` (journey 23), and `feed-scope.sh` (work-feed-scope). Artifact preview helpers
  (including `preview-media-web.mjs seed`) delegate DB fixture creation to
  `preview-register.ts seed`, only in the fresh synthetic run.
- Web UI: open `http://127.0.0.1:<port>/neo` (Neo) or
  `/session/<sessionId>` (a session) in the browser; read the page text and take
  a screenshot.

## Journeys

List `.claude/skills/verify/journeys/` and read the file for the behavior you are
changing. Do not assume the skill includes those files automatically. Commands
run from the worktree root; helpers stay in `.claude/skills/verify/`.

```bash
find .claude/skills/verify/journeys -maxdepth 1 -type f -name '*.md' | sort
```

Add a new journey as a new file in journeys/; never edit an index. Use a unique,
descriptive filename; a sequential number is optional. Existing journey numbers
remain in their files so older references still work. Each journey ends in a
state a user can observe.

## Evidence

Save `$RUN/evidence/` outside the disposable run and summarize it in the pull request:

- the RPC replies and DB query output for each journey;
- `voice.json` from journey 2 and `gh.log` from journey 3;
- screenshots of `/neo` and the session view;
- the doctor output.

State what you did not verify.

## Cleanup

```bash
kill "$(cat "$RUN/asr-stub.pid")"   # only if journey 2 started it
.claude/skills/verify/stop.sh "$RUN"
```

`stop.sh` stops only the daemon and mock it started, by their pid files, and
waits for both to exit before the run directory can be reused. Close
the browser tab you opened. After saving evidence, immediately delete the
temporary daemon data and run directory you created.

## Metadata-only daemon proofs

Construction-only writer journeys may invoke a registered command through the
isolated daemon gateway and verify its receipt through a public reader. Record
that public mutation callers remain unchanged; repeat the proof through those
callers in the activation slice before claiming the user path moved off main.

A Windows compiled-startup proof also isolates `USERPROFILE`, `TEMP` and `TMP`.
Use native Windows paths for `HOME` and `HYPERNEO_DATA_DIR` (PowerShell
`Join-Path`). The helper passes `SystemRoot` for Windows process startup but
does not inherit provider credentials or the human's executable search path.

A journey that needs no model may start the source CLI directly under `env -i`
with `NODE_ENV=test`, a fresh `HOME`, `HYPERNEO_DATA_DIR` and `--db-path` inside
its run directory. It must preflight its own non-8399 port, retain the daemon log
and RPC evidence, and own an EXIT trap that stops and waits for that exact child.
No HTTP model mock or provider registration is needed. The worker-identity helper
implements this setup; it never touches another process's occupied mock port.

## Native worker sandbox proofs

Native CLI sandbox journeys use scrubbed child-process environments and disposable
homes too. They may supply a literal synthetic API key only to the native Claude
child connected to the helper's loopback scripted model; never to the daemon or
an external endpoint. Use absolute `VERIFY_CLAUDE` / `VERIFY_CODEX` executable
paths so the daemon's synthetic CLI peers cannot replace the real OS probe.
These helpers preserve CLI tool results and report simulated Desktop transport
separately from actual OS enforcement. Never disable the sandbox for these proofs.


Worker runtime cleanup uses its own OS write boundary: `sandbox-exec` on macOS,
and `/usr/bin/bwrap` (the bubblewrap package) on Linux. The daemon test jobs
install bubblewrap because cleanup enforcement stays enabled even when a model
transport fixture disables the SDK sandbox. Missing cleanup enforcement must
fail closed with runtime retained and no new archived status. Windows does not
apply POSIX permission repair; native Windows cleanup isolation is unverified.

Ubuntu runners must also permit the user-namespace UID mapping used by bubblewrap.
The workflow configures that permission on its disposable CI VMs and runs a
bubblewrap startup probe before testing. Local Ubuntu verification requires a
host policy allowing those namespaces; this journey changes no local host policy.
The cleanup OS boundary stays enabled during these tests.
