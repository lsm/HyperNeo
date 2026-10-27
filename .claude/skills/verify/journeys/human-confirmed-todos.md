# Human answers complete queued confirmation todos

Use the shared metadata-only setup in SKILL.md, with a fresh evidence directory:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/human-confirmed-todos.ts verify
```

The helper owns an isolated daemon and WebSocket, synthetic HOME/database and a
refusing GitHub stub. It needs no provider, model, simulator or browser. Only
work status/send are synthetic: no files are deleted and no real worker runs.

The real question-answer and chat RPCs answer a still-queued human_confirmed
todo with yes, a choice selection, a reply, and a free-text answer to a yes/no
card. Each public ask read must show Done and its successor Doing, with exactly
one dispatch, without running the scheduled refresh. Canonical no must leave
both todos queued and dispatch nothing. The same question semantics apply on
periodic refresh, so recorded historical answers recover after deployment.

The wrapper preserves human-confirmed-todos.json and the proof log, then removes
the owned daemon's temporary data. A listener failure is blocked, never a pass.
This does not prove live recovery, actual cleanup, visual layout or deployment.
