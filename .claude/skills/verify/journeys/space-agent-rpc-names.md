# Space agent RPC method names

Use after changing how the `spaceAgentV2`, `spaceAgentReminder`,
`spaceAgentTemplate` or `spaceAgentSubscription` handlers register their methods.
Build the web bundle first, then run:

```bash
VERIFY_MOCK_PORT=8047 .claude/skills/verify/with-run.sh \
  .claude/skills/verify/space-agent-rpc-names.sh 9347
```

The script launches an isolated daemon and sends each of the 20 method names over
the real WebSocket with empty input. An unknown control method must answer
`No handler for method`; every listed method must reach its handler instead (a
validation error from the handler counts). Pass is exit 0 and
`reached 20 of 20 handlers`.
