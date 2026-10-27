# Section creation on the DB writer

Use the shared isolation and resource guard in SKILL.md. Run heavy jobs serially.

```sh
python3 .claude/skills/verify/neo-project-section-db-run.py bun before
python3 .claude/skills/verify/neo-project-section-db-run.py bun verify
python3 .claude/skills/verify/neo-project-section-db-run.py deno verify --executable "$DENO"
```

DENO names an existing Deno 2.9 runtime with cached dependencies. The helper
boots a fresh synthetic daemon and invokes the real neo.project.section and
neo.snapshot WebSocket operations. Direct HTTP is refused; gh answers only the
synthetic epic GraphQL lookup. No provider, model, credentials or live data is used.
Each run owns an ephemeral non-8399 listener, HOME, DB and temporary directory;
the runner retains evidence and removes daemon data after shutdown.

The regression must be run and committed before changing production code. Before
mode restores the original operation and repository from origin/dev temporarily;
never edit these files or run another proof concurrently. Fixed mode requires
zero project/hierarchy/workspace SQL on main during section RPCs. Snapshot reads
and fixture creation are outside measurement.

Competing parents for one epic must produce exactly one section and one winner;
the other request is refused. Repeating the winning request reuses its ID. Missing
parents, malformed epic URLs and incompatible workspaces retain their refusal
reasons. The section title, revision, epic and parent are visible in the public
snapshot and survive daemon restart. Parent preflight is advisory; the writer
rechecks parent, workspace and epic ownership before inserting atomically.

Evidence records command duration and argument/reply bytes without separately
attributing clone, queue or SQL cost. No GUI, whole-daemon SQL absence, held-writer
latency or actual GitHub behavior is claimed.
