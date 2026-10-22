# Ledger-owned bounded GitHub queries

Read shared setup in `../SKILL.md`. From the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-query-ledger-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-query.ts "$RUN"
```

The helper owns an ephemeral loopback daemon, fresh synthetic DB and refusing
fake gh. It makes actual public `neo.github.read` list RPCs. No model, GUI,
provider keys, auth files, real GitHub or port 8399; direct HTTP throws.

Five concurrent identical explicit-window queries must return the same sorted,
truncated list and make one query lookup. Before wiring they make five. Later
settled queries must each make a fresh acquisition: changed titles appear,
transport failure and malformed data return typed unreadable, and a successful
empty response is known empty. Failed reads retain prior JSON and successful
observation time. Reopening the isolated app retains those facts; the next read
refreshes and recovers. This is app reopen, not an OS-process restart proof.

Pass: `evidence/query-ledger.json` has `verified:true`, five successful fanout
replies with item numbers `[3,2]`, `truncated:true`, the exact requested window,
and counts `{initial:1,changed:1,failed:1,malformed:1,empty:1}`. Raw fake lookup
arguments are retained in `evidence/requests.jsonl`. The old default must fail
on five-versus-one acquisition; a timeout is inconclusive.

Run `neo-query-ledger` and `neo-github-query` plus the existing branch, work,
merge-fact and consumer-contract suites from `packages/daemon`. Coverage tests
must distinguish repository, kind, state, date field, interval and limit; a late
response must preserve newer committed facts. Local reads distinguish missing,
stale and failed coverage. Truncated collections never claim repository-wide
completeness. A busy write retries persistence without repeating acquisition.

The original three consumer RPC scenarios retain their seven initial / three
repeated lookup baseline: this slice preserves fresh sequential human queries.
Five concurrent query lookups become one; these are logical gh invocations,
not exact HTTP requests or GraphQL cost. Aggregate deployed quota reduction
remains unverified until the whole reader lane is measured.

The helper closes socket and daemon in finally. Retain evidence outside the
worktree. After merge, confirm automatic deployment through owner RPC, verify
ancestry and remove the worktree. Never force a live poll or deploy/restart.


For relative-window regressions, repeat the helper in fresh runs with a third
argument `relative` and `growth`. `relative` sends five identical `withinHours:3`
requests 20 ms apart while fake gh is held 300 ms. They must make one lookup and
all report the same actual search, lower bound and observation upper bound.
`growth` makes four settled relative queries: four fresh lookups, one stored
semantic query row. Before the fix these modes fail five-versus-one and
four-versus-one respectively. Each mode saves `evidence/query-ledger.json`.

Rolling collection identity includes the duration, not a new millisecond lower
bound per invocation. Its stored coverage retains the actual interval selected
by the winning acquisition. Different durations and explicit fixed windows stay
separate. Failure retains the prior successful interval, and late responses may
not replace newer intervals or values. No rows or stored history are pruned;
this removes per-invocation rolling-query growth, not the cardinality of distinct
explicit query subjects. Any future retention/deletion policy needs separate
authorization under the standing data-preservation rule.
