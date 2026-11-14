# Global settings cache visibility

Run the focused regression on the build/test host with Bun 1.4.2. It boots a real
isolated daemon on an ephemeral port and calls the authenticated WebSocket
settings update door. Use a fresh synthetic HOME and data directory, with no
provider credentials in the environment. The daemon test owns its synthetic
data directory and restores the prior environment after cleanup.

From the repository root, choose a fresh evidence directory and run this in Bash.

```bash
bash .claude/skills/verify/resource-check.sh && (
  RUN=$(mktemp -d "${TMPDIR:-/tmp}/settings-cache-proof.XXXXXX")
  trap 'rm -rf "$RUN"' EXIT
  mkdir -p "$RUN/home" "$RUN/tmp"
  cd packages/daemon
  env -i PATH="$PATH" HOME="$RUN/home" TMPDIR="$RUN/tmp" NODE_ENV=test \
    HYPERNEO_SPACE=on \
    bun test tests/unit/4-space-storage/storage/global-settings-cache.test.ts \
      tests/unit/1-core/operations/neo-rule-answers.test.ts
)
status=$?
printf 'EXIT_CODE=%s\n' "$status"
exit "$status"
```

Retain stdout and stderr outside the disposable run. The baseline fails with ten
SQLite SELECTs for ten repeated reads. The fixed tree must pass with zero extra
SELECTs between committed changes. The test covers full save, synchronous patch,
worker patch, compensation, WebSocket settings update, Neo mute and tool-default
transition. Each next read must expose the committed value. Caller mutation of a
returned nested object must leave subsequent reads intact. The daemon, socket
and synthetic database close in finally. This proves RPC and facade behavior.

Warm-cache regressions must also expose a human-approved standing rule through
`neo.question.answer`, startup tool-choice migration and the original committed
value after a transaction reads its own write and rolls back. Low-level settings
writes advance a connection-local revision even without a reactive notifier.
Reads inside SQL transactions discard and bypass the facade cache, preventing
uncommitted values from surviving rollback. Worker commits retain reactive
invalidation. These checks use synthetic data only.
