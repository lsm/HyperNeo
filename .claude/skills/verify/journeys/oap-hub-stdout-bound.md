# OAP hub stdout line bound

Use shared isolation, the resource guard and pinned Bun from `../SKILL.md`.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/oap-hub-stdout-bound.ts
```

The helper starts an isolated daemon on an ephemeral port and an owned synthetic
stdio hub. An authenticated RPC message reaches submit, then the child writes
more than 1 MiB without a newline. The session must surface the line-limit error,
future client requests must reject and the owned child must exit. Unit fixtures
also cover completed oversized frames, UTF-8 byte size, near-limit valid replies
and batches of valid lines. The socket, daemon and child close before temporary
data is removed. Real provider behavior remains outside this synthetic journey.
