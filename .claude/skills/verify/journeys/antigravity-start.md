# Start an Antigravity CLI session and read its initial turn

Use the isolated daemon and pinned Bun from the Verify skill. Run each mode
with a fresh evidence directory.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/start-evidence \
  .claude/skills/verify/antigravity-find.ts start
bash .claude/skills/verify/proof-run.sh /absolute/signed-out-start-evidence \
  .claude/skills/verify/antigravity-find.ts start-signed-out /absolute/vendor/agy
```

The public `work.start` operation creates an owned session in the requested local
directory and submits its initial prompt through the sandboxed ACP child. The
fixture holds the turn open until `work.status` reports it running. The permission
request is cancelled, and the final reply comes from the session that was started.
An unrelated session update must not alter that reply. A foreign session has no
owned status and an unsupported model is rejected before creating the child.

The real signed-out CLI must report that sign-in is needed before any prompt is
submitted. Require both wrapper exits to be zero and check `antigravity-find.json`
and the fixture's `requests.jsonl`. The fixture covers the successful protocol path.
An attended, signed-in smoke is required to verify a real model turn.
