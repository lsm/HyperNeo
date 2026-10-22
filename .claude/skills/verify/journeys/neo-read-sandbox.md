# Neo reads through approved tools and sandboxed Bash

Run from the worktree root. Read the shared SKILL.md setup first. No real DB,
credential/auth file or port 8399; no GUI interaction. This journey owns and stops
its actual daemon, SDK and loopback scripted model. Workers are unaffected. The journey first attempts the ordinary sandbox-off RPC
for Neo and requires a visible refusal; it then writes a disabled sandbox through
generic session.update, together with Write/Edit approvals, coordinator mode and
weaker sandbox flags. The subsequent actual SDK query must retain the complete
approved read-only policy: no mutating native tools or agents, no excluded commands,
unknown weaker settings or unsandboxed retry. Explicit native Write/Edit attempts
return tool errors and leave synthetic bytes untouched.

```bash
RUN=$(mktemp -d /private/tmp/hn-neo-read-proof-XXXXXX)
mkdir -p "$RUN/home" "$RUN/evidence"
cd packages/daemon
env -i HOME="$RUN/home" PATH="$PATH" TERM=dumb NODE_ENV=test \
  HYPERNEO_USE_DEV_PROXY=0 VERIFY_EVIDENCE_DIR="$RUN/evidence" \
  node_modules/.bin/vitest run --config vitest.online.config.ts \
  tests/online/convo/neo-publication-sdk.test.ts
```

Inspect `neo-goal-cycle-sdk.json`: actual Read/Grep/Glob return synthetic code;
Bash reads it without a permission denial. Its writes to an exact per-repository
`<data>/worktrees/<owner>/<repo>/neo-read` leaf succeed. A worker-id sibling,
the data directory and Neo's cwd remain unwritable. Bash returns an explicit non-zero tool error with OS-denial stderr; the SDK
records it as `is_error:true`. The temp-directory write must also succeed. Neo must not advertise a
`HYPERNEO_HANDOFF_DIR` outside its writable roots; the Bash probe refuses a
non-empty value. Ordinary workers retain their handoff draft directory.
There is no command parser or unsandboxed retry. The strict SDK sandbox uses
`enableWeakerNetworkIsolation:true` for macOS trustd; network hosts are unrestricted.
Do not set `HYPERNEO_TEST_DISABLE_SANDBOX=1` for the OS-containment proof. Also run
the CI transport control from `packages/daemon`, using its own fresh HOME:

```bash
RUN=$(mktemp -d /private/tmp/hn-neo-read-transport-XXXXXX)
mkdir -p "$RUN/home" "$RUN/evidence"
env -i HOME="$RUN/home" PATH="$PATH" TERM=dumb NODE_ENV=test \
  HYPERNEO_USE_DEV_PROXY=0 HYPERNEO_TEST_DISABLE_SANDBOX=1 \
  VERIFY_EVIDENCE_DIR="$RUN/evidence" node_modules/.bin/vitest run \
  --config vitest.online.config.ts tests/online/convo/neo-publication-sdk.test.ts
```

The transport fixture must show a successful authenticated Bash PR read, without
claiming an OS-denied write. Native Write/Edit remain unavailable. Ordinary Linux
CI uses this mode; it is not OS-containment evidence. Production options stay strict.

The daemon supplies Neo's `GH_TOKEN` through the poller's existing composed
`credentialManager.getCredentialStore()` instance (`neokai.external-events.github`,
account `default`), then `GH_TOKEN ?? GITHUB_TOKEN`, then the daemon’s existing
GitHub CLI login via `gh auth token --hostname <GH_HOST or github.com>`. The CLI
lookup runs in the daemon’s ordinary GitHub lookup environment, before Neo’s
isolated `GH_CONFIG_DIR` is applied. Its stdout stays internal to the runtime
reader; it is never logged or saved. No auth file is parsed or copied. Existing Keychain/database fallback and pending
token replacement semantics are preserved. The store fixture uses only its
synthetic encrypted DB; no new store or direct Keychain access is introduced for Neo. CLI failure, timeout,
empty or oversized output leaves Neo visibly unauthenticated.
No token is stored in session config or printed in evidence. The human approved
this existing, potentially write-capable token in question
`79a6141f-f688-40b4-a403-ad52f9f3e30f`; a dedicated read-only token is deferred.
That later step changes only the runtime token source. When all approved sources
are unavailable, gh stays unauthenticated in Neo’s isolated empty `GH_CONFIG_DIR`;
Neo never receives the daemon’s auth files.

The fixture runs two source cases with a local `gh` stub. `store` saves a synthetic
token through `space.github.setToken` into the isolated encrypted DB, with a
conflicting environment token. `daemon-gh` has no stored or environment token;
parent-context `gh pr view` works through the fake CLI login. Its `gh auth token`
reply is available only in that fake daemon configuration context. The stub reads
no files and makes no network request. Both cases must deliver the same synthetic
token to actual SDK Bash so `gh pr view` returns PR 8148 with
`authenticatedByDaemon:true`. An absent/wrong token returns an authentication error.

Inspect both `neo-goal-cycle-sdk.json` (store) and
`neo-goal-cycle-sdk-daemon-gh.json` (CLI login). The latter must pass independently:
a passing store case alone did not prove the real laptop’s auth route in #8221.
A synthetic `.zshenv` tries to replace the token; isolated `ZDOTDIR` prevents that
reinjection. Focused runtime-token tests cover source precedence and CLI refusal,
unavailability, empty/oversized output and timeout. Preserve the JSON outside the
worktree before cleanup. These fixtures prove wiring for the simulated sources;
live source status and live GitHub success require separate readback.

After merge/rollout, record the laptop RPC commit readback via `hyperneo build`.
Neo then runs `gh pr view` itself from its sandboxed Bash and relays the actual tool
result. Do not read credentials or auth files in a verification shell. Keep this
live proof pending until Neo's result exists. Do not attempt a GitHub write-rejection
proof: the approved existing token may write. No GitHub settings change is needed.
