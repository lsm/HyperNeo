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
Do not set `HYPERNEO_TEST_DISABLE_SANDBOX=1` for this proof. Ordinary Linux CI sets
that flag and runs the explicitly labelled transport fixture with sandbox disabled;
its passing result is not OS-containment evidence. Production options stay strict.

The daemon supplies Neo's `GH_TOKEN` at runtime from its existing GitHub poller
credential: Keychain service `neokai.external-events.github`, account `default`,
then `GH_TOKEN ?? GITHUB_TOKEN` if the item is absent or unavailable. This matches
the poller's credential-store-first precedence. Test mode and non-macOS hosts use
only the environment; the synthetic SDK fixture never reads a real credential.
No token is stored in session config or printed in evidence. The human approved
this existing, potentially write-capable token in question
`79a6141f-f688-40b4-a403-ad52f9f3e30f`; a dedicated read-only token is deferred.
That later step changes only the runtime token source. Missing tokens leave gh
unauthenticated in an isolated empty `GH_CONFIG_DIR`, with no auth-file fallback.

The fixture supplies a synthetic daemon token and puts a local `gh` stub on PATH.
Actual SDK Bash must run `gh pr view`, and the stub checks the token privately and
returns PR number 8148 with `authenticatedByDaemon:true`. An absent/wrong token
returns a visible authentication error. No GitHub network request is made. A synthetic
`.zshenv` tries to replace the token; isolated `ZDOTDIR` must prevent that reinjection.
Focused tests also cover the existing store precedence, GH_TOKEN precedence,
GITHUB_TOKEN fallback, missing or failed runtime providers and disappearing checkout-inventory entries. Preserve the JSON
outside the worktree before cleanup. This proves runtime wiring, not the real token's
GitHub scopes or spontaneous model behavior.

After merge/rollout, record the laptop RPC commit readback via `hyperneo build`.
Neo then runs `gh pr view` itself from its sandboxed Bash and relays the actual tool
result. Do not read credentials or auth files in a verification shell. Keep this
live proof pending until Neo's result exists. Do not attempt a GitHub write-rejection
proof: the approved existing token may write. No GitHub settings change is needed.
