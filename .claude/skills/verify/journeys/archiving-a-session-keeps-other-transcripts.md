# Archiving or deleting a session keeps other sessions' transcripts

Use the shared metadata-only setup from SKILL.md with the owned-daemon helper:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/archive-keeps-other-transcripts.ts verify
```

The helper boots an isolated daemon and seeds two sessions in one workspace, so
their synthetic SDK transcripts share one project folder under the run's HOME.
The worker has a current SDK id and a retired one in `pastSdkSessionIds`. The
other transcript mentions the worker's ids in its text and holds a record that
carries the worker's HyperNeo id, as a Neo session talking about a worker does.
It archives the worker through `session.archive`, then deletes it through
`session.delete`.

End state in `archive-transcripts.json`: after archive the worker is
`archived`, both of its transcripts are still in place with the SDK's
`<id>/archived.json` mark beside them, and nothing moved. After delete only the
other transcript is left. The other transcript is byte-identical after both
steps. No model, provider or real data is used.
