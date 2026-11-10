# Coding project identity policy

Run from the shipping checkout with the pinned Bun on PATH. Choose a temporary
root outside the OS temporary tree because discovery excludes temporary places.
The evidence directory must be new and absolute.

```sh
TMPDIR="$HOME/verification" bash .claude/skills/verify/proof-run.sh \
  "$HOME/evidence/project-identity" .claude/skills/verify/coding-project-identity.ts
```

The wrapper supplies disposable HOME/data/DB and a scrubbed test environment.
The helper refuses external HTTP and GitHub, owns an ephemeral listener, and
calls `work.find` through authenticated local WebSocket RPC with synthetic work.
It first runs inline mirroring, then the production worker entry. Both must keep
the same project IDs, titles and ordered alias rows across duplicate workspaces.
A tool project retains folder ownership while legacy repository backfill gives
the shared repository identity to the standalone project.

The real `neo.projects.reorganize` RPC then deletes an unrelated empty project
while protecting both repository-backed projects. Retain `project-identity.json`
and `run-status.json`. Require verified and resourcesClosed to be true, two
protected projects, one deletion and exitCode zero. The helper closes its socket,
worker and daemon. No provider, real credentials, live daemon or migration is used.
