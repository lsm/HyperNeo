# Restore an archived HyperNeo chat

Build the web bundle and select a Playwright installation and Chromium as
described in the shared verify skill. Then run:

```bash
VERIFY_MOCK_PORT=8132 bash .claude/skills/verify/with-run.sh \
  bash .claude/skills/verify/session-unarchive.sh 9432 /absolute/evidence-directory
```

The helper creates and archives chats through the isolated daemon. The restore
RPC reopens a chat and makes a fresh worktree from dev when the recorded branch
is gone. The Neo operation uses the recorded branch tip when it is available.
Desktop and touch contexts open Chats, capture the archived row, click Unarchive
and check that each restored session accepts another message. The evidence
directory contains RPC replies and desktop and phone screenshots.
