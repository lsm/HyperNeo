# Recorded terminal PR events retry on the existing polling cycle

Use shared isolation in `../SKILL.md`:

```bash
RUN=$(mktemp -d /private/tmp/hn-terminal-replay-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-terminal-replay.ts "$RUN"
```

The helper owns an ephemeral daemon and calls the existing `/ws`
`space.github.pollOnce` RPC. It records a queued closed PR event and general plus
review-only subscribers. A synthetic trigger rejects one destination: the other
has one durable acceptance, both subscriptions remain, and restart/retry does
not duplicate the accepted job. After removing the trigger, the same poll cycle
accepts the remaining destination and removes only those subscriptions.

A later reopened state, a late-arriving older close, an unrelated review state,
unknown PRs, wildcard subscriptions and archived subscribers cover the selection
boundary. Canonical history stays byte-for-byte intact. Re-registering after
acceptance and repeating the poll cannot duplicate the jobs or receipts.
Card coverage alone is tested separately as insufficient acknowledgement.

Inspect `evidence/terminal-replay.json` and the captured log. Jobs are deferred
before restart so startup cannot consume them before the processor stops again.
This proves automatic routing on the real poll path, not worker consumption,
discovery of closures absent from local history, or card-side acceptance. No
new timer, RPC or schema; no model, GitHub, keys, auth files, live DB, GUI or
port 8399. All owned resources stop in finally.
