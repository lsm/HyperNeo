## SDK settings preparation responsiveness

Use a fresh synthetic HOME, workspace and DB. The helper creates a FIFO only in
that workspace (or the synthetic user's `.claude/settings.json`) and starts an
owned writer that supplies JSON after 1.4 s. It calls the real SettingsManager
through an isolated daemon RPC while requesting `system.health` on the same
WebSocket. It records health latency, preparation duration and maximum 10 ms
heartbeat lag, then stops its writer and daemon. No model or credentials are used.

```bash
RUN=$(mktemp -d /private/tmp/hn-settings-proof-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/settings-admission-lag.ts verify 9364 "$RUN" workspace
```

Repeat in another fresh directory with `user` instead of `workspace`. On the
regression commit use `reproduce` instead of `verify`: `observed.json` must show a
block over 1 s and a delayed health reply. Fixed code must keep heartbeat lag
below 1 s and health below 250 ms while settings preparation still takes 1.4 s.
This proves a synchronous settings I/O hazard; attribution of the historical
2026-10-20 17:48:36Z production stall remains unproven.

Repeat `verify` in a fresh run with `dangling` instead of `workspace`. This puts
a relative settings symlink in the synthetic workspace whose target does not
yet exist and delays the synthetic user attribution through the FIFO. The
receipt must show `settingsSymlinkPreserved: true`, and the new target must
contain the inherited synthetic attribution. Before the target-resolution fix,
this journey records `false` and fails because rename replaced the link.
Absolute/relative/chained missing targets and a missing parent directory are
also pinned in the focused settings suite. Missing parents and native symlink
resolution errors fail without replacing the original link.

Settings preparations share a promise chain keyed by the resolved target path,
including across SettingsManager instances and workspace aliases. They re-read
local settings after awaiting inherited attribution, then commit complete JSON
with a same-directory temporary file and rename, preserving existing permissions
and symlink targets. This does not lock unrelated external editors. Invalid JSON
is reported without including its contents and left untouched. A failed write
only unlinks its own successfully created staging file, never the settings file
or another writer's temporary file.

The focused settings suites also exercise overlapping sessions, an external edit
during the delayed attribution read, invalid JSON and queue recovery, read-only
directories, and an injected staging-write failure. All fixtures stay in their
own temporary workspace and user-settings directory:

```bash
cd packages/daemon
bunx vitest run tests/unit/1-core/session/settings-manager.test.ts tests/unit/1-core/session/settings-responsiveness.test.ts
```
