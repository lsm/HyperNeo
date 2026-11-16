# Every artifact operation answers through RPC

```sh
.claude/skills/verify/launch.sh 9311 "$RUN"
VERIFY_PORT=9311 HYPERNEO_DATA_DIR="$RUN/data" bun .claude/skills/verify/rpc.ts neo.open '{}'
.claude/skills/verify/seed-todo.sh "$RUN"
.claude/skills/verify/artifact-operations.sh 9311 "$RUN"
```

The script first calls `artifact.file.get`, `artifact.file.read`,
`artifact.file.html` and `artifact.reference.resolve` with unknown IDs; each must
refuse with `unavailable`. It then seeds a small HTML attachment on
`todo-verify` with `legacy-attachment-fixture.ts` and reads it back:
`artifact.file.list` lists it, `artifact.file.get` returns its title,
`artifact.file.read` returns the complete bytes, and `artifact.file.html`
returns the heading with the script removed. Every call is logged to
`$RUN/evidence/artifact-operations.log`. Use it after renaming or rewiring
artifact operation pipelines.
