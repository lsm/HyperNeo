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
failure reply without replacing unrelated settings. The writer captures request-only
before/after values inside its transaction; compensation checks the latest values
and preserves later edits, including Neo-owned fields. A second WAL connection
commits unrelated fields during the synthetic credential failure to reproduce
the old full-row rollback loss. A main-connection writer lock must keep the RPC pending while
`system.health` and the event loop remain responsive, then release the write.
The deliberately held write is expected to exceed the 250 ms affected-latency
target; evidence records that failure explicitly.

Evidence is saved in `evidence/global-settings-writer.json`. The helper closes
its socket and daemon in finally. This slice routes the settings RPC persistence
and rollback only; provider/endpoint synchronization and legacy synchronous
settings callers remain separate slices. It does not establish disk causation,
large-body performance, worker-death behavior, or queue/clone/SQL timing. Run this same helper with Deno 2.9.4 as well; the
required Deno boot CI must also pass before merge.

The coexistence regression in `global-settings-write-coexistence.test.ts` uses
two real WAL connections and injects a competing commit immediately before the
legacy statement executes. A synchronous patch must preserve that commit; a
SELECT followed by replacement loses it. The repository now patches top-level
keys in one UPSERT, including explicit null values and undefined-key removal,
while retaining shallow replacement of nested values. Full saves remain full
replacement. No additional main-thread transaction is introduced.

The rollback unit contracts also cover a same-field later edit, a writer-queue
before-image race, omitted values and Neo field ownership. The old whole-Neo
legacy-caller migration is tracked separately in #8829; this slice does not
claim to fix those core-owned callers.
