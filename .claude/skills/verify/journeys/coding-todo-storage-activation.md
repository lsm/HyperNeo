# Activate coding todo repository storage

Follow SKILL.md's pinned runtime, resource guard and disposable wrapper:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-todo-storage-activation.ts
```

The previous Build journey is superseded: current runtime constructors uniformly
use the pack adapter. The shared schema extension must prepare/backfill before
any reader, including fresh gateway repositories. No reader performs preparation.

Seed only synthetic legacy rows, never a copy of real data. The seed re-adds the
legacy `neo_todos.repo` column and clears migration 492's marker. Boot the actual
daemon over that isolated pre-cutover fixture. Migration 492 must copy those
values into pack storage and drop the column before the first read; historical null rows with zero or several sibling repositories retain the
ask fallback without invented pack records. Public MCP additions write only the
pack fact; new drafts inherit one distinct sibling repository, never guess from
multiple repositories, and an own place never inherits (unit matrix).

Drive actual add/edit and Work-card RPCs plus independent registered reader,
planner, settlement, session and runner commands. Their repo values must agree.
Watch inventory must follow the canonical fact.
A late pack failure must roll back public add, ask timestamp and notifications.
Hold a WAL lock against the registered add-writer command: no receipt or
notification may precede commit while card and
health reads answer. A pack-only fact update must publish `neo.changed` after the fact commits.
A canonical null must survive repeat
preparation and a full isolated daemon reopen.

Retain `coding-todo-storage-activation.json`, proof.log and wrapper status. The
helper closes both daemons/transports; the wrapper removes its fresh HOME/data.
Run storage/cutover tests, the existing repository-policy journey and full check.
The storage unit fixtures explicitly inject an identity adapter only when seeding
legacy data; no runtime call site opts out. Nested preparation rollback remains
pinned in those units. This does not prove a deployed migration or GUI layout.
