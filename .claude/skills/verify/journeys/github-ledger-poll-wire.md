# External-event polling reads ledger pages

Use shared isolation in `../SKILL.md`. This Wire rung routes the existing GET
source through the ledger HTTP collector. One acquisition cycle spans the
watched destinations; a later cycle has a new ID. Credentials, representation,
exact URL and validator retain their coverage boundaries. No new RPC, permission,
scheduler or row-rewriting migration is introduced. Destination cursors/delivery stay separate.

Run normal, conditional, failure, retention, conditional-reseed and slow-conditional with a fresh
absolute RUN for each:

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
expect nine initial/normal-repeat/conditional-repeat/recovery GETs.
The identical review endpoint is acquired once per initial cycle. Failed pages
remain unknown and use eight GETs; neither destination's successful timestamp or
cutoff advances. Recovery retains both earlier events and adds one approval each.
Cold/expired pages and changed `since` URLs fetch once without If-None-Match.
Only a known ledger body matching the validator permits a conditional GET;
a valid 304 then refreshes its coverage. Unvalidated 304s remain unknown. Stored metadata
contains only allowed rate/validator headers. These are synthetic REST counts,
not GraphQL cost, deployed quota measurements or proof of downstream acceptance.

Run `github-ledger-polling-contracts`, the GitHub handler suites and page
fact/coalescing/HTTP contracts, plus full checks. Source contracts also prove new
cycle heads refresh, credential/representation separation and failed credential
reads refusing before a covered page. Fairness contracts run with the collector
enabled, including 201 PRs beside small repos and restart/page-resume coverage.
`retention` advances the watched windows and ages only the synthetic raw pages
created in that run. Each cycle retains nine current pages plus a protected
pre-existing unscoped row; that row's raw JSON/revisions and a normalized-fact
row remain byte-equal, and both destinations keep their original approvals.

Only new `external-event-page:v1:` cache subjects expire after the longer of
15 minutes or two configured polling intervals of inactivity, checked on
acquisition with the additive timestamp index. No new timer is introduced. Expiry never targets
existing unscoped rows, normalized facts or source history. Unit contracts also
advance window/page/credential identities through 30 minutes, then idle/recover.
`conditional-reseed` starts with destination ETags but no ledger body, expires
only new synthetic raw-cache pages, then repeats unchanged. Each cycle makes nine
GETs, retains 2/2/2 source events and known bodies; only the warm repeat sends
conditional headers. The failing pre-fix contract made 12/16/16 GETs.
`slow-conditional` sets a 30-minute interval through settings RPC: the unchanged
review payload is a zero-byte 304 after one interval, then re-seeds after 61
minutes of synthetic inactivity. Keep payload-byte counters and history checks.
Retain comparable before/after evidence.
After merge, confirm the automatic rollout with owner RPC; never deploy/restart
or force live polling. Durable outbox and remaining reader moves are later slices.
