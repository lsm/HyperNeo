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
TypeScript watchdog. Retain build.json, daemon.log and cleanup.json. The compiled
entrypoint selects production mode internally; all state still belongs to this
disposable test HOME and DB. This checks startup/worker loading, not embedding
inference or native Desktop UI. Every owned child stops in finally.
