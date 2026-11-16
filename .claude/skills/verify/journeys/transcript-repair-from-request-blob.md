### A transcript missing an assistant tool_use line resumes or says why it cannot

A transcript can keep a `tool_result` whose assistant `tool_use` line was never
written. Repair restores that line from the DB, or else from the transcript's
own `api-request-blob` line. Each repair keeps only the newest two backups of
that session. When nothing has the line, the resume error and the resume card
say the transcript could not be repaired and why, not that it was not found.

```bash
RUN=$(mktemp -d /private/tmp/hn-transcript-repair-XXXXXX); rmdir "$RUN"
.claude/skills/verify/transcript-repair.sh "$RUN" 9378
```

The helper starts an isolated metadata-only daemon (`env -i`, `NODE_ENV=test`,
its own HOME and DB) and creates two sessions. While the daemon is down it
points them at synthetic transcripts: one whose missing `tool_use` survives in a
request blob (with three old backups and another session's backup beside it),
one with nothing to restore. It then resumes both with `session.sdkResumeChoice`
`leave_as_is`, registers the dev-proxy test provider over RPC and sends one
message to the unrepairable session so the resume gate posts its card.

End state: the helper prints `PASS` and exits 0. The first transcript has the
restored assistant line (thinking signature intact) directly before its
`tool_result`. Its backups are the newest old one plus the new one; the other
session's backup is untouched. The second resume fails with `could not be
repaired: Could not find tool_use message for toolu_lost ...`, and its card in
`message.sdkMessages` carries that `repairError`. Evidence is in
`$RUN/evidence/`. The card's visual layout is covered by its component test,
not this helper.
