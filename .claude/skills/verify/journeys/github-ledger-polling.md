# Shared-repository polling contracts

Read shared setup in `../SKILL.md`. This journey originally pinned the producer
baseline before ledger acquisition. Current commands exercise the Wire contract;
see `github-ledger-poll-wire.md` for expected counts and retained before evidence.

Run each scenario from the worktree root with a fresh absolute RUN:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-ledger-polling-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-polling.ts normal "$RUN"
```

Repeat with `conditional` and `failure`, each in a fresh RUN. No model, browser,
credentials or real GitHub are used. Direct HTTP throws; fake gh only accepts
the synthetic API requests. The helper owns an isolated daemon on an ephemeral
loopback port, refuses 8399, stops its job processor and closes resources in
finally. Read-checkout sync remains enabled: a local bare Git origin and exact
synthetic URL rewrites in this run's HOME provide its repository and default ref.
No human Git configuration or repository is read or changed.

The actual public `/ws` `space.github.pollOnce` operation polls one synthetic
repository watched by two Spaces. Public `space.github.listWatchedRepos` replies
report each destination's cursor and errors. Inspect `evidence/polling-ledger.json`
and `evidence/requests.jsonl`:

- `normal`: each destination retains one approval with the exact PR head. A
  repeated HTTP 200 scan creates no duplicate source events.
- `conditional`: exit-1 HTTP 304 responses preserve both destinations' approvals
  and produce no duplicate source events.
- `failure`: HTTP 503 reports both failures without advancing either successful
  poll timestamp or cutoff, and preserves the approval. Recovery adds one new
  approval to each destination, retaining both original events.
- The baseline is 18 repository GETs in the initial cycle, including two reads
  of the identical PR review endpoint, one per destination. Repeats make 18
  GETs in both normal and conditional scenarios; the failed scan makes eight
  and recovery makes 18. `/user` requests are recorded separately. These are
  endpoint-call counts, not GraphQL cost or a live aggregate quota measurement.

The regression suite runs all three RPC scenarios plus the existing conditional
and large-response journey with read-checkout sync active. That older fixture
must supply repository/default-ref metadata as well as its response pages.

The Wire journey compares against that saved baseline and requires nine initial/
normal-repeat/conditional-repeat/recovery GETs and eight failed GETs.
Collector changes must retain independent destination histories, exact-head
payloads, repeat deduplication and failure cutoffs while reducing the duplicated
source requests. This proof observes persisted source history, not worker wakes,
delivery acknowledgements or terminal unsubscribe. Live deployment readback and
the eventual comparable API-read measurement remain separate; never force a
live poll or synthesize a live event to manufacture that evidence.
