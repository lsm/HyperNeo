# Ledger merge-fact persistence (Build)

Read shared setup in `../SKILL.md`. This slice builds only the latest PR state
and merge commit required by the first deploy reader. No consumer is wired yet;
it makes no API-quota reduction or new public-feature claim. The previous
consumer-contract journey still supplies the seven initial / three repeated
upstream-request baseline.

From the worktree root, use a fresh absolute run directory:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-merge-facts-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-merge-facts.ts "$RUN"
```

This helper owns an actual daemon on an ephemeral loopback port, stops its job
processor and uses the shared fake gh executable. It writes only the synthetic
DB through the new local ledger writer. It exercises the local read API with
missing, fresh, failed, recovered and stale coverage, closes and restarts the
actual daemon, and verifies the revision-bound writer refuses an old result.
Ten local reads make zero upstream calls. Prior successful merge bytes remain
stored after failure. A successful identical refresh retains the fact revision.

The public `/ws` `neo.github.read` operation is also exercised before/after
restart against the fake gh response. Its behavior remains unchanged, because
reader wiring and collector acquisition are separate future slices. This is
local persistence/API proof in the running daemon, not proof that public readers
use the ledger or that GitHub quota has fallen. No GUI, model, real GitHub,
credential/auth files, live DB/config or port 8399 is used. Direct HTTP throws.

Retain `evidence/merge-facts.json` and `evidence/requests.jsonl`. Run the focused
`neo-ledger-merge-facts` and existing `neo-coding-pr-ledger` tests, plus all three
`github-ledger-consumers.ts` scenarios to confirm summary compatibility and the
unchanged request baseline. The helper closes its WebSocket and daemon in
finally. There is no transition-history table, collector, subscription or new
public operation in this slice; those are not verified here.
