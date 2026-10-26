# In-app previews: stored reference plans (slice 8)

Run daemon `preview-candidates.test.ts`. The first run must fail without the new
candidate/planner modules. Recognition uses unified + remark-parse + remark-gfm,
the existing chat Markdown grammar, without a second Markdown parser or renderer.
Exercise explicit links (including reference definitions and space-containing
paths), inline paths, standalone tokens, file URLs, PR links and full-SHA blob
URLs. Fenced/indented code, images and raw HTML attributes do not supply
candidates. Inline code supplies one complete literal, including spaces; command
arguments are never extracted from it. A command-looking literal can resolve only
if that entire literal names a reviewable file under the authorized root. Bare
whitespace-separated tokens never combine into a spaced path. Limits bound
candidate work; stored text is never rewritten.

Require an exact reference match in the loaded source and exact source/revision
key. The injected loader is a trusted server port, never client-supplied text,
roots, repository, revision or authority. Slice 9 owns its production repository
adapter and human-only operation door. This slice exposes no resolver operation.
Require current caller authority using the existing context gate. Ambiguity
offers only authorized contexts; missing/revoked/foreign references refuse.
Remote owning daemons refuse local reinterpretation. Relative paths use the
bound worktree, never process cwd. Plans distinguish worktree snapshots (optional
base commit, never a claim of HEAD bytes) from exact full-SHA Git blobs. PR/blob
URLs must match the repository supplied by the trusted binding, including host;
no host discovery, arbitrary fetching, credentials or redirects are introduced.

For actual persisted publication revisions, run the native Bun helper from a
fresh directory with a synthetic HOME:

```bash
RUN=$(mktemp -d /private/tmp/hn-candidates-native-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-candidates.ts "$RUN"
```

It seeds its own migrated SQLite database, stores and edits a real publication,
renames/retains the synthetic workspace, reopens SQLite read-only and plans the
original historical reference independently of the latest revision. It refuses
references absent from that specific revision and refuses the previous worker
after its persisted binding changes. Retain candidate-evidence.json and fixtures.
No artifacts directory is created, no source bytes are opened and no Git/network
command is run by planning. Candidate parsing and sensitive-name/path denials are
defense in depth only. A plan is not a file grant: future tap capture must recheck
current bindings and use anchored openat/no-follow descriptors, then complete
hash-addressed immutable storage. Never use parsing as the byte-access boundary.

For isolated daemon compatibility, follow the authorized-reads journey using
preview-reads-rpc.ts seed/capture/restart with a fresh run directory and port 9386.
Keep launch, doctor, proof and stop in one owning shell with a cleanup trap.
Retain both RPC evidence files and doctor output; stop both owned services.
This checks the existing registration/read door, not a slice-8 resolver endpoint.

Run the actual MarkdownRenderer tests headlessly and build web. No unattended
GUI test, client tap routing, PR fetch, Git blob read, migration, script-running
HTML, live database or credential access is part of this build slice. The
observable result is deterministic source-bound plans plus unchanged existing
registered preview reads. End-to-end tap capture waits for slice 9.
