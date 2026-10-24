# Public Review and Verify assignments

Read shared isolation setup in `../SKILL.md`, `coding-actor-checkouts.md` and
`coding-stage-preferences.md`. This proof starts the real isolated daemon twice
on ephemeral loopback ports, with a fresh synthetic DB/home and local Git origin.
Its `gh` stub accepts only PR reads from synthetic metadata and logs every call;
HTTP is refused. No model, provider, real GitHub, human app, credentials, browser
or reserved port is used.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-actor-assignments-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/coding-actor-assignments.ts "$RUN"
```

The actual `neo.coding.assign`/`neo.coding.result` operations are driven over
WebSocket RPC, with their normal registration/admission and real assignment/head
repositories. Only the external `work.start` harness boundary is replaced by a
synthetic harness using the real start schemas and production coding checkout
preparation. Its fake adapter names cannot launch native apps if that fixture
replacement fails. The fixture really fetches/pins the PR head, reads the complete
trusted role contract and observes clean Git status before acknowledging a start.
It does not execute model turns or exercise OS sandbox enforcement.

Observe `evidence/actor-assignments.json` and `gh.jsonl`:

- Configured bot assigns Review with zero reviewer starts even with an explicit
  human; Verify still starts independently and uses the repo verify skill and
  shared contract with the coding-only override.
- No-bot Review selects a different model and applies preferred harness/model/
  effort. Verify receives another ref, pinned checkout and full contract. The
  kickoff remains below the message limit and names the immutable acceptance ref.
- Repeating both assignments and restarting the daemon reuse recorded refs without
  duplicate starts. Each synthetic work slice retains one todo and its author.
- Explicit human Review starts no session; missing provenance refuses while an
  explicit provenance opt-out permits the default.
- A preflight-unavailable preferred model falls back to the qualifying default
  with an explanation. An acceptance-contract change refuses.
- A new PR head invalidates old assignment requests, requires new Review before
  Verify and assigns a fresh reviewer. Verify results accept the public `verify`
  stage while retaining historical `qa` storage; inconclusive never becomes pass.

The helper closes both daemon instances/sockets and releases every owned clone in
finally. The dirty source checkout stays at its original HEAD with its dirty file
unchanged. Synthetic source repositories and evidence remain for inspection.
Retain the evidence before removing the run directory. Unit suites additionally
cover identity reuse, concurrent calls, stale-start compensation, uncertain
delivery (no retry), closed PR refusal and human result validation.

Not verified: native harness/provider availability or app rendering, autonomous
model compliance with the role/verify skill, actual external bot approval, or the
existing merge/completion/deployment gates. This slice changes actor assignment,
not those gates; their separate journeys remain authoritative.
