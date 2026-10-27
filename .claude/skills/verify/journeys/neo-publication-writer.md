# Publication delivery remains responsive while SQLite is busy

Use the metadata-only shared setup in SKILL.md. The helper owns a fresh HOME,
file-backed daemon, refusing GitHub stub and a competing native SQLite writer.
It uses an ephemeral daemon port, no model/provider and no port 8399.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/neo-publication-writer.ts verify
```

The actual agent MCP door publishes complete text while another process holds
BEGIN IMMEDIATE for 1500 ms. That process independently probes system.health.
The publication must return a durable receipt and unchanged complete text;
retrying its request ID must return the same sequence, with one stored row.
Main publication INSERT preparation is forbidden. Health must remain below
250 ms with multiple replies during the lock. The write itself can take the
lock duration: this proves main-loop availability, not faster storage.

On the tests-first commit run baseline in another fresh evidence directory.
It must fail the no-main-write assertion and record the blocked health request.
The helper closes its child/socket/daemon in finally. The shared wrapper saves
observed.json/proof.log then deletes all synthetic data. Unit publisher contracts
also require notification after persistence and no notification on writer error.

This cut covers neo.publication.publish. Scheduler idle-notice publication writes,
publication edits, feed/index/job writes and other main SQL are unchanged.
It does not prove all release-window stalls are removed. Post-deploy evidence
must use read-only build metadata and structured logs; never restart or trigger
the live daemon to manufacture proof.
