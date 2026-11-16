# Worker work folders follow their worktree

Use the shared metadata-only isolated-daemon setup in SKILL.md. No model,
provider credentials or fixed mock ports are needed. The helper starts an
ephemeral non-8399 daemon, makes a synthetic Git repo with linked session
worktrees, plants synthetic `builds`, `scratch`, `gh-config` and `evidence`
folders for each, then archives and deletes sessions through real RPC.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/worker-work-folders.ts
```

Observe `worker-work-folders.json`:

- `archive` and `delete`: the session's worktree is removed, and its builds,
  scratch and gh-config folders go with it. Its evidence folder stays.
- `archive.sibling`: another worker's folders are untouched.
- `inPlace`: a session whose folder still exists keeps its builds and gh-config
  folders (scratch release on archive is older behavior).
- `failure`: a failing folder cleanup keeps that folder, the archive RPC still
  succeeds and the session row is archived.

Run it on origin/dev's sources to see the gap this covers: the tree is removed
but its builds and gh-config folders stay. Removal of Desktop and Codex worker
trees goes through the same shared remover; its focused tests cover that path.
