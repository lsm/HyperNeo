# User-message saves and mailbox failures still land when saveUserMessage is async

Read shared SKILL.md setup. `Database.saveUserMessage` returns a promise ahead
of the move of `sdk_messages` writes onto the DB gateway writer. The mailbox
failure pipelines end with `endAsync`, so dead letters and session teardown
resolve only after their failed rows are written.

```bash
.claude/skills/verify/launch.sh 9421 "$RUN"
# give it the dev-proxy model (SKILL.md, step 3)
VERIFY_PORT=9421 bun .claude/skills/verify/sdk-save-async.ts
.claude/skills/verify/stop.sh "$RUN"

.claude/skills/verify/launch.sh 9422 "$RUN2"   # fresh run, no provider
VERIFY_PORT=9422 .claude/skills/verify/missing-provider-check.sh "$RUN2"
.claude/skills/verify/stop.sh "$RUN2"
```

Pass:
- The turn streams `assistant` and `result` through `messages.bySession`, and the
  user row is `consumed`.
- On the run with no provider, the delivery job is `dead` with the provider
  error, and the user row is `failed`.

Not covered live: the dead-letter insert of a new failed row when no row exists
yet, and the archived-session save in `message-persistence`. `message.send` to
an archived session is refused earlier with "Session not found". Unit tests pin
both.
