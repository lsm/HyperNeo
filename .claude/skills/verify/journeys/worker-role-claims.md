# Record independent worker roles

Use the shared isolation and resource-check setup in `../SKILL.md`:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/worker-role-claims.ts
```

The helper starts an isolated daemon with a synthetic home and database, creates two
idle daemon-started workers, and invokes the real `work.start` operation for `do`
and `review` on one todo. It requires two reused refs and the matching role rows,
rejects an unsupported role, and confirms a refused second role cannot release an
existing claim.
The wrapper saves `worker-role-claims.json` and removes the temporary daemon data.
This does not exercise a model turn, native client, or preparation-aware reuse.
