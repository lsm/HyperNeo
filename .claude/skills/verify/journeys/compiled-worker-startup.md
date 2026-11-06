# Compiled worker startup

Read the shared isolation rules. This proof starts an actual compiled CLI or
standalone daemon using a fresh synthetic HOME, data directory, DB and workspace.
It chooses a non-8399 ephemeral port and blocks credential/app-discovery commands
through its own PATH. It never starts a model turn or uses a provider key.

```bash
bun scripts/build-binary.ts --target bun-darwin-arm64
RUN=$(mktemp -d /private/tmp/hn-compiled-workers-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/compiled-worker-startup.ts dist/bin/hyperneo-darwin-arm64 "$RUN"
```

Use the appropriate local platform target and run again with a fresh RUN for
hyperneod. The proof checks HTTP readiness, system.build over the actual operation
door and its PID/health, then rejects missing gateway/embedding modules and a raw
TypeScript watchdog. Retain build.json, daemon.log and cleanup.json. The compiled entrypoint preserves exact NODE_ENV=test; all other values still
select production. The actual compiled human-login gate must report its test-mode
skip; a synthetic security executable records any unexpected credential-discovery
attempt, and the test config must suppress its default structured-log file.
Other direct NODE_ENV reads remain build-folded; this is not a claim that every
background test guard is dynamic. All state belongs to the disposable HOME and DB. This checks startup/worker loading, not embedding
inference or native Desktop UI. Every owned child stops in finally.

## Windows

The `Windows Compiled Worker Smoke` CI job runs on PRs that affect the daemon
runtime or build, as well as dev/tag runs. It compiles the native worker fixture
and the actual Windows CLI with the same worker manifest as release builds,
then runs this isolated proof and uploads `windows-compiled-worker-evidence`.
`All Tests Pass` requires this job to pass. The fixture executes a typed worker
from an unrelated directory, not a source checkout lookup.

To repeat on a Windows machine, build with
`bun scripts/build-binary.ts --target bun-windows-x64`, then use PowerShell:

```powershell
$run = Join-Path $env:TEMP ('hyperneo-compiled-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force "$run\home" | Out-Null
$env:HOME = "$run\home"
$env:HYPERNEO_DATA_DIR = "$run\data"
$env:NODE_ENV = 'test'
bun .claude/skills/verify/compiled-worker-startup.ts dist/bin/hyperneo-windows-x64.exe $run
```

The child uses its own HOME/USERPROFILE, DB, data directory and temporary files.
Keep build.json, daemon.log and cleanup.json. Do not use the human's daemon.

The WS probe uses the isolated daemon's owner-only local credential file. On
Windows the daemon creates an ACL restricted to the current OS user before
writing the token. The helper warms the ACL cache, grants Everyone read access to the disposable
credential with icacls, verifies that its changed identity is rejected, and restores
the private ACL. Reconnects of an unchanged file reuse only the ACL verdict.

## Compiled fixture timeout regression

The fixture's outer test budget is 52 seconds: 10 for source execution, 30 for
compilation, 10 for compiled execution and 2 for cleanup. Each child retains its original limit
and both `compiled-worker-ready` assertions remain required.

Run `bun .claude/skills/verify/compiled-worker-timeout.ts <fresh-run>` to exercise
a disposable copy of the actual test with a 5.5-second delay inside the compiler
child, followed by the real compile. It keeps the source and compiled assertions
unchanged and scrubs HOME/USERPROFILE/TEMP/TMP for its child. No daemon or model
runs. The copy is removed in finally; logs stay under `<fresh-run>/evidence/`.

Pass `--reproduce` to restore a 5-second test limit on the copy. This must report
`Test timed out after 5000ms`; the helper accepts only that expected failure.
Without the flag the same delayed compile must pass. This injects compiler delay;
it does not claim to reproduce Windows runner load naturally.

The Windows CI job runs that red reproduction and three separate green executions
on the native Windows runner, then retains each log in its existing evidence
artifact. A macOS/Linux pass alone does not verify Windows stability.

## Cold-shell and cleanup resource bounds

The cold PowerShell preflight gets 30 seconds. The actual ACL probe and daemon
startup must still pass afterward. The fixture waits synchronously for its source,
compiler and compiled child before cleanup. Its one directory removal allows five
Windows lock retries with 100 ms linear backoff, totaling at most 1.5 seconds of
backoff for a transient lock. The script-owned removeTempDirectory helper retries
only EBUSY, EPERM and ENOTEMPTY on Windows. Persistent locks fail after six removal
attempts; other errors and platforms fail immediately. Bun 1.4.2 parses the native
rmSync retry options but its removal implementation ignores them, so these waits
are explicit and asynchronous. The Windows fixture job also tests these bounds.

Run the resource regression helper with fresh directories:

```sh
bun .claude/skills/verify/windows-smoke-resources.ts "$RUN/resources-red" --reproduce
bun .claude/skills/verify/windows-smoke-resources.ts "$RUN/resources-green"
```

The helper executes the actual preflight statement against a compiled child that
takes 11 seconds. On Windows it also executes the fixture and both SDK runtime
cleanup statements while a compiled executable in each directory runs for 500 ms.
Reproduction restores the old bounds and requires ETIMEDOUT and EBUSY or EPERM. The normal
run requires both operations to finish successfully. It waits for the locker to
exit in finally and saves windows-resources.json. The Windows job runs both modes
and uploads their evidence. Other platforms exercise only the preflight budget
and explicitly leave Windows locking unverified. Injected delay and a known held
directory reproduce the failure mechanisms; they do not identify which external
runner process held the original fixture or naturally reproduce runner load.
