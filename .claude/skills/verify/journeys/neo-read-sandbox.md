# Neo reads through approved tools and sandboxed Bash

Run from the worktree root. Read the shared SKILL.md setup first. No real DB,
credential/auth file or port 8399; no GUI interaction. This journey owns and stops
its actual daemon, SDK and loopback scripted model. Workers are unaffected.

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
records it as `is_error:true`. The temp-directory write must also succeed.
There is no command parser or unsandboxed retry. The strict SDK sandbox uses
`enableWeakerNetworkIsolation:true` for macOS trustd; network hosts are unrestricted.

In test mode the dedicated token store is not read. Actual `gh pr view` therefore
reports unauthenticated with an isolated empty GH_CONFIG_DIR; it must never use an
inherited GH_TOKEN/GITHUB_TOKEN or the human's gh login. Focused read-access tests
also cover injected synthetic tokens and explicit store failures. Preserve the JSON
outside the worktree before cleanup. The scripted model proves runtime wiring,
not spontaneous model behavior or a real token's GitHub scopes.

The human provisions a NEW fine-grained read-only GitHub token as a macOS generic
password: service `hyperneo.neo.github`, account `readonly`. Only the daemon's
runtime KeychainCredentialStore reads that item and supplies GH_TOKEN; it is never
stored in session config. Contents, pull requests, checks and issues are read-only;
metadata is implicit. No human token is reused. Do not fetch or print the item in
a verification shell. Missing-token mode is deliberately unauthenticated.

After merge/rollout, record the laptop RPC commit readback via `hyperneo build`.
Have Neo itself read synthetic code with Read/Grep/Bash, run `gh pr view`, then
attempt a harmless verification comment on this PR from its sandboxed Bash. Record
GitHub's permission rejection in the tool result. A successful write
fails the proof: report the incorrectly scoped token to the human. Do not change
GitHub settings. Keep live read/scope/deployment proof explicitly pending until the
new token is provisioned and those actual results exist.
