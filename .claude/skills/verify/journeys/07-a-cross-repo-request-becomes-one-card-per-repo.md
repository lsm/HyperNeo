7. **A cross-repo request becomes one card per repo.** Launch with
   `VERIFY_MOCK=neo-script-api.ts .claude/skills/verify/launch.sh 9311 "$RUN"`.
   That mock plays root's model: when the human's message contains
   `verify-cross-repo`, it calls `neo.ask.open` with todos for two repos
   (`lsm/HyperNeo` and `lsm/open-agent-protocol`). Open root, then send
   `neo.message.send {"sessionId":"<root>","requestId":"<uuid>","content":"Attach the open PRs (verify-cross-repo)"}`.
   End state within ~20 s: `neo_asks` holds the request card `done` with outcome
   `Filed 3 todos across hyperneo, open-agent-protocol cards.` and two open
   child cards, `Attach open PRs · hyperneo` and `· open-agent-protocol`, each
   with only its repo's todos (`neo_todos.repo`). On `/neo`, "Your work" lists
   the two child cards, and Recent outcomes shows the request as Done with that
   outcome under Details.
