# Archiving a session keeps other sessions' transcripts

Use the shared metadata-only setup from SKILL.md with the owned-daemon helper:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/archive-keeps-other-transcripts.ts verify
```

The helper boots an isolated daemon and seeds two sessions in one workspace, so
their synthetic SDK transcripts share one project folder under the run's HOME.
The second transcript mentions the first session's id in its message text, as a
Neo session talking about a worker does. It archives the first session through
the `session.archive` RPC.

End state in `archive-transcripts.json`: the worker is `archived`; its archive
folder holds only its own transcript and `archive-metadata.json`; the project
folder still holds the other session's transcript. Before the fix the other
transcript was moved into the worker's archive too. No model, provider or real
data is used.
