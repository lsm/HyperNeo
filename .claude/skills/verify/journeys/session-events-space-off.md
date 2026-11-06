# Session events with Space off

Prove a plain session on a fresh Space-off daemon can subscribe to a pull request,
see an event delivered, and unsubscribe, through the real operations MCP server. No
model turn or provider key is needed. Run from the worktree root:

```bash
HYPERNEO_SPACE=off .claude/skills/verify/proof-run.sh "$PWD/.evidence-session-events" \
  .claude/skills/verify/session-events-space-off.ts
```

`session-events.json` must show `pass: true`, the five session `event.external.*`
operations listed for that session, `spaceSubscriptionTable: false`, an empty
`spaceEventTables`, and `proof-event` in `deliveries`. The isolated daemon has no
GitHub token, so `subscribe` answers `ok: false` with a `GITHUB_TOKEN` error: the
subscription is kept and routing works, only the live repo watch could not start.
