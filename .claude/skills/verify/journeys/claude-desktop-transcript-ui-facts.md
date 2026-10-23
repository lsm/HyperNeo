## Claude Desktop native delivery: transcript and UI facts

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

The synthetic CLI performs only preparation and exits. The fixture imports the
session before a Haiku helper forwards the actual task through native Desktop
messages. `work.send` also uses native messages, with no headless task fallback.
The follow-up ends with end_turn; the imported record remains byte-identical.
Receipt-bound status includes the full follow-up reply and transcriptState
completed, while send and status explicitly report desktopUI.state
ui-unconfirmed. A native permission wait is separately visible as needs_you.
Live CLI/unknown target owners refuse before any helper request. See
[the B1 journey](claude-desktop-b1.md) for the complete receipt, mode, refusal
and native hand-check contract.

Evidence is saved to evidence/observed.json even when an assertion fails. The
helper cleans up its daemon and worker in finally. Preserve that file outside
the worktree. This proves the operation's truthful reporting; it does not prove
Desktop rendered or the human read the second turn. No supported live Desktop
render/read acknowledgment exists in this adapter. Import records, Remote
Control links, CLI exit/receipt and mods turn events cannot substitute for it.
Do not launch, focus, click, type, rewrite private Desktop stores or force another
owner to manufacture confirmation. Stage 2's human capture helper is separate.
