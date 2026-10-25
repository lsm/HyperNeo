# Prepared worker OS write enforcement

Read the shared native-worker isolation setup in `../SKILL.md` first.

```bash
RUN=$(mktemp -d /private/tmp/hn-sb-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  VERIFY_CLAUDE="$(command -v claude)" VERIFY_CODEX="$(command -v codex)" \
  bun .claude/skills/verify/worker-sandbox.ts "$RUN"
```

The helper owns an isolated daemon on an ephemeral non-8399 port and synthetic
Git repositories. Actual `work.start` RPC prepares the Claude clone and installs
its policy. Desktop registration uses a synthetic peer, never the human's GUI.
The installed Claude CLI loads that actual file through `--settings <path>` and
`--setting-sources local`, without injecting worker temp/cache variables into its
environment. Merely enabling the local source leaves protected env keys unapplied;
production creation, Desktop handoff and headless resume must pass the file too.
Codex uses the production desktop adapter with a synthetic bootstrap/handoff peer;
the real Codex CLI runs its generated thread configuration. This proves real OS
shell denial with adapter-generated policy, not native Desktop IPC or UI persistence.

Observe `evidence/{claude,codex}-observed.json`: both inside and private temp writes
succeed, outside writes fail. The corresponding stdout JSONL must contain the
shell's OS denial and nonzero outside status. Temp paths must stay inside each
worker's private root, including Claude's per-uid child directory. Long paths
cause Claude to fall back to shared `/tmp/claude-<uid>` and must fail this proof.
`codex-launch.json` and `codex-turn.json` retain both startup and opening policies.
The same run invokes `work.start` for the HyperNeo adapter and runs a real SDK
Bash turn. `sdk-observed.json` and `sdk-options.json` prove its private clone is
sandboxed too; `sdk-requests.json` retains the actual OS-denial tool result. The
helper stores only a synthetic provider key through RPC in its disposable DB,
disables external registry MCP servers, and routes SDK child traffic explicitly
to its own loopback model. No policy/env injection occurs in the SDK transport
wrapper. The daemon and model process close in finally; no fixed mock port is used.
All three routes also curl the synthetic server through the sandbox's configured
HTTP proxy. This proves HTTP network access, not real GitHub push/authentication.
Claude allows HTTP(S) hosts explicitly but grants no SSH-agent/Unix sockets; HTTPS
repository-token remotes are the supported path. SSH push is not verified.

Focused tests remove runtime roots before resuming a Claude worker or building SDK options; those paths must recreate
their own private dirs. Creating a sibling must preserve existing env/sandbox
configuration and must never prepare that sibling's released or unusable runtime.
Codex sends re-ensure only clones carrying the prepared-worker marker.

Commit `ab59e77f7d` contains the failing reproduction before enforcement: real
Claude writes the synthetic outside file. The regression helper exits nonzero.

Read denial, credential/environment isolation, arbitrary MCP/native-tool containment
and Desktop UI behavior are not proven here. Codex `workspaceWrite` exposes no
per-path read deny; secret-read isolation is tracked separately in #8630.
Copy evidence to a persistent location before deleting the synthetic run/worktree.

## Policy self-protection and report publication

The Bash probes also attempt to unlink `.git/hyperneo-native-writes.json`,
`.git/hyperneo-worker-sandbox` and `.claude/settings.local.json`. Both Claude
routes must report OS denials, preserve the gate markers and retain equivalent
policy JSON. The SDK settings manager may reformat JSON before the model runs;
formatting is not a policy change. The probe waits for the completed tool result
before checking preservation. Codex's sandbox policy is persisted in its thread,
not gated on the runtime-recreation marker.

The SDK Bash turn writes `sandbox-report.txt` in its actual
`HYPERNEO_HANDOFF_DIR`; the next scripted SDK MCP call invokes `handoff.publish`.
`handoff-published.json` must contain a real `published` reference for the synthetic
report. This proves the exported draft path matches the daemon reader and is
writable without granting the surrounding data directory.

Finally, the real isolated `session.archive` RPC must remove the SDK worker's
private temp/cache dirs and retain its clone. `runtime-cleanup.json` records that
result. Focused adapter tests verify the same release for both Desktop archives;
SDK lifecycle tests cover archive and delete, including uncached sessions.

Failing reproductions for review run 9434 were committed first in `04bebfb404`:
real Bash deleted its policy, report env pointed at the wrong directory, and
archive/delete retained runtime roots. No production clone-placement change is
part of this fix; the policy always takes its root from the prepared directory.

## Runtime portability (review 9464)

`worker-sandbox.test.ts` models Windows `process.platform`, absent `getuid`,
system temp variables and synthesized NTFS mode bits. It must prepare usable
worker temp/cache paths under the system temp root without applying POSIX mode
checks; the POSIX counterpart must still reject shared mode bits. These are
modeled API-shape tests, not a native Windows sandbox proof. Native Windows and
Linux worker OS enforcement are not verified on this macOS machine.

Darwin deliberately keeps the short `/tmp` base: the real CLI journey rejects
Claude's shared-temp fallback when a long path exceeds its socket limit. Other
platforms use `os.tmpdir()`. The SDK adapter fixture owns a dedicated parent with
its prepared clone below it. A synthetic unreadable directory alongside that
parent reproduces the shared-temp sibling-scan EACCES before the fixture fix,
and must not affect the corrected prepared start. All owned permissions are
restored in finally. Regressions were committed first in `311804768a`.

