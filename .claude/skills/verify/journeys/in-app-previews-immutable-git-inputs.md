# In-app previews: immutable Git capture inputs (slice 11a)

Slice 11 measured 327 production lines added/31 removed and exceeded its declared
300-line contract before push. This Build part adds only immutable Git input and
shared storage primitives. Part 11b wires resolver selection and durable receipt
provenance after this part merges. Slice 11/iOS prerequisite is not complete here.
The resolver must still return unsupported_type for an explicit Git document.

Run preview-git-capture.test.ts plus prior preview/native/store/contract tests,
Neo PR summaries and existing gh lookup/preset tests. The first test run fails on
the missing Git reader module. Use the installed runner from packages/daemon;
root invocations require its installed binary and absolute config/root paths.

The reader accepts full commit SHA only, uses the existing bounded gh lookup,
checks the returned commit/tree IDs, walks nonrecursive tree objects by exact
segment and requires each returned API object URL to match its requested endpoint.
It admits regular blob modes only. Never follow a symlink, submodule,
download_url or authored URL. Enforce 64 components, 64 MiB decoded bytes, metadata
one-MiB responses and a blob-only bounded JSON envelope large enough for Base64.
Malformed/truncated responses refuse; no bytes are silently shortened. Require
canonical Base64, exact complete size, Git blob SHA-1 and complete SHA-256.
GitHub documents the [tree modes](https://docs.github.com/en/rest/git/trees) and
[Base64 blob endpoint](https://docs.github.com/en/rest/git/blobs).

Authorization will remain in part 11b's stored-source/context operation door;
this internal Build reader grants no client or agent endpoint. Candidate/path
and sensitive-name checks remain defense in depth. Git traversal starts from a
bound immutable commit and exact object IDs. Local filesystem capture keeps its
anchored openat/no-follow descriptor boundary. Byte ingress clones the complete
verified input before asynchronous writes, then reuses the same quota reservation,
staging/fsync/link/dedup protocol as local capture. No automatic recovery sweep.

The native proof uses actual Bun, synthetic migrated SQLite and a strict local gh
fixture process. It verifies bytes larger than the normal one-MiB lookup cap,
invalid/revoked-looking revisions without any lookup, wrong commit/tree/blob IDs,
symlink/submodule modes, duplicate entries, malformed Base64/hash/size, oversized
metadata and size refusal before fetching an oversized blob. It mutates the
caller buffer after starting capture and requires unchanged saved bytes. Local
registration and Git byte ingress share one capture owner/quota; retries dedup,
concurrent small-quota captures reserve atomically and restart inventories agree.

```bash
RUN=$(mktemp -d /private/tmp/hn-git-inputs-native-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-git-capture.ts "$RUN"
```

For isolated compatibility, build web and create another fresh run/home. Seed with
preview-git-capture.ts RUN seed, then launch using
VERIFY_GH_STUB=preview-git-gh.ts .claude/skills/verify/launch.sh 9386 RUN. The stub
serves only explicit fixture Git endpoints and PR views; all other commands refuse.
Keep launch/probe/stop in one owning shell with a stop.sh EXIT trap. Run
preview-git-capture.ts RUN probe under the same synthetic HOME/PATH/NODE_ENV=test,
then preview-pr-summary-rpc.ts RUN read 9386 and doctor.sh 9386 RUN. Stop both
owned services, restart with the same explicit stub, run the PR summary RPC helper
in restart mode and stop again. This proves new internal Git inputs plus unchanged
existing RPC compatibility; it does not claim a Git capture operation is exposed.

Retain git-capture-inputs-evidence.json, git-inputs-probe.json, PR RPC evidence,
gh.log and doctor output. Stop owned services; keep synthetic fixtures/evidence.
Run actual MarkdownRenderer tests headlessly and build web. No unattended GUI,
live database, credential-file read, real GitHub/provider traffic, port 8399,
migration or script-running HTML. Git resolution/receipt provenance and iOS
prerequisite 11 completion remain for part 11b.
