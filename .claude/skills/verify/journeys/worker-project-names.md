# New todo workers receive project names

Use the shared isolated metadata wrapper and pinned Bun from SKILL.md:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/worker-project-names.ts
```

The helper owns a random-port daemon with a synthetic HOME and database. Through
its real MCP operation handler, it overlaps two approved todo starts in one folder.
The first driver start waits while the second enters dispatch. A fake
HyperNeo adapter records both start requests and publishes the first title only when its start completes.
The titles must be HyperNeo project 1 and HyperNeo project 2. Task titles stay on
the todos. The operation description must advertise target.name and omit the
rename-after-start workaround. No provider, native app or external service runs.

Save worker-names.json, proof.log and the wrapper exit status. The helper closes
its daemon, and the wrapper removes its temporary data. Unit coverage includes
the smallest free number, explicit names, invalid names, repository labels and
complete source inventory beyond the normal per-place display limit.

The default place and an explicit copy share one adapter/place lane. The unit
regression also overlaps a direct start with queue.fill; a rejected start releases
its lane, while other places and engines remain independent.

Numbered names and lanes cover local starts only. The forwarding regression
preserves an explicit target.name, or the pre-existing title when absent, and
asserts that neither the local inventory nor its lane is consulted.
