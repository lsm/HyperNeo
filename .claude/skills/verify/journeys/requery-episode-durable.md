# A task-notification requery episode survives a daemon restart

Run with the in-process proof wrapper:

```bash
bash .claude/skills/verify/proof-run.sh <fresh-abs-dir> \
  .claude/skills/verify/requery-episode-durable.ts
```

The helper owns the daemon, HOME and DB with `NODE_ENV=test` and no provider
key. It creates a plain session, attaches an `AgentSession` without starting a
query, feeds ten synthetic hollow task-notification results through the real
`onSDKMessage`, and asserts exactly one `session.error` escalation plus a
persisted `taskNotificationRequeryEpisode` (`attempts >= 5`, `escalation:
'done'`). It then boots a second daemon app over the same data directory —
the restart — reattaches the session, feeds eight more hollow results, and
asserts no second `session.error`: later failures hold because the episode is
durable. Evidence lands in `requery-episode-durable.json`.
