# In-app previews: bound PR summaries (slice 10)

Run preview-pr-summary.test.ts with the existing preview/caller/contract suites
and Neo work-PR summary tests. The first run fails on the missing summary module.
All production reads reuse runGhJson and summarizeNeoWorkPr: existing credential
plumbing, 30-second timeout, one-MiB output cap and current-head review/check rules.
No new authentication client, readiness policy or background poll is introduced.

The native actual Bun proof uses synthetic SQLite and the skill's gh-stub.sh,
never GitHub. It records a stored PR link and repository binding, then invokes
artifact.reference.resolve as the paired human. Require full title/body, exact
40-character head SHA, bounded changed-file metadata and filesTruncated when the
reported total exceeds the returned list. Older-head approval must remain none;
a later explicit read after restart may show the new SHA without mutating the
earlier result. No artifact bytes/receipts or blob-store directory are created.

Require source/repository mismatch and unsupported host to make no gh call.
The first release accepts github.com through the existing read service; enterprise
hosts fail closed. Commands receive a bound repository and numeric PR argument,
never an arbitrary URL. Returned URL must match the canonical target; reject a
renamed/redirected or different repository result. Never follow authored links,
body URLs or changed-file paths. This proves request/response target binding, not
the internals of the installed gh client's HTTP redirect handling.

Refuse invalid/missing/oversized JSON, body beyond 65,536 UTF-16 units or 128 KiB,
more than 1,000 returned files, duplicate/unsafe paths, inconsistent totals and
non-immutable head values. Do not silently truncate a body or pretend a partial
file list is complete. Private/missing/service failures return unavailable without
stderr or credentials. Remove the stored source after a real stubbed lookup and
require the resolver's late authority check to withhold the response.

For native proof, use a fresh run/home with its bin ahead of the normal runtime:

```bash
RUN=$(mktemp -d /private/tmp/hn-pr-summary-native-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-pr-summary.ts "$RUN"
```

Build web; for the actual isolated RPC door use another fresh directory. Keep
launch/proof/stop in one owning shell with a stop.sh EXIT trap. Never use 8399:

```bash
RUN=$(mktemp -d /private/tmp/hn-pr-summary-daemon-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-pr-summary-rpc.ts "$RUN" seed
.claude/skills/verify/launch.sh 9386 "$RUN"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-pr-summary-rpc.ts "$RUN" read 9386
.claude/skills/verify/doctor.sh 9386 "$RUN"
.claude/skills/verify/stop.sh "$RUN"
.claude/skills/verify/launch.sh 9386 "$RUN"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-pr-summary-rpc.ts "$RUN" restart 9386
.claude/skills/verify/stop.sh "$RUN"
```

Retain pr-summary-evidence.json, RPC evidence, gh.log and doctor output; stop all
owned services. Run the actual MarkdownRenderer tests headlessly and build web.
Bodies remain untrusted strings; this is no proof of browser/HTML containment.
No unattended GUI, live DB or auth-file access occurs. PR file bytes at displayed
SHA wait for slice 11. Web/iOS panels wait for their client slices. Registered local
capture still uses anchored no-follow descriptors and immutable hashes; candidate
parsing never grants filesystem access. This is an iOS prerequisite API slice,
not completion of the full preview lane.
