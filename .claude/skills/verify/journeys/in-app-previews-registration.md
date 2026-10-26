# In-app previews: registered immutable receipts (slice 6)

Run daemon `preview-register.test.ts` plus the existing capture, descriptor, policy
and contract tests. Registration's native proof creates only synthetic work/ask,
session, SQLite and workspace fixtures. It first failed on the missing operation;
registration admission now treats context as path-resolution metadata rather than
an ownership veto. Snapshot reads retain their separate current ownership checks.
The native test changes to an unrelated synthetic working directory before launch;
its helper is anchored to the test file URL, so runner cwd cannot change resolution.

It verifies descriptor-only capture, immutable registry rows, changed-content IDs,
new immutable revisions for changed sources and reused requests, identical retry after source removal,
concurrent idempotency, persisted identity/receipts across restart, invalid raster
magic/binary text refusal, size details, symlink refusal and DB-query exclusion.
Source removal is a rename retaining the synthetic original. A retry's metadata
absence probe never grants byte access: every byte/hash uses the no-follow opener,
and any receipt returned was already registered. Snapshot reads check authorization.

For the actual operation.invoke door, run from the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-register-daemon-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-register.ts "$RUN" seed
```

Build web, then Launch on a free port other than 8399. While the owning shell keeps
that isolated daemon alive, run the following before and after an owned restart:

```bash
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-register-rpc.ts "$RUN" capture 9386
.claude/skills/verify/doctor.sh 9386 "$RUN"
.claude/skills/verify/stop.sh "$RUN"
.claude/skills/verify/launch.sh 9386 "$RUN"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-register-rpc.ts "$RUN" restart 9386
.claude/skills/verify/stop.sh "$RUN"
```

The RPC proof registers a short reference without absolute source paths, confirms
same-request receipts, refuses traversal and sensitive paths, accepts explicit absolute files without contexts, creates a
new version after changed bytes, retains the source under a renamed path, then
retries successfully after daemon restart. Its read-only synthetic DB inspection
checks the receipt's blob size/hash and exact bytes. Keep evidence in
`evidence/register-rpc*.json` and native `register-evidence.json` plus doctor output.
Run the actual MarkdownRenderer suite headlessly in happy-dom and build web for
compatibility; there is no new viewer or unattended GUI in this slice.

Discovery constructs metadata only and performs no SQLite access. First invocation
initializes one service per daemon DB handle, which owns reservations and registration serialization;
all catalogs reuse it. No request may supply owner IDs, roots or kind. This first
registration binding supports local HyperNeo todo worker sessions and ask sessions
with persisted workspaces; missing native cwd or context requires an absolute path instead of vetoing registration.
No new evidence-root approval UI is introduced, so the binding loader grants none.
Registered-ID get/list/read and clients remain slices 7 onward. Kind comes from
extension plus bounded byte/MIME checks; preview-specific parsing/decoding remains
in its viewer slice. Registry tables stay outside every agent DB-query allowlist.
No automatic sweep, expiration, original deletion, credentials or live DB is used.

See attachment-paths.md for the current isolated RPC regression covering unrestricted
explicit non-sensitive files and changed-source revisions.
