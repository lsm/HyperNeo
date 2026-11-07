# Human Mark done and card-local failures

Build `packages/web` with `bun run build`. Use fresh synthetic HOME/data only;
no provider, model, real GitHub, credential files or port 8399. This helper owns
an ephemeral daemon and static-web listener and closes both in finally.

With Node and Playwright installed, use the shared proof wrapper from the worktree root:

```sh
TMPDIR=/private/tmp NODE_PATH="$NODE_PATH" VERIFY_BROWSER="$VERIFY_BROWSER" \
  bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/mark-done-settle.ts verify
```

`NODE_PATH` points to the installed Playwright package. `VERIFY_BROWSER` may name
an installed Chrome executable; it always runs headless, with a fresh profile.
No desktop GUI is driven. The wrapper retains evidence and removes the synthetic
data after the owned listeners stop.

The browser first redeems a synthetic pairing code against the owned listener.
The HTTP wrapper awaits the daemon request guard. The real `/neo` Mark done menu refuses an unfinished ask. Its card remains open
and shows the unfinished-todo error locally. A separately seeded completed ask verifies that Mark done
changes the ask to Done under Recent outcomes. Its actions menu then retains only Reply.
A separate synthetic unavailable worker makes stop fail: its ask stays
open, the error appears inside that card, and Mark done remains retryable.
Check desktop 1280 and mobile 390 widths; inspect `marked-done.png` and
`card-error-*.png`. `browser.json` records the visible errors and retries;
`observed.json` records persisted ask states and cleanup. Component contracts
also cover transport rejection/non-Error failures and clearing errors on retry.
Agent settlement also refuses done with unfinished todos. Historical closed-unverified rows retain their label and never count as done. The ask-bookkeeping-actions journey proves the MCP and public-reader payloads. Native iOS is outside this slice.

Never restart or modify the live daemon for this journey.
