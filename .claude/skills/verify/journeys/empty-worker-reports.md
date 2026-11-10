# Empty unchanged worker reports stay quiet

Use SKILL.md's metadata-only wrapper with the pinned Bun runtime:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/empty-worker-reports.ts
```

The helper owns a random-port daemon, disposable HOME/DB, a refusing GitHub stub
and an authenticated local socket. It seeds terminal SDK records, confirms each
empty or meaningful result through work.status, and runs the real driver-refresh
job, then reads Neo's actual incoming SDK messages.

Empty and whitespace-only automatic reports on an already-idle, unblocked worker
must add no input. Changed or unknown prior status, an open question, meaningful
text, a human-origin turn and a new blocker each retain one report. Exact refresh
replays add none. Save observed.json, proof.log and the wrapper exit status.
No model, native app, live daemon or external GitHub request runs.

Focused runner tests also preserve legacy observations and failed admission
retries. Suppression records its observation but cannot acknowledge a shared
worker-turn delivery needed by another actionable assignment.
