# Default deploy reader uses ledger merge facts

Use shared isolation in `../SKILL.md`. This slice moves only the default deploy
reader's PR merge lookup onto the existing merge-fact repository. Ancestry now
has its own `github-ledger-deploy-ancestry.md` journey; this helper measures only
merge acquisitions. The merge slice adds no schema, public operation, permission,
timer or UI behavior.
This is proof of the existing local reader composition in a running daemon;
it does not claim a new card or public RPC deploy-check surface.

From the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-deploy-ledger-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-deploy-merge.ts "$RUN"
```

The helper owns an actual isolated daemon, stops its job processor and invokes
the same `createNeoCodingReaders().readDeploys` composition used by the runtime.
A fresh synthetic ledger merge is returned even while fake GitHub refuses that
read, with zero upstream merge lookups. Before wiring, this returns null and
records one refused lookup. Five missing requests through two repository aliases
share one acquisition; the same five cold demands through the retained legacy
reader make five merge lookups. Repeat and app-reopen reads reuse persisted fresh coverage
with no merge lookup. Reopen means app cleanup/open, not a new OS process.

Age only the fixture's merge observation. A failed refresh returns no merge,
preserves prior JSON and successful observation time, and marks coverage failed.
A malformed response remains partial; recovery restores known coverage. A closed
unmerged PR is known with no merge commit, so a repeat makes no extra lookup.
The expected merge counts are `{known:0, missing:1, repeat:0, reopen:0, failed:1,
partial:1, recovered:1, closed:1}`. Inspect `evidence/deploy-merge.json` and
`requests.jsonl`; keep ancestry calls separate from merge acquisitions.

Run `neo-deploy-ledger`, `neo-ledger-merge-facts`, `neo-daemon-ticks` and existing
consumer contracts, plus `bun run check`, on the exact final head. Repeat the
merge-fact persistence journey and the public PR-reader journey for compatibility.
The existing revision check must still refuse late writers. Only repo, PR number,
lookup count and success are logged; no credential values or headers are stored.

The fake gh refuses unknown commands, direct HTTP throws, and all data lives in
the fresh synthetic HOME/data directory. No model, GUI, real GitHub, keys, auth
files, live DB or port 8399 is used. The helper closes its daemon in finally.
Keep evidence outside the worktree. These are synthetic logical gh counts, not
HTTP request counts, GraphQL cost or aggregate deployed quota savings. After
merge, confirm automatic rollout by owner RPC; never manually restart/deploy.
