# Default deploy reader uses ledger ancestry facts

Use shared isolation in `../SKILL.md`. This slice moves the default deploy
reader's remaining comparison lookup onto normalized ledger facts. Identity is
canonical repository plus the exact ordered merge/build SHAs. Only a new table
is added; existing rows, JSON and history are not rewritten, backfilled or
deleted. There is no new RPC, permission, timer or UI/card behavior.

From the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-ancestry-ledger-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-deploy-ancestry.ts "$RUN"
```

The helper owns an actual isolated daemon and calls the runtime's default
`createNeoCodingReaders().readDeploys` local composition. This is not a new public
RPC deploy-check surface. A seeded positive fact is returned with zero compare
lookups while fake GitHub refuses. Before wiring, the same read returns no
containment and records one refused lookup. The same five cold demands make
five legacy lookups versus one ledger acquisition. Repository aliases coalesce;
repeat and app reopen make no compare lookup. Reopen is not an OS-process test.

Successful comparisons by immutable SHAs are reusable without a timer. Known
`behind`/`diverged` differs from unknown coverage: a failed or malformed response
never records a negative fact. Failure keeps prior status and successful time
but projects unknown; recovery restores coverage. The expected counts are
`{known:0, baseline:5, cold:1, repeat:0, reopen:0, known-negative:0, behind:1,
failed:2, partial:1, recovered:2}`. Keep `evidence/deploy-ancestry.json` and raw
`requests.jsonl`; merge lookups are seeded separately.

Run `neo-ancestry-ledger`, merge/deploy contracts and the GitHub reader suites,
plus `bun run check`, on the exact final head. Unit contracts cover GitHub versus
Enterprise, canonical host spelling, other repos, reversed SHAs and a late
positive unable to overwrite a newer negative. The synthetic old-schema DB
starts with only an older merge table: initialization adds ancestry storage and
preserves its rows/JSON byte-for-byte, including on repeated initialization.

Repeat the merge-reader and public PR-reader journeys plus the three consumer
scenarios. The fake gh refuses unknown commands, direct HTTP throws, and the
helper closes its daemon in finally. No provider, GUI, real GitHub, keys, auth
files, live DB or port 8399 is used. Save evidence outside the worktree. Counts
are synthetic logical gh calls, not HTTP counts, GraphQL cost or aggregate live
quota savings. Confirm automatic rollout with owner RPC; never restart/deploy
the human's daemon manually.
