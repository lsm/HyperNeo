# Ledger polling page persistence (Build)

Use shared isolation setup in `../SKILL.md`. This slice adds a local ledger API
only; no public reader or acquisition call site uses it yet. Coalescing and
external-event wiring are later slices. There is no quota-saving claim.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-poll-facts-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-poll-facts.ts "$RUN"
```

The helper owns an actual isolated daemon, ephemeral port, synthetic database
and fake gh. It stops jobs, exercises the local ledger writer, restarts the
daemon and refuses a stale writer. Missing, failed and stale pages are unknown;
recovery and a matching-validator 304 restore known coverage without changing
the fact revision. A different opaque credential label cannot reuse that page.
Ten local reads make zero upstream calls. No credential value, auth file, real
GitHub, provider, GUI, live DB or port 8399 is used. Direct HTTP throws.

The public `neo.github.read` RPC remains compatible before/after restart; this
is not proof it reads the new page store. Retain `evidence/poll-facts.json` and
`evidence/requests.jsonl`. Resources close in finally.

Run the `neo-ledger-poll-facts`, `neo-ledger-merge-facts`,
`neo-coding-pr-ledger` and `github-ledger-polling-contracts` unit suites. The
historical polling baseline used normal, conditional and failure public-RPC
scenarios: initial/repeated scans made 18 repository GETs, failed scans
eight, recovery 18. Coverage/cutoffs and both destination histories survive.
Local persistence does not reduce those upstream calls. Run full repository
checks; after merge read owner RPC build ancestry without deploying/restarting.

Current public-RPC expectations are in `github-ledger-poll-wire.md`; the Wire
rung compares against this historical 18/18 baseline.
