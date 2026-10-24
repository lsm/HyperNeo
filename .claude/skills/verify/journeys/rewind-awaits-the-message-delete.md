# A conversation rewind still deletes and reports with an async message delete

Read shared SKILL.md setup. `Database.deleteMessagesAtAndAfter` returns a promise
ahead of the move of `sdk_messages` writes onto the DB gateway writer. The rewind
handler awaits it, so the reported count is a number, not a pending promise.

```bash
.claude/skills/verify/launch.sh 9431 "$RUN"
# give it the dev-proxy model (SKILL.md, step 3)
VERIFY_PORT=9431 .claude/skills/verify/rewind-after-turn.sh "$RUN"
.claude/skills/verify/stop.sh "$RUN"
```

The helper runs one real turn (`sdk-save-async.ts`), reads the turn's rewind
point from `rewind.checkpoints`, and rewinds in `conversation` mode. Pass:
`rewind.execute` returns `success: true`, `conversationRewound: true` and a
numeric `messagesDeleted`, and the session has no `sdk_messages` rows left.

Observed, not caused by this change: `messagesDeleted` is 16 for 8 deleted rows.
The repository returns the DELETE's `changes`, which here is twice the row count.

Not covered live: the action-message writes (`sdk_resume_choice`), whose
trigger is an SDK resume conflict. Unit tests pin them.
