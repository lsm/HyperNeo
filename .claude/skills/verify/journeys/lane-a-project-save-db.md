# Project create/update commands on the DB writer

Use shared isolation/resource guards from SKILL.md; heavy jobs run serially.

```sh
python3 .claude/skills/verify/lane-a-project-save-db-run.py bun verify
python3 .claude/skills/verify/lane-a-project-save-db-run.py deno verify --executable "$DENO"
```

DENO is an existing cached runtime. Each run owns fresh HOME/data/TMPDIR and an
ephemeral non-8399 daemon. HTTP is refused; gh is a refusing stub. No provider,
credentials, GitHub, real data, GUI or simulator is used. The helper owns a Python
child holding only its synthetic WAL writer for 1.2 seconds, waits for it and
removes all temporary daemon data after preserving evidence. Both modes run the
checked-out code; reproduce the baseline from the regression commit.

Real public project.save RPC creates a project while that writer is held. The
baseline blocks the daemon loop above one second; the fixed route keeps it below
one second and system.health's actual sent-request latency below 250ms. Record
client dispatch delay separately because this helper and daemon share a process.
The affected save still waits for the writer and exceeds 250ms; this is not a
complete latency pass or physical-storage attribution. Gateway duration/JSON
sizes do not separate queue, SQL, clone or encoding costs; RSS/WAL are unmeasured.

Independent human creates get distinct ids. Concurrent revision updates admit
one winner; named creates/unnamed updates are refused. Full Unicode context hash
is retained, snapshots show the winning title and restart keeps it. Bound Neo
MCP saves are admitted, unbound sessions are refused, and a binding removed
before queued command admission cannot mutate the project. Caller admission,
identity/retry lookup and revision write stay in one synchronous worker command;
notification happens after commit. No alias identity, Home reservation or core
ask/card-reply mutation is exercised.

Instrument concern/binding SQL on main during saves only; fixtures, snapshot and
health assertions are excluded. Fixed runs require zero target SQL. Preserve
failed evidence and commit it before implementation. Bind final runtime runs to
one committed application/helper tree; afterward only this journey and its
evidence directory may change.

```sh
bun --no-install --no-env-file .claude/skills/verify/lane-a-project-save-proof-binding.ts HEAD
```