Per-worker policy replacements are atomic. No cross-worker filesystem transaction
is claimed for the pre-existing native-permission sibling refresh; try/precompute
cannot provide crash-atomicity across several file renames. Existing workers keep
their own OS sandbox roots when those native permissions refresh.

## Legacy and damaged policies (review 9453)

Run the same command above with `VERIFY_LEGACY_POLICY=1` added to the `env -i`
arguments. The helper replaces the first synthetic prepared worker's settings
with the slice-2 permissions-only shape, invokes the actual `work.send` RPC resume
path, then runs the installed CLI against that resulting file. Outside writes
and policy deletion must be denied and private temp/cache writes must succeed.
No env/sandbox values are injected into the native CLI environment by the proof.

Own-session resume repairs missing env/sandbox defaults atomically. A missing or
malformed sibling settings file falls back to the full computed policy, without
provisioning that sibling's runtime; complete existing env/sandbox values remain
unchanged. Focused regressions for legacy, missing and corrupt own settings and
missing/corrupt sibling settings were committed first in `05e843275e`; all five
fail before the fix. The baseline real CLI also writes outside its synthetic
clone after the permissions-only resume, proving the pre-upgrade escape.

## Sibling runtime independence (review 9444)

The actual daemon proof releases the first worker's synthetic runtime, starts a
sibling through `work.start`, and requires the released root to stay absent. It
then puts an unusable regular file at that same owned runtime path; another
sibling start must still succeed. `sibling-runtime.json` records both results
and preservation of the original worker's env/sandbox. Native file permission
denies still refresh to include the new siblings. Unit regressions were committed
first in `c8ed6ebffe` and fail on the reviewed head.

Successful archive/delete runtime release is verified in the stacked lifecycle
follow-up, not in #8632. Failure cleanup and own-session runtime recreation remain
part of this core journey. The final stacked PR closes #8627 after both merge.

## Stacked lifecycle follow-up

The lifecycle branch adds successful temp/cache release to Desktop archives and
SDK archive/delete. Its regression tests and actual RPC archive proof are committed
before the fix. In this branch `runtime-cleanup.json` also requires a later actual
SDK `work.start` sibling to leave the archived worker's runtime absent, preserving
the core fix for review 9444. The later synthetic sibling is archived through RPC
as well. Existing worker clones are retained; no placement logic changes here.

## Locked runtime cleanup

The real SDK Bash probe also creates a nonempty mode-000 directory in its own
TMPDIR before archiving. `runtime-cleanup.json` must report
`lockedNonemptyDirectoryReleased: true`, both roots absent, and the clone retained.
On archive failure, `archive-error.json` records the RPC error, persisted status
and whether the runtime remains; the helper restores the synthetic permission
so the failed fixture remains recoverable. The failing reproduction is committed
first in `41be9aa31f`.

Release restores directory owner permissions before removal, without following
symlinks, and retries transient removal errors. Focused POSIX tests cover nested
locked directories and an outside symlink target whose permissions must stay
unchanged. Failure-injection tests require SDK archive/delete and both Desktop
archives to preserve their unarchived state when release still fails. Desktop
retries must also release leftovers from previously archived sessions. The SDK
stops its agent, releases its runtime, marks the archived barrier, then cancels
durable deliveries; it must retain the barrier before delivery teardown.

## Immutable runtime flags and archived SDK retries (review 9514)

On macOS the SDK Bash probe also sets user-immutable flags on a nonempty private
temp directory and its file. It must report a zero flag-setting status, then the
actual archive RPC must succeed with `immutableRuntimeReleased: true` in
`runtime-cleanup.json`. Darwin release clears user immutable/append-only flags
when they block directory permission repair or removal. Its system `chflags`
invocations never follow symlinks; the focused regression leaves a symlink target
outside the runtime immutable and intact. Unrecoverable cleanup errors still leave
an unarchived session retryable. Removal retries for busy handles apply on Windows;
POSIX flag recovery does not wait through recursive ENOTEMPTY retries.

The helper next seeds synthetic runtime leftovers for that archived SDK worker
and evicts its already stopped cached session, modeling a retry after restart.
Actual `neo.session.archive` must answer `archived: false` and remove both roots;
`archive-retry.json` records that result. Admission refusals must leave the roots
intact. `VERIFY_IMMUTABLE_RUNTIME=0` disables only the macOS flag step when isolating
this retry regression; the normal run proves both together. Test-first commit
`16bb6305c9` reproduces both failures, including real SDK Bash and RPC evidence.

## Concurrent runtime removal (review 9523)

The main helper first runs `worker-sandbox-removal.ts` against real synthetic
runtime directories. Six waves race production release with an independent
recursive removal of the private temp tree. `concurrent-runtime-removal.json`
must show both actors succeeding, both roots absent, and the clone retained.
It can also run standalone:

```bash
bun .claude/skills/verify/worker-sandbox-removal.ts "$RUN"
```

This is a filesystem concurrency proof; a concurrent archive/delete RPC
race was not reproduced. The rest of the main journey still proves actual
archive and archive-retry RPC results with the real worker policies.

Deterministic filesystem regressions remove the whole runtime or one child
immediately before chmod/readdir, plus removal before macOS flag recovery. A
removed child must not prevent release of a surviving locked sibling. Missing
paths count as already removed throughout traversal and flag recovery; other
errors still propagate. Test-first commit `8fbb27f84b` contains the five failing
regressions and the unmocked filesystem proof (six ENOENT failures before the fix).
