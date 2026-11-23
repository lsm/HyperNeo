# Start an Antigravity CLI session and read its initial turn

Use the isolated daemon and pinned Bun from the Verify skill. Run each mode
with a fresh evidence directory.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/start-evidence \
  .claude/skills/verify/antigravity-find.ts start
bash .claude/skills/verify/proof-run.sh /absolute/signed-out-start-evidence \
  .claude/skills/verify/antigravity-find.ts start-signed-out /absolute/vendor/agy
bash .claude/skills/verify/proof-run.sh /absolute/initialize-auth-evidence \
  .claude/skills/verify/antigravity-find.ts start-init-auth
```

The public `work.start` operation creates an owned session in the requested local
directory and submits its initial prompt through the sandboxed ACP child. The
fixture holds the turn open until `work.status` reports it running. The permission
request is cancelled, and the final reply comes from the session that was started.
An unrelated session update must not alter that reply. A foreign session has no
owned status and an unsupported model is rejected before creating the child.
The agent acknowledges `session/close` before the driver reports the turn done.
Active turns have a 60-minute deadline. The focused driver tests advance a
clock through the old ten-minute cutoff and check the timeout and disconnect
messages separately.
When the agent lists the subprocess launch directory for every session, a
folder search matches the recorded owned workspace. An external session with
no verified workspace only appears in unscoped discovery.

The real signed-out CLI must report that sign-in is needed before any prompt is
submitted. The initialization fixture returns the same authentication error
during `initialize` and must report the same sign-in instruction without
sending a second ACP request. Require all wrapper exits to be zero and check
`antigravity-find.json` and the fixtures' `requests.jsonl`. An attended,
signed-in smoke is required to verify a real model turn.
