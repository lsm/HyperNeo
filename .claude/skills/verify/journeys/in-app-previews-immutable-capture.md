# In-app previews: immutable capture storage (slice 5)

Run `preview-capture.test.ts` with the daemon Vitest runner. Its native proof runs
in a separate Bun process, while the Node runner asserts unavailable native opens
cannot stage bytes. Size/quota gates run directly and in their pipeline.

For retained evidence, run from the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-preview-capture-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-capture.ts "$RUN"
```

`capture-evidence.json` records full binary/Unicode bytes and SHA-256, read-only
write-once blobs, sequential/concurrent dedup, size limits and quota reservations.
The deliberate delayed-finalization dedup regression fails before serialization
of commits. Source mutation returns source_changed and retains partial bytes;
injected disk-full errors retain earlier blobs and unfinished staging. A child
process pauses after syncing a partial capture; the helper kills only that owned
child and reopens its store. Inventory must retain all prior blobs and partial
bytes and charge those partials to quota. No expiry or recovery sweep is allowed.
Tampered existing blobs must not be overwritten or accepted as a valid capture.

Only successful transactions remove their own staging filename after a durable
blob link exists. This transfers ownership of the complete bytes; it never deletes
an existing artifact or its source. Every failure preserves its staging. Inventory
counts shared inodes once, including crash windows with staging and blob links.
Instantiate one store per owning daemon data directory under its existing PID
lock; concurrent captures share that owner's reservations and commit lane.

Repeat the isolated daemon capture/restart and headless Markdown component journeys
for compatibility. The new store is internal, not a transport or raw-path reader.
It consumes only the no-follow descriptor seam; no source path is reopened. Registry
and idempotent receipt wiring remain slice 6, authorized registered-ID reads slice 7.
Unsupported native backends fail closed. This proves process interruption/recovery,
not host power-loss behavior on every filesystem. Keep synthetic evidence/fixtures;
use no live DB, credentials, provider/model or unattended GUI.
