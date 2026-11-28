# Neo remote starts and remote todo targets name provider, model and effort

Build the web bundle first (`cd packages/web && bun run build`), then run with a free
port for daemon B (never 8399) and a fresh absolute evidence directory:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/remote-start-identity.sh 9361 /absolute/fresh/evidence-directory
```

The script starts daemon B through the CLI (`env -i`, NODE_ENV=test, own HOME, data
dir and database, no provider), makes a daemon pairing code on B, and runs
`remote-start-identity.ts`: daemon A in-process with its own HOME and database,
attached to B with that code. A seeds a synthetic Neo conversation whose human
request names B's project folder, then calls the production MCP handler as Neo.

End state:
- A reads B's `work.adapters`: `hyperneo` advertises `{ configurable: true }`.
- `work.start` on B with no triple, then with model and effort but no provider, is
  refused `identity_required` on A naming the missing fields; B holds no worker session.
- The same start with the full triple passes A and is forwarded; B answers it
  (`unsupported_model`, since B has no model catalog).
- `neo.todo.add` with a remote start target on B missing provider and effort is
  refused `identity_required` and adds no todo; the full triple is stored with it.
- A remote target on a daemon that is not attached is admitted; the dispatching
  daemon's gate decides later.
- Before this change the bare Neo remote start was forwarded without
  `identity_required`, and remote todo targets were never checked.

`observed.json` in the evidence directory holds every reply.
