# A chat turn still saves and streams when saveSDKMessage is async

Read shared SKILL.md setup. `Database.saveSDKMessage` returns a promise ahead of
the move of `sdk_messages` writes onto the DB gateway writer. The reactive
facade emits the `sdk_messages` change only once that promise settles, so live
queries never re-read before the row exists.

```bash
.claude/skills/verify/launch.sh 9411 "$RUN"
# give it the dev-proxy model (SKILL.md, step 3)
VERIFY_PORT=9411 bun .claude/skills/verify/sdk-save-async.ts
.claude/skills/verify/stop.sh "$RUN"
```

The helper creates a session, subscribes to `messages.bySession`, sends one
message through `message.send` and waits for the turn. Pass: the live
subscription delivers `assistant` and `result` rows (exit 0), and
`message.sdkMessages` returns them from the store. The run's DB shows the user
row and every SDK row `consumed`.

Not covered here: the assistant-error paths (`displayErrorAsAssistantMessage` in
the query runners and the ACP runner); unit tests pin those.
