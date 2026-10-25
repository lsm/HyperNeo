# Global settings RPC persistence on the writer

Use a fresh synthetic in-process daemon; no provider turn, HTTP mock, GUI, real
credentials or live restart is needed. The helper uses an ephemeral port and
asserts it is not 8399.

```bash
RUN=$(mktemp -d /private/tmp/hn-settings-proof-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/global-settings-writer.ts "$RUN"
```

The real WebSocket `settings.global.update` must persist the returned settings,
retain unrelated fields across a later patch, and announce each committed write.
A guard on the main connection rejects every target INSERT, including rollback.
A synthetic credential-store failure must restore prior settings before the
failure reply. A main-connection writer lock must keep the RPC pending while
`system.health` and the event loop remain responsive, then release the write.
The deliberately held write is expected to exceed the 250 ms affected-latency
target; evidence records that failure explicitly.

Evidence is saved in `evidence/global-settings-writer.json`. The helper closes
its socket and daemon in finally. This slice routes the settings RPC persistence
and rollback only; provider/endpoint synchronization and legacy synchronous
settings callers remain separate slices. It does not establish disk causation,
large-body performance, worker-death behavior, queue/clone/SQL timing or Deno
runtime behavior; the required Deno boot CI must pass before merge.
