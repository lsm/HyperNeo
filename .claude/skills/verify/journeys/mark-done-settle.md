# Human Mark done and card-local failures

Build `packages/web` with `bun run build`. Use fresh synthetic HOME/data only;
no provider, model, real GitHub, credential files or port 8399. This helper owns
an ephemeral daemon and static-web listener and closes both in finally.

With Node and Playwright installed, run from the worktree root:

```sh
RUN=$(mktemp -d /private/tmp/hn-mark-done-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" \
  PATH="$RUN/bin:$(dirname "$(command -v bun)"):$(dirname "$(command -v node)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" NODE_PATH="$NODE_PATH" \
  VERIFY_BROWSER="$VERIFY_BROWSER" \
  bun .claude/skills/verify/mark-done-settle.ts verify "$RUN"
```

`NODE_PATH` points to the installed Playwright package. `VERIFY_BROWSER` may name
an installed Chrome executable; it always runs headless, with a fresh profile.
No desktop GUI is driven. Run `before` on the regression commit to capture the
unfinished-todo refusal, the still-open card and absence of a card-local error.

The real `/neo` Mark done menu changes an unfinished ask to Done under Recent
outcomes. Its actions menu retains only Reply, with neither settling action.
A separate synthetic unavailable worker makes stop fail: its ask stays
open, the error appears inside that card, and Mark done remains retryable.
Check desktop 1280 and mobile 390 widths; inspect `marked-done.png` and
`card-error-*.png`. `browser.json` records the visible errors and retries;
`observed.json` records persisted ask states and cleanup. Component contracts
also cover transport rejection/non-Error failures and clearing errors on retry.
Agent settlement records unfinished todos and closes them unverified; those rows never count as done. The ask-bookkeeping-actions journey proves the MCP and public-reader payloads. Native iOS is outside this slice.

After merge/close remove the worktree and read the deployed commit via owner RPC;
never restart or modify the live daemon.
