# Historical GitHub reviews are not replayed to workers

Read shared setup in `../SKILL.md`. This helper owns an isolated daemon on an
ephemeral loopback port and a synthetic gh executable. It uses no model, browser,
real GitHub request, credential file, live database or port 8399.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-review-replay-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-review-replay.ts verify "$RUN"
```

The helper pauses the job processor, seeds only its own database, and calls the
public `/ws` `space.github.pollOnce` RPC three times. The fixture has a legacy
zero global cursor with a saved stage-5 continuation, a six-day-old review on a
merged PR, a previously delivered review, fresh reviews on an open PR, and both
active and archived native subscribers. Direct HTTP and unknown gh commands
fail. No model or external desktop session consumes the mailbox.

Observe `evidence/review-replay.json` and `evidence/requests.jsonl`:

- Historical review delivery is 0, fresh and subsequent review deliveries are
  each 1, previously delivered review remains 1, and archived deliveries are 0.
- Exactly three canonical events remain: the prior event and two fresh events.
  The obsolete review is rejected before storage. All three subscription rows,
  including the archived one, remain stored.
- A session-scope review baseline is persisted in the cursor. A legacy zero
  cursor starts at the same 24-hour initial lookback as session comment feeds;
  a nonzero committed cursor remains the lower bound. Resuming does not move
  this initial baseline forward with wall-clock time.

At failing reproduction commit `3facd727d1`, the identical helper's `before`
mode observes historical delivery 1 and archived delivery 2, with four canonical
events. Preserve that before artifact; `verify` must fail on that source.

The helper closes its WebSocket and daemon in finally. Keep the evidence outside
the worktree. This proves daemon acquisition and mailbox routing with synthetic
data; it does not measure live INSERT latency or model consumption.
