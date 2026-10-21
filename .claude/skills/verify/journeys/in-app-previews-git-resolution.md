# In-app previews: immutable Git resolution (slice 11b)

This resolver/provenance stage follows #8000's immutable Git inputs. Both parts
must merge before iOS prerequisite 11 is complete. Standing human exception:
PR size alone does not block or require further subdivision. No index is edited.

A paired human taps an exact stored full-SHA Git document, or selects a listed
PR file using `{file: {path, headSha}}`. The displayed full head must still match
the bound PR summary. Unknown/moving heads, unlisted paths, wrong repositories,
non-source references and agents cannot turn the request into a file grant.
The publisher rechecks source and current bindings before lookup, after lookup
and before registry save. If the head/source changes during capture, withhold
success. An existing registered snapshot remains readable at its saved SHA.

Reuse the existing bounded gh reader, immutable object traversal and hash checks,
shared quota owner and durable staging protocol. Git byte ingress is internal;
clients get only a registered ID. Registered get/read still require current
context authority and open the hash snapshot with anchored openat/no-follow
native descriptors, checking complete SHA-256. Path/sensitive-name checks add
defense in depth; they are not the primary containment guard. No raw-path HTTP
reader, authored download URL, source deletion or script execution is added.

Revision metadata lives in existing immutable receipt JSON, with no migration:
new Git receipts report commit SHA, blob SHA and bound repository; new local
receipts explicitly say worktree. Old receipts remain readable without revision
or historical rewriting. Registration retry projects only the original reference
response. No Git HEAD is invented for local file bytes.

The native journey invokes actual operation parsing, policy, result validation,
Git fixture subprocesses, migrated synthetic SQLite and native descriptor reads.
It checks complete 1,560,000-byte reads in at-most-256-KiB chunks, stable SHA-256,
commit provenance, identical/concurrent retries, stale head/unlisted path refusal
before blob fetch, wrong repository, source/binding changes during lookup and
source removal during durable commit, concurrent idempotence, old receipt compatibility, Git
symlinks, current remote-owner refusal, worktree labeling and restart/offline
receipt reuse after the synthetic workspace is retained elsewhere.

```bash
RUN=$(mktemp -d /private/tmp/hn-git-resolve-native-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-git-resolve.ts "$RUN"
```

Run focused preview tests from packages/daemon with its installed vitest; also
run operation catalog/Neo/gh tests. Run actual web MarkdownRenderer tests headlessly,
web build and full checks. The first operation regression must fail on
unsupported_type before wiring. Existing local retry tests also catch any
provenance leakage into the strict registration response contract.

For an actual daemon journey, build web and make another fresh RUN/home. Seed
preview-git-resolve-rpc.ts RUN seed under the same synthetic environment. Launch
with VERIFY_GH_STUB=preview-git-gh.ts .claude/skills/verify/launch.sh 9386 RUN.
Keep launch/proof/stop/restart in one owning shell with a stop.sh EXIT trap.
Run preview-git-resolve-rpc.ts RUN read 9386: it resolves explicit Git and selected
PR documents through operation.invoke, reads all chunks, verifies provenance,
refuses a moved PR head, and still reads the original registered SHA. Run doctor.
Stop owned services, write `{}` to RUN/git-fixtures.json, restart with the same
stub, then run the helper in restart mode. It must return the original receipt,
metadata and full bytes without any new GitHub fixture call. Stop again.

Retain git-resolve-evidence.json, both RPC evidence JSON files, gh.log and doctor
output. Synthetic fixtures/evidence remain. No live DB, credentials, real GitHub
or provider traffic, port 8399 or unattended GUI. This proves Bun/macOS and served
web/headless compatibility; it makes no new Deno/Linux native-runtime or visible
web/iOS preview UI claim. Fork-head objects unavailable in the bound repository
refuse; no arbitrary fork/host fallback is attempted. UI is delivered later.
