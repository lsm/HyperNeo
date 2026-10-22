# Neo reads through approved tools and sandboxed Bash

Run from the worktree root. Read the shared SKILL.md setup first. No real DB,
credential/auth file or port 8399; no GUI interaction. This journey owns and stops
its actual daemon, SDK and loopback scripted model. Workers are unaffected. The journey first attempts the ordinary sandbox-off RPC
for Neo and requires a visible refusal; it then writes a disabled sandbox through
generic session.update. The subsequent actual SDK query must still enforce the
mandatory sandbox, with no excluded commands or unsandboxed retry.

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
Do not set `HYPERNEO_TEST_DISABLE_SANDBOX=1` for this proof. Ordinary Linux CI sets
that flag and runs the explicitly labelled transport fixture with sandbox disabled;
its passing result is not OS-containment evidence. Production options stay strict.

In test mode the dedicated token store is not read. Actual `gh pr view` therefore
reports unauthenticated with an isolated empty GH_CONFIG_DIR; it must never use an
inherited GH_TOKEN/GITHUB_TOKEN or the human's gh login. A synthetic `.zshenv`
also attempts to re-export an owner token: the isolated ZDOTDIR must prevent that
reinjection. No real shell startup or auth file is read. Focused read-access tests
also cover injected synthetic tokens, locked stores and non-macOS hosts. Missing
or unavailable dedicated credentials leave gh unauthenticated, never using another
store or human token. Preserve the JSON
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
