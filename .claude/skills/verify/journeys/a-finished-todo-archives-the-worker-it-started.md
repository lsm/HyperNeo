# A finished todo archives the worker it started

Use the shared metadata-only setup from SKILL.md with the owned-daemon helper:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/todo-finish-archives-worker.ts verify
```

The helper boots an isolated daemon with its job processor running. It seeds two
done todos on HyperNeo worker sessions: one the todo started with a generated
name, one started under a human-given name. It moves the pending driver refresh
job to now and waits for that job to run.

End state in `todo-release.json`: the generated-name worker is `archived`, the
named worker stays `active`, and exactly one `core/released` fact exists, for
the first todo. A worker with a dirty or unpushed worktree keeps that worktree
through the existing archive cleanup. No model, provider or real data is used.
