# A held usage-limit result resumes when its retry fires

Use **In-process RPC proofs** in ../SKILL.md. Preflight ports 8000/8001.
Run with a fresh RUN/home:

```sh
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_USE_DEV_PROXY=1 \
  HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS=0 HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/limit-result-resume.ts "$RUN"
```

The helper owns its daemon, local HTTP proxy and mock model, disables external
MCP entries and stores only the synthetic dev-proxy provider key in its fresh DB.

The proxy answers the turn request with `429 rate_limit_error` and the text
"Your limit will reset in 1 minutes." The helper sets `CLAUDE_CODE_MAX_RETRIES=0`
on the SDK subprocess, so the real Claude CLI reports that at once as an error
result. The CLI process stays alive after the result.

The daemon holds the turn in `rate_limit_cooldown` with `retryAt` about
90 seconds ahead, `reason: 'limit'` and a `since` between the send and the
hold, without charging the failure episode. The helper then lets the
proxy answer and waits for the watchdog's retry to send the held prompt to the
live CLI and finish it with a successful result, with no session error. The run
takes about two minutes. `evidence/observed.json` records the 429 count, the
hold, its retry time, the episode and the time held.

Before the fix, the retry's own prompt was requeued by the prompt feed because
recovery was still in flight, the feed closed, the CLI exited with code 1 and
the session showed "Failed to process message. Please try again."
