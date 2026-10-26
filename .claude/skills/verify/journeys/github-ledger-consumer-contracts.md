# GitHub consumer contracts and acquisition baseline

Read shared setup in `../SKILL.md`. This is the Pin rung for the single-source
ledger design. Acquisition expectations now include selective hydration. The helper
owns an actual isolated daemon and fake gh executable. No model or browser is
used. Run from the worktree root with a fresh absolute RUN for each scenario:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-ledger-consumers-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-consumers.ts merged "$RUN"
```

Repeat with `head` and `unreadable`, each with its own fresh RUN. The daemon
binds an ephemeral loopback port and refuses 8399. Its public `/ws`
`operation.invoke` door calls the real `neo.github.read` detail/list operation;
branch membership, deploy ancestry and ledger reconcile call their actual
production readers against the same fixture. The helper stops the job processor
so it never consumes a model turn. All gh commands are synthetic, unknown
commands refuse, no provider credentials are inherited, and direct fetch throws.
Nothing contacts real GitHub, auth files or Keychain. Only this test DB is written.
The fixture explicitly watches `synthetic/ledger` before exercising reconciliation;
it does not rely on repository discovery to subscribe the instance.

Observe `evidence/consumers.json` and `evidence/requests.jsonl`:

- `merged`: one PR agrees across public detail/list, branch, deploy and ledger.
  The first request set now produces seven logical gh calls: two REST discovery
  calls, work detail, query window, branch membership, merge commit and
  ancestry. The identical repeat produces two calls: work detail and query
  window. An idle repo reuses its ledger snapshot for thirty minutes.
  The public PR-reader slice removes the redundant ask
  reference call from the historical seven-call baseline. Cached branch and
  deployment facts explain the other zero repeats. These are not HTTP counts.
- `head`: the old-head approval disappears after the head changes; an unresolved
  thread remains a blocker. This pins exact-head verdict and blocker behavior
  through the public operation, not only the summary parser.
- `unreadable`: failed detail/list calls return a typed unreadable refusal,
  a successfully read empty list is known empty, and a partial ledger reconcile
  preserves the previous row. A completed issue keeps its closing PR and parent.
  Retained prior summary rows are not evidence that the latest read succeeded.
- The merged-only scenario now needs zero ledger GraphQL calls. Open-PR
  hydration responses report synthetic cost 7 per call. Cost of `gh pr view/list` is unknown here: do not
  equate calls with GraphQL points or claim a total quota saving.

The matching `github-ledger-consumer-contracts.test.ts` runs all three public
RPC scenarios in separate Bun processes with fresh data and checks the observed
results. Existing reader suites remain unchanged. Later build/wire slices must
expand coverage before moving a reader; update this baseline only when the
corresponding acquisition path changes. This test does not implement a collector,
field freshness, durable fact revisions, subscriptions or terminal cleanup.

The helper closes WebSocket and daemon in finally. Keep the evidence outside the
worktree before cleanup; stop only any process this helper owns after a failure.
Live deployment readback and real request/cost measurement remain separate from
this synthetic characterization. Do not synthesize a live GitHub event.

The acquisition extraction (#8192) keeps `pr-ledger.ts` exports compatible while
`pr-ledger-source.ts` owns acquisition. Repeat all three
scenarios before/after; that historical baseline was seven initial and three
repeated requests. The current reader expectation is seven and two. The source
extraction alone did not reduce reads or expand covered facts.
