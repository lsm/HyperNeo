## Coding todo claims lookup

Use the shared in-process RPC setup from SKILL.md, with no provider/mock API:

```bash
RUN=$(mktemp -d /private/tmp/hn-claims-XXXXXX)
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/coding-claims-lookup.ts verify "$RUN"
```

Run `verify` on the regression commit to see the latency assertion fail;
`reproduce` retains an expected failing measurement without exiting nonzero.
The isolated daemon receives `neo.todo.edit` to finish a coding todo whose PR
is merged in the local GitHub stub. Production completion reads claims before
and after GitHub. The fixture retains 300,000 full historical reports, 100 live
todos with 200 branch claims each, and a competing removed todo's claim.
`observed.json` records caller stacks, plans, RPC latency, main-loop lag,
independent child-client `system.health`, completion, and stored history/claims
SHA before/after. The named todo must finish, the removed claim must remain
stored but excluded, all latency surfaces must stay below 250ms, and stored
history/claims must be unchanged. The helper closes all resources in `finally`.
GUI is not verified; synthetic traversal does not prove the historical tick's
physical cause. No real DB is read or copied and no claim policy changes.

For the smaller comparison, append `representative pre-index` to `reproduce`,
and `representative` to `verify`, each in a fresh run. The control drops only
this new index in the synthetic fixture. It uses 213 todos, full reports and
20,002 claims. Report it separately from the stress case; a small fixture below
250ms is not a reproduction of the live stall or a real-data measurement.

After the red daemon exits, measure the upgrade without changing any rows:

```bash
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  bun .claude/skills/verify/coding-claims-index-upgrade.ts "$RUN"
```

`migration-observed.json` records time, complete todo/claim row SHA/counts and
an idempotent rerun. These are synthetic costs, not production predictions.
