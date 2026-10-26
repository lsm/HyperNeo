# Read-only public GitHub cost measurement

Read shared isolation and resource checks in `../SKILL.md`. This opt-in journey
measures real GitHub quota through isolated daemons, as requested for ledger
budget changes. It uses only public PR metadata from `lsm/HyperNeo`.

```bash
TMPDIR=/absolute/writable/temp bun .claude/skills/verify/coding-ledger-live-cost.ts \
  /absolute/fresh/evidence BASELINE_REF
```

`BASELINE_REF` must contain the original full-repository ledger reader. The
helper saves that source temporarily beside the current reader and removes it
in finally. Run no other heavy job or repository check concurrently.

Unlike synthetic journeys, the parent forwards strictly read-only gh requests
using the already configured CLI. Never inspect its credential files. Only the
parent invokes the real CLI; each daemon inherits a fresh HOME/data/TMPDIR and
no credentials or provider keys. A loopback CLI bridge admits only public PR
list queries and GraphQL reads for the specified repository. It flushes responses
before exiting so large REST pages cannot be truncated by the relay.

The baseline makes one full query. The fixed daemon runs twelve five-minute
timestamps without waiting an hour. Each cycle must produce complete ledger
coverage through the real reconciliation entry point. `cost.json` records actual
GitHub-reported query costs and remaining quota; baseline hourly cost is an
estimate of twelve identical sweeps, not an elapsed-hour observation. Other
clients can change remaining quota concurrently; sum query costs instead of
subtracting remaining values. Never report a failed run as a measurement pass.

Both daemons stop in finally. Synthetic databases and homes are immediately
removed; retain only cost/request summaries and logs outside the disposable run.
The live daemon is never queried, stopped or restarted by this helper.
