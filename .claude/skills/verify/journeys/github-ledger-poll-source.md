# GitHub polling acquisition source extraction

Read shared setup in `../SKILL.md` and `github-ledger-polling.md`. This Extract
rung moves existing request selection, first-response bucket observation and
rate-header parsing into `lib/github/poll-source.ts`. The external-event
extension keeps its existing parser/type exports. It still owns credentials,
headers, request deadlines, slicing, cursors, normalization and destination state.
No ledger API, schema, scheduler, cache or shared-refresh behavior is introduced.

Run all three unchanged public-RPC scenarios before and after the extraction,
each in a fresh absolute RUN from the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-poll-source-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-polling.ts normal "$RUN"
```

The 18/18 counts below describe the historical Extract baseline. Current commands
run the Wire contract; expected counts are in `github-ledger-poll-wire.md`.
Repeat with `conditional` and `failure`. The helper owns an isolated daemon,
database, fake gh and local Git origin; it refuses direct HTTP and port 8399.
No model, GUI, real GitHub or credentials are used. Resources close in finally.

Compare `evidence/polling-ledger.json` and `evidence/requests.jsonl`:

- Each destination retains the exact-head approval; repeats and valid 304s do
  not duplicate source events. An exit-1 CLI 304 remains successful.
- Failed reads preserve both successful cutoffs/timestamps and retained history.
  Recovery adds one new approval to each destination.
- Request counts are unchanged: 18 repository GETs initially and on successful
  repeats/recovery; eight on the failed scan. The identical review endpoint is
  still read twice. `/user` calls remain separately recorded.

Run the unchanged compatibility suites from `packages/daemon`:

```bash
bunx vitest run tests/unit/1-core/operations/github-ledger-polling-contracts.test.ts \
  tests/unit/1-core/operations/github-ledger-consumer-contracts.test.ts \
  tests/unit/2-handlers/github
```

These also cover failed credential-store reads refusing fallback, injected fetch
selection, response limits, rate buckets/Retry-After, page resumes and check/review
cutoffs. This extraction makes no API-read or quota-saving claim. Collector
persistence/coalescing and final comparable deployed measurement remain later
slices. After merge, verify automatic build ancestry through owner RPC; never
force live polling, change real credentials/configuration or inject a live event.
