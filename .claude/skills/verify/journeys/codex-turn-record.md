# Each finished Codex turn is recorded

A Codex worker's log holds a turn bigger than the old 4 MB tail, a mention of an old
PR, an aborted turn, a turn with no input, a steered turn, an unreadable line and a
running turn. The session watcher records nothing while the worker runs, then records
each turn under its native turn ID. New turns appended later continue from the cursor.

Read SKILL.md's shared isolation setup. The helper owns a real test daemon, a fresh
home and a synthetic Codex state database and log. No provider, model, GUI or port
8399.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/codex-turn-record.ts
```

Evidence: `observed.json`.
