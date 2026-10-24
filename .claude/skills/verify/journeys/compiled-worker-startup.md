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
