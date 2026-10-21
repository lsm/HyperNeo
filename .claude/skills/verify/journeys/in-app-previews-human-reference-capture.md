# In-app previews: human reference capture (slice 9)

Run daemon preview-resolve.test.ts plus the prior candidate, policy, contract,
safe-open, capture, register, read and operation-name-family tests. The first
test run failed on the missing resolver module. Construction/discovery and
non-human invocation must not touch SQLite. Strict input rejects injected text,
roots or bindings. The paired human alone can invoke artifact.reference.resolve.

The native helper uses real Bun, migrated synthetic SQLite and files. It loads
visible SDK text through the existing split-body hydration seam, current todo
evidence and exact historical publication revisions. Independently parse each
visible card field so a fence in one field cannot change another field's grammar.
Prove full captured bytes/hash, stable request retry, no caller-injected path,
missing sources/files, authorized ambiguity choices, explicit context selection,
remote owning-daemon refusal, symlink refusal and sensitive-name defense in depth.
Reassign persisted worker bindings and require old message ownership to refuse.
Remove the stored reference after real capture but before the resolver finishes:
withhold the response and retain all committed bytes/receipts. Restore the source,
rename/retain its worktree, reopen SQLite, retry the original request and read the
same registered snapshot. Never trim stored source text or delete failed bytes.

Run the native proof with a fresh run/home and NODE_ENV=test:

```bash
RUN=$(mktemp -d /private/tmp/hn-resolve-native-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-resolve.ts "$RUN"
```

Build web, then use another fresh run for the actual RPC door. Keep the following
commands in one owning shell with stop.sh in an EXIT trap; port 8399 is forbidden:

```bash
RUN=$(mktemp -d /private/tmp/hn-resolve-daemon-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-resolve-rpc.ts "$RUN" seed
.claude/skills/verify/launch.sh 9386 "$RUN"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-resolve-rpc.ts "$RUN" capture 9386
.claude/skills/verify/doctor.sh 9386 "$RUN"
.claude/skills/verify/stop.sh "$RUN"
.claude/skills/verify/launch.sh 9386 "$RUN"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-resolve-rpc.ts "$RUN" restart 9386
.claude/skills/verify/stop.sh "$RUN"
```

Retain resolve-evidence.json, resolve-rpc.json, resolve-rpc-restart.json and doctor
output. Doctor must report usable; stop all owned processes. Run actual chat
MarkdownRenderer tests headlessly and build web. No unattended GUI test or new UI
is introduced. Clients must retain a request UUID across retries and send only a
source key, exact reference and optional context choice, never roots or file text.
Publication revisionId selects history; without it, current stored text is used.
Unversioned SDK/todo sources refuse an unsupported revisionId. Metadata/read still
reauthorize registered IDs, and snapshot hash is available through artifact.file.get.

The resolver reuses descriptor-safe immutable registration and rechecks the plan
after capture. Candidates/denials are defense in depth; anchored openat/no-follow
descriptors and hash snapshots remain the byte boundary. No path-based open,
Git/network subprocess, migration, credential access, public URL or script-running
HTML is added. PR/Git plans return unsupported_type until slices 10/11 wire them;
client tap UI remains for web/iOS slices. This is iOS prerequisite slice 9's API
contract, not a claim that the complete preview lane or clients are finished.
