# Read an Antigravity CLI conversation

Use the isolated daemon and pinned Bun from the Verify skill:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/history-evidence \
  .claude/skills/verify/antigravity-find.ts history
```

Start a daemon-owned session and request its saved messages through
`work.read`. Verify the latest page, the older page, and a window around a
message ID. Replay preserves order across chunks and excludes updates for
other sessions or after the load response. A foreign session is unavailable.
The three reads only initialize and load the recorded session.

For an attended check, start and resume a disposable session with the
signed-in CLI. Read the saved user and agent text through the driver and
confirm that a history read did not add another turn.
