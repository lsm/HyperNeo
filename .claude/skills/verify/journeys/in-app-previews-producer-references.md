# In-app previews: producer references (slice 12)

A worker registers a file with `artifact.file.register`; Neo then shows it as a
short card instead of pasting the document. Two producer paths carry the
returned reference in an optional `artifacts` list:

- `neo.publication.publish` stores it on the delivered message;
- `neo.todo.edit` with `done` stores it on the ticked todo (`neo_todos.artifacts_json`,
  migration 434) and `neo.snapshot` shows it on the card.

The daemon checks every reference against its registry with the same authority
as `artifact.file.get`: an unknown ID, a changed title/kind/size, another
daemon's ID, or an artifact the caller may not read is refused with
`invalid_artifact_reference`, and nothing is stored. References without `done`
are refused, not dropped. Old messages and todos without references read as
before. The publication and todo-edit descriptions and the worker goal line ask for
one sentence plus the reference, not the pasted document.

Isolated daemon proof (todo path), in one owning shell with a stop.sh trap:

```bash
RUN=$(mktemp -d /private/tmp/hn-producer-refs-XXXXXX)
mkdir -p "$RUN/home" "$RUN/evidence"
E=(env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" NODE_ENV=test)
"${E[@]}" bun .claude/skills/verify/preview-producer-refs-rpc.ts "$RUN" seed
.claude/skills/verify/launch.sh 9386 "$RUN"
"${E[@]}" bun .claude/skills/verify/preview-producer-refs-rpc.ts "$RUN" publish 9386
.claude/skills/verify/doctor.sh 9386 "$RUN"
.claude/skills/verify/stop.sh "$RUN"
.claude/skills/verify/launch.sh 9386 "$RUN"
"${E[@]}" bun .claude/skills/verify/preview-producer-refs-rpc.ts "$RUN" restart 9386
.claude/skills/verify/stop.sh "$RUN"
```

`publish` registers a synthetic report through `operation.invoke`, shows three
forged references refused with the todo still open, ticks the todo with the real
reference, and reads it back from `neo.snapshot`. `restart` reads the same card
reference after a daemon restart and opens its metadata with `artifact.file.get`.
Evidence: `RUN/evidence/producer-refs-rpc*.json` and `doctor.txt`.

Not proven here: `neo.publication.publish` needs a live Neo turn, which RPC cannot
supply, so the publication path is covered by
`tests/unit/1-core/operations/neo-publication-operation.test.ts` (in-process
operation door) only. No web or iOS UI renders the references yet; that is
slices 14 and 18. Synthetic data only; no credentials, live DB, port 8399 or
unattended GUI.
