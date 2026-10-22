## Claude Desktop import between CLI turns: transcript and UI facts

Run from the worktree root, using a fresh synthetic HOME/data directory:

```bash
RUN=$(mktemp -d /private/tmp/hn-claude-ui-facts-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/claude-desktop-link.ts 9383 "$RUN"
```

The helper owns a real isolated daemon and calls its public work operations.
All Claude/agents/Desktop-launch processes are synthetic stubs. No GUI or real
provider runs, credentials are not read, and no human session is touched.

The synthetic CLI completes turn 1 with end_turn. The fixture then imports that
session into a synthetic Desktop record before work.send resumes it headlessly.
Turn 2 also ends with end_turn; the imported record remains byte-identical.
The receipt-bound status must include the second reply and transcriptState
completed, while both send and status explicitly report desktopUI.state
ui-unconfirmed. A pending-turn component case reports accepted separately.

Evidence is saved to evidence/observed.json even when an assertion fails. The
helper cleans up its daemon and worker in finally. Preserve that file outside
the worktree. This proves the operation's truthful reporting; it does not prove
Desktop rendered or the human read the second turn. No supported live Desktop
render/read acknowledgment exists in this adapter. Import records, Remote
Control links, CLI exit/receipt and mods turn events cannot substitute for it.
Do not launch, focus, click, type, rewrite private Desktop stores or force another
owner to manufacture confirmation. Stage 2's human capture helper is separate.
