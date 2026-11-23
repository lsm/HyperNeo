# Restore an archived HyperNeo chat

Build the web bundle and select a Playwright installation and Chromium as
described in the shared verify skill. Then run:

```bash
VERIFY_MOCK_PORT=8132 bash .claude/skills/verify/with-run.sh \
  bash .claude/skills/verify/session-unarchive.sh 9432 /absolute/evidence-directory
```

The helper creates and archives chats through the isolated daemon and checks
that the original worktree directory is removed. The restore
RPC reopens chats from dev when the recorded branch is gone. Without dev, it
uses the local main or remote-tracking default branch. The Neo operation uses
the recorded branch tip when available.
Desktop and 390px touch contexts show archived chats from the project menu while
leaving the other project hidden. They capture the open menu with Unarchive
visible, confirm that Delete this project opens the existing confirmation,
then cancel and restore the chat. Each restored session accepts another message.
The evidence directory contains the RPC replies and the desktop and phone
project menu screenshots.
