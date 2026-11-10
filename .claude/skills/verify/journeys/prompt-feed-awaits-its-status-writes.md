# Prompts are consumed with async status writes

Read shared SKILL.md setup. `Database.updateMessageStatus` and
`updateMessageTimestamp` return promises ahead of the move of `sdk_messages`
writes onto the DB gateway writer.
- The message queue awaits its yield callback, so a prompt reaches the SDK only
  after its row is consumed.
```bash
.claude/skills/verify/launch.sh 9441 "$RUN"
# give it the dev-proxy model (SKILL.md, step 3)
VERIFY_PORT=9441 bun .claude/skills/verify/sdk-save-async.ts
.claude/skills/verify/stop.sh "$RUN"
```

The SDK turn must stream `assistant` and `result`, and its user row must be `consumed`.
