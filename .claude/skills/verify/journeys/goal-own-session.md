# A goal runs in its own session

`goal.session.create` with `ownSession: true` starts a session for the goal,
under the creating session as its parent. Its wakes and reviews run there, and
Neo receives only the review summary.

Run on a build/test host, after building web for the checked-out head:

```bash
VERIFY_MOCK_PORT=8711 bash .claude/skills/verify/with-run.sh \
  bash .claude/skills/verify/goal-own-session.sh 9711
```

The runner launches an isolated daemon with `goal-session-script-api.ts`, a
scripted model, and registers the dev-proxy provider. It then runs
`goal-own-session.ts`. That helper opens root Neo and creates a one-minute goal
with `ownSession: true`. The first wake is an ordinary work wake. After it is
journaled, the helper adds nine more entries, so the next wake asks for the
what-works review.

The scripted model loads the deferred operations door with ToolSearch. It then
acts as the goal session through the real MCP door. On a work wake it calls only
`goal.journal.append` with the wake's runId. On a review wake it also calls
`goal.session.update {worksNote}` and `session.clone.return`.

Pass means all of these hold:

- the goal owner is a new session titled `Goal: <title>` whose parent is root Neo;
- the schedule targets it;
- both wakes are in its transcript with the goal-session cycle, not Neo's home steps;
- root Neo's transcript has no wake for the goal;
- each wake's journal entry was written by the goal session;
- after the work wake's turn ends, Neo has received nothing;
- the review wake rewrites the what-works note;
- root Neo's transcript then holds exactly one `分身 returned` message, the review summary;
- completing the goal removes its schedule and leaves the session active.

Evidence: `evidence/goal-own-session.json`. Set `VERIFY_KEEP_RUN=1` to copy
it out before the run directory is removed.
