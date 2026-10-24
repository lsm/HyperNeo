# Recorded terminal PR events retry on the existing polling cycle

Use shared isolation in `../SKILL.md`:

```bash
RUN=$(mktemp -d /private/tmp/hn-terminal-replay-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-terminal-replay.ts "$RUN"
```

The helper owns an ephemeral daemon, invokes the registered subscribe operation
as synthetic MCP sessions and calls the existing `/ws` `space.github.pollOnce`
RPC. Its HTTP fixture answers only synthetic repository reads; gh refuses every
invocation. A fake GitHub token is set through the existing RPC into this run's
test DB, with no provider credential in the environment. Each subscribe
must store a durable row and return ordinary success. It records a queued closed
PR event and general plus review-only subscribers. A trigger rejects one destination: the other
has one durable acceptance, both subscriptions remain, and restart/retry does
not duplicate the accepted job. After removing the trigger, the same poll cycle
accepts the remaining destination and removes only those subscriptions.

A later reopened state, a late-arriving older close, an unrelated review state,
unknown PRs, wildcard subscriptions and archived subscribers cover the selection
boundary. Canonical history stays byte-for-byte intact. Re-registering after
acceptance and repeating the poll cannot duplicate the jobs or receipts.
Explicit subscription persistence and final delivery are required regardless of
card coverage; matching alone supplies no acknowledgement or shortcut.

Inspect `evidence/terminal-replay.json` and the captured log. Jobs are deferred
before restart so startup cannot consume them before the processor stops again.
This proves automatic routing on the real poll path, not worker consumption,
discovery of closures absent from local history. No
new timer, RPC or schema; no model, real GitHub, real keys, auth files, live DB, GUI or
port 8399. All owned resources stop in finally.
