# Coding preparation owns its Git storage

Read shared SKILL.md first. Run from the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-worker-clone-proof-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/worker-standalone-clone.ts "$RUN"
```

The helper owns an isolated daemon on an ephemeral non-8399 port. Its actual
WebSocket `operation.invoke` / `work.start` invokes the loaded coding pack's
preparation with a synthetic local remote, prerequisite and dirty source checkout.
The synthetic Claude CLI records the resulting cwd and transcript; `open`, `script`
and `gh` are stubbed, so no GUI or external services are used. No credential files
are read, and no model/provider is needed.

The returned prepared directory must contain its own `.git` directory, start at
the freshly fetched remote commit, pin `origin/<target>` to that same commit
without inherited source refs or tags (including `git switch dev`), keep the original upstream and contain no Git
object hardlinks to the source. Focused Git tests also start from a source that
borrows objects: `--dissociate` must leave no alternates dependency in the clone. A real edit/add/commit in that directory must
use the source repo-local identity/signing policy and produce a commit absent
from the source object store, preserving source HEAD and
dirty bytes. A synthetic CLI refusal after preparation must release only its new
clone, keeping the confirmed worker clone.

The B1 handoff case separately confirms a preparation transcript, injects native
import failure and writes synthetic human bytes into that new execution clone.
Those bytes and its HEAD remain; the refusal reports the retained session ID and
directory for recovery. This differs from a CLI preparation that never confirms
any session: only the latter releases its unused private clone.

The tracked Git LFS case explicitly refuses preparation before CLI launch; it
does not materialize LFS objects, download them or copy their cache/credentials.
A subsequent start with an unavailable remote must visibly refuse before
launching work, without falling back to stale HEAD. `evidence/observed.json` retains
all RPC replies and the independent-storage observations. Focused daemon tests also
cover project attribution, existing-destination preservation, partial failure cleanup with a vanished destination
and idempotent explicit resource release. Only selected local user/commit/signing-program
configuration is copied; credential helpers, HTTP headers and key material are not.
Signing-key access or a real signed commit is not tested.

This slice proves checkout preparation through the actual daemon and Git, with a
synthetic CLI peer. It does not prove OS sandbox enforcement, native path denials,
real worker model behavior or Desktop rendering. Those belong to later slices of
#8161. The helper stops its daemon in finally; preserve evidence outside the
implementation worktree, then remove only this synthetic run directory.

## Work locations with sandbox off (#9090)

Run the helper through the shared proof-run.sh wrapper with VERIFY_CLAUDE set
explicitly to the installed Claude CLI. The synthetic Desktop preparation records
the generated inline environment-only settings and appended location brief.
The installed CLI loads those settings against a loopback scripted model and
runs real Git to create a worktree under HYPERNEO_WORKTREES. The handoff now
persists just the location environment in the worker's local project settings,
preserving other settings; the Desktop opener receives only --desktop/--resume.
The native adoption leg starts one real Claude conversation with the brief,
then resumes it in a new process with no location settings or prompt flags.
The resumed request must still contain the recorded brief and its real Bash
must create a second worktree using the persisted environment. Before the fix,
this leg fails because HYPERNEO_WORKTREES is missing, even though the recorded
brief survives. Inspect adopted-native.json and adopted-native-*.log.

The clone has no sandbox marker. A synthetic legacy worktree sentinel remains
unchanged; legacy directories are accepted, not migrated. work-locations-native.log
and observed.json retain the result. The Python helper uses a synthetic HOME,
a loopback-only key helper and its own ephemeral HTTP server, closed in finally.
No Desktop UI, actual app adoption, real provider or credential is exercised.
SDK/Codex/Copilot launch-envelope regressions cover the other adapters; this
native proof specifically exercises Claude's shell environment, not those CLIs.

The focused SDK prompt tests preserve its default prompt when the preset is off
and there is no other host-authored instruction; location environment hints still
arrive. With an existing prompt or the preset, the brief is appended. Scratch is
only described as TMPDIR when sandboxing is on; unsandboxed temp behavior stays
unchanged. Include the existing-turn Codex policy tests when rebasing this change
so policy refresh remains enforced before queueing an input.

SDK system/user input de-duplication has its own real-SDK journey in
worker-work-locations-sdk.md. The native Codex request-field contract is checked
separately by codex-work-locations-schema.md; schema acceptance is not a native
Codex shell or Desktop UI proof.

The unsupported-settings leg commits deliberately invalid local settings into the
synthetic remote, then calls work.start again. It must return preparation_failed
before a child starts, release the unlaunched private clone and preserve source
bytes. Unit cases also cover symlinked settings, a symlinked .claude directory and
a regular file in its place. These layouts receive a typed pre-launch refusal;
the proof does not claim they can be adopted. A confirmed CLI-created worktree is
retained with a typed not_delivered if later settings/import work fails.
