# Coding todos stay in their worker repository

Use the shared metadata-only proof wrapper with Bun 1.4.2:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/worker-repository.ts
```

The helper starts an isolated NODE_ENV=test daemon with a fresh HOME and database,
no provider and no model turn. Synthetic workers have real local Git repositories
with matching SSH, different HTTPS, or absent remotes. Production work.status
resolves their places; todo resolution reads local remotes with the shared cached
workspace identity reader, while remote workers use only status remotes; the MCP operations accept matching and non-coding sends,
and refuse other or unknown repositories on add, edit, bind and continue.
Dispatch sentries require zero work.send/work.start calls, and the delivery input
count stays zero. Refused adds create no todo; refused edits and binds create no
worker target. Evidence includes operation replies and the dispatch counts.
The helper stops its daemon; the wrapper retains evidence and removes test data.

Remote status and discovery fixtures model an attached daemon whose status has no
remotes. Its exact worker discovery remotes accept the matching repository and
refuse mismatched or absent remotes. External daemon transport is simulated.
