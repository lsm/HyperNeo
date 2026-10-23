# External-event polling reads ledger pages

Use shared isolation in `../SKILL.md`. This Wire rung routes the existing GET
source through the ledger HTTP collector. One acquisition cycle spans the
watched destinations; a later cycle has a new ID. Credentials, representation,
exact URL and validator retain their coverage boundaries. No new RPC, permission,
scheduler or migration is introduced. Destination cursors/delivery stay separate.

Run normal, conditional and failure with a fresh absolute RUN for each:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-poll-wire-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-polling.ts normal "$RUN"
```

The helper owns an actual daemon, public `/ws` RPC, fake gh and local Git origin;
it refuses external HTTP and port 8399. Coding is disabled in Neo's pack settings
while both Spaces still receive exact-head approvals. No model, GUI, real keys,
auth files, live DB or real GitHub are used. Resources close in finally.

Inspect `evidence/polling-ledger.json` and actual `requests.jsonl`. Against the
same pre-Wire fixture (18 initial/18 repeat, eight failure/18 recovery GETs),
expect nine initial/normal-repeat/recovery GETs and ten conditional-repeat GETs.
The identical review endpoint is acquired once per initial cycle. Failed pages
remain unknown and use eight GETs; neither destination's successful timestamp or
cutoff advances. Recovery retains both earlier events and adds one approval each.
A changed `since` URL's 304 has no matching stored page: it stays unknown and is
not falsely shared, accounting for the tenth conditional request. Stored metadata
contains only allowed rate/validator headers. These are synthetic REST counts,
not GraphQL cost, deployed quota measurements or proof of downstream acceptance.

Run `github-ledger-polling-contracts`, the GitHub handler suites and page
fact/coalescing/HTTP contracts, plus full checks. Source contracts also prove new
cycle heads refresh, credential/representation separation and failed credential
reads refusing before a covered page. Fairness contracts run with the collector
enabled, including 201 PRs beside small repos and restart/page-resume coverage.
Retain comparable before/after evidence.
After merge, confirm the automatic rollout with owner RPC; never deploy/restart
or force live polling. Durable outbox and remaining reader moves are later slices.
