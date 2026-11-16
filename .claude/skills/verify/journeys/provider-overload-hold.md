# An overloaded provider holds the turn instead of stopping the session

Use **In-process RPC proofs** in ../SKILL.md. Preflight ports 8000/8001.
Run with a fresh RUN/home:

```sh
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_USE_DEV_PROXY=1 \
  HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS=0 HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/provider-overload-hold.ts "$RUN"
```

The helper owns its daemon, local HTTP proxy and mock model, disables external
MCP entries and stores only the synthetic dev-proxy provider key in its fresh DB.

The proxy answers every turn request with `529 overloaded_error`. The real Claude
CLI retries an overloaded request itself (ten times, about four minutes) and then
reports an error result with `api_error_status: 529` instead of throwing. The
helper sets `CLAUDE_CODE_MAX_RETRIES=0` on the SDK subprocess it spawns, so that
result arrives at once; the daemon path it exercises is the same.

The daemon must not charge that result to the query failure episode. It holds
the turn in `rate_limit_cooldown` with `reason: 'overloaded'` and `retryAt`
5 minutes ahead. The helper asserts the hold, the retry time, that the episode is
not latched and that no session error was published. It then lets the proxy
answer and waits for the watchdog timer to resume the held prompt and finish it
with a successful result. The run takes about six minutes.
`evidence/observed.json` records the 529 count, process count, the hold, its
retry time, the episode and the time held.

A thrown 529 or 503 (when the CLI does not answer with a result) goes through
`provider_backoff` without charging and enters the same hold when its retries
run out; unit tests cover that path.

Before this behavior, the error result was charged, the session went idle with
the error, and the third charged turn latched the session as stopped ("Send a
message to recover").
