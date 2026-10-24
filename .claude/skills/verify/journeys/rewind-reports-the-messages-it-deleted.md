# A conversation rewind reports the number of messages it deleted

Read shared SKILL.md setup. Under bun:sqlite, a statement's `changes` also
counts rows that triggers change, and `sdk_messages` has delete triggers (the
message body and the task projection). The rewind's `messagesDeleted` now
counts the deleted messages themselves.

```bash
.claude/skills/verify/launch.sh 9451 "$RUN"
# give it the dev-proxy model (SKILL.md, step 3)
VERIFY_PORT=9451 .claude/skills/verify/rewind-after-turn.sh "$RUN"
.claude/skills/verify/stop.sh "$RUN"
```

Pass: `rows before` equals `messagesDeleted` (8 and 8 for one turn on the dev
proxy), and `rows after` is 0. Before the fix, the same run reported 16.

The unit reproduction fails only under `bun test` (the production runtime). Node's
SQLite, which Vitest uses in CI, does not count trigger writes.
