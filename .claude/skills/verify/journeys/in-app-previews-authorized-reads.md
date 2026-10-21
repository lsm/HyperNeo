# In-app previews: authorized registered reads (slice 7)

Run daemon `preview-reads.test.ts` plus registration/capture/descriptor/policy,
contract and operation-name-family tests. The native helper uses actual Bun,
synthetic SQLite and files, and a test-file-anchored path independent of cwd.
It first failed on the missing read operation module. It exercises three
transport-neutral operations through invokeOperation and real result schemas.

Metadata get returns a registered reference, parent context, hash, creation time,
relative source path and producing WorkRef. Lists contain bounded references with
an opaque ID cursor, never file bodies or a global worker search. Discovery does
not touch SQLite. Read metadata works against a read-only synthetic DB connection.

Require complete Unicode/binary bytes and SHA-256 in decoded chunks no larger than
256 KiB, byte-exact offsets, empty files, binary PNG, EOF and out-of-range behavior.
Unknown and foreign-owned IDs return the same unavailable result. Reject foreign
context cursors, invalid offsets/limits, raw paths and hash-only lookup attempts.
After current ownership changes, metadata/list/read refuse the previous worker.
The in-flight test performs a real read, changes authority before its awaited
result returns, then requires that no bytes reach the caller. The source workspace
is renamed and retained; reads continue from registered blobs across restart.
A retained staging hard link remains readable. A corrupt tail must withhold even
a requested one-byte prefix. A symlink to otherwise correct outside bytes refuses.
Corrupt data and retained fixture paths remain intact, without automatic repair.

For the actual operation.invoke door, build web and run from the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-read-daemon-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-reads-rpc.ts "$RUN" seed
.claude/skills/verify/launch.sh 9386 "$RUN"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-reads-rpc.ts "$RUN" capture 9386
.claude/skills/verify/doctor.sh 9386 "$RUN"
.claude/skills/verify/stop.sh "$RUN"
.claude/skills/verify/launch.sh 9386 "$RUN"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-reads-rpc.ts "$RUN" restart 9386
.claude/skills/verify/stop.sh "$RUN"
```

Keep launch/proof commands in the same owning shell so the isolated services stay
alive until stop.sh. Doctor must report usable. Retain read-rpc.json,
read-rpc-restart.json and doctor output under evidence/. For a separate native
proof, create a fresh run/home and invoke preview-reads.ts with that temp HOME and
NODE_ENV=test; keep read-evidence.json and its synthetic fixtures.

Run actual MarkdownRenderer tests headlessly in happy-dom and build web for
compatibility. No viewer or unattended GUI is introduced. No new migration, source
path reader, unauthenticated download URL, provider/credential or live DB is used.
All byte reads use anchored no-follow stored descriptors and whole-file integrity;
there is no integrity cache, so each chunk currently hashes the complete snapshot.
Unsupported native platforms fail closed; no successful Deno byte read is claimed.
References/IDs confer no access; connection authentication and current persisted
parent bindings remain required. This is an iOS prerequisite contract, not an iOS
client implementation or a new HTML execution design.
