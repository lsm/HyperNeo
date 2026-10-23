## Coding todo claims lookup

Use the shared in-process RPC setup from SKILL.md, with no provider/mock API.
The helper needs a fresh directory under `/private/tmp/hn-claims-` and a local
GitHub stub first on PATH:

```bash
RUN=$(mktemp -d /private/tmp/hn-claims-XXXXXX)
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/coding-claims-lookup.ts verify "$RUN"
```

Run `verify` on the regression commit to see the latency assertion fail; use
`reproduce` to retain the expected failing measurement without exiting nonzero.
The actual isolated daemon receives `neo.todo.edit` to finish a coding todo
whose PR is merged in the local GitHub stub. Its production completion check
reads claims before and after GitHub. The fixture keeps 300,000 full historical
todo reports, 100 live todos with 200 branch claims each, and a competing removed
todo's claim. It changes no claim policy and never copies a real DB.

`observed.json` retains caller stacks, query plans, RPC latency, main-loop lag,
independent child-client `system.health` latency, completion state, and stored
history/claims SHA before and after. The named todo must finish, the removed
claim must remain stored but excluded from the read, all three latency surfaces
must remain below 250ms, and stored history/claims must be unchanged. The helper
closes its daemon, socket and child in `finally`. GUI is not verified. Synthetic
traversal is not proof of the physical cause of the historical 18.4s tick.
