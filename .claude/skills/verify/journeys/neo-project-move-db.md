# Project move on the DB writer

Use the shared isolation and resource guard in SKILL.md. Reuse the existing
checkout and installed runtimes, running heavy jobs serially.

```sh
python3 .claude/skills/verify/neo-project-move-db-run.py bun before
python3 .claude/skills/verify/neo-project-move-db-run.py deno before --executable "$DENO"
python3 .claude/skills/verify/neo-project-move-db-run.py bun verify
python3 .claude/skills/verify/neo-project-move-db-run.py deno verify --executable "$DENO"
bun --no-install --no-env-file .claude/skills/verify/neo-project-move-proof-binding.ts HEAD
```

DENO names an existing runtime, with cached-only imports. Every proof owns a
fresh synthetic HOME/data/TMPDIR and daemon on an ephemeral non-8399 port.
HTTP is refused and gh is a refusing stub; no credentials, live database,
model or browser is involved. Save evidence before deleting temporary data.
Before mode temporarily restores project-tree-operations.ts and
neo-repository.ts from origin/dev, restoring the draft in finally. Do not
edit concurrently. The committed bound-writer regression must fail before
implementation; baseline daemon runs must observe target SQL on main.

The production WebSocket operation.invoke door calls neo.project.move and
neo.snapshot. Two requests with the same revision compete to reparent a
project: exactly one succeeds, the other reports superseded. The public
snapshot retains its context and summary with one revision increment. A
same-parent retry changes nothing; stale moves, cycles, section orphaning,
workspace-incompatible moves and unknown projects are refused. Cycle and
unknown-project errors retain their precedence over stale revisions. The
public state must survive reopening the daemon.

Sections and workspace aliases are synthetic DB fixtures; this journey does
not verify section creation. Earlier unsuccessful harness runs are retained:
a trigger experiment collided with background writes, and Deno section creation
did not accept a NUL-bearing workspace alias. Neither is counted as a pass.
No trigger rollback, GUI appearance, section creation, whole-daemon SQL absence
or held-writer latency claim is made. Unit tests retain the existing section
and authorization contracts.

The main connection records project, hierarchy and workspace SQL only while
move requests run. Fixture creation and public snapshot reads are excluded.
Fixed runs require zero target SQL, with each admitted command sent to the
writer as one transaction. Notification runs after the gateway completes.
Command duration and argument/reply sizes are retained; they do not separately
attribute clone, queue and SQL costs.

The evidence binding checks one committed application tree for both fixed
runtime proofs, successful cleanup receipts and helper blobs. Only this
journey and its evidence folder may change afterward. Source, test or helper
changes require a new committed proof head and fresh runtime proofs.
