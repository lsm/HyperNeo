# Steer active Antigravity CLI work

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh /absolute/evidence \
  .claude/skills/verify/antigravity-find.ts steer
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh /absolute/unavailable-evidence \
  .claude/skills/verify/antigravity-find.ts steer-without-replay
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh /absolute/identical-evidence \
  .claude/skills/verify/antigravity-find.ts steer-identical
```

Start work through the isolated daemon, then send an explicit `steer` while
the original request is active. The original ACP request returns first and
continues to emit text. HyperNeo stays running until the second request
finishes, closes the session once, and uses the saved conversation to confirm
the new input and its answer. The receipt excludes the earlier streaming text.
The new receipt is unavailable if saved history contains only the original
exchange or the instructions are identical. A second overlapping steering
request, an idle session, and an unrelated session are refused before sending.

For an attended run, start a disposable conversation with a prompt that elicits
a long answer. After its text starts streaming, steer it to a short, unique
phrase. The native CLI can finish the original answer before acting on the new
instruction. Confirm the saved conversation contains the new instruction and
the distinct short answer, and that the steering receipt contains those alone.
