# Coding target selection through the DB gateway

Use shared isolation and the resource guard in SKILL.md; run heavy jobs serially.

```sh
python3 .claude/skills/verify/lane-a-stage-target-db-run.py bun before
python3 .claude/skills/verify/lane-a-stage-target-db-run.py bun verify
python3 .claude/skills/verify/lane-a-stage-target-db-run.py deno verify --executable "$DENO"
```

DENO names an existing runtime with cached imports. Every run owns fresh synthetic
HOME/data/TMPDIR and an ephemeral non-8399 daemon. HTTP is refused and gh is a
refusing stub. The runner retains evidence and deletes temporary daemon data after
shutdown. Before mode restores the old selector/assignment files from origin/dev
and restores the draft in finally; do not edit concurrently. Commit the guarded
main regression before production changes.

Real neo.coding.write.plan WebSocket RPCs select default and preferred targets,
explain unavailable preferences and retain the same selection after restart.
Human preference RPCs save all nine Write/Review/Verify settings with their
provenance. Invalid setting values are refused; unanswered repositories retain
their first candidate without saving defaults. Filter assertions to target-stage
settings because unrelated bookkeeping preferences may exist at startup.

During plan RPCs, instrument preference/alias SQL on the main connection,
excluding setting RPCs, fixtures and assertions. Baseline requires target SQL;
fixed runs require zero. The complete preference lookup and selection decision
runs in one dedicated read-only gateway command. Review/Verify assignment also
awaits that shared command before external actor creation; existing actor tests
retain fallback, provenance and target-selection contracts. This journey does
not claim real actor dispatch or absence of other assignment admission SQL.

The initial harness attempt failed because it expected every preference to be
absent at startup; that failure is retained, not counted as a SQL regression.
The corrected regression reaches the main-SQL assertion after all behaviour
checks. No provider, credentials, model, GUI, actual GitHub, complete-daemon SQL
absence or latency target is verified. Command duration and argument/reply sizes
are recorded without separate queue, SQL or cloning attribution.

Bind both successful runtime proofs to the committed application/helper tree:

```sh
bun --no-install --no-env-file .claude/skills/verify/lane-a-stage-target-proof-binding.ts HEAD
```

Only this journey and its evidence directory may change after the bound proof
commit. Other source, test or helper changes require fresh committed proofs.

The reader proof also holds a synthetic writer lock during a real Write-plan
RPC. The reader must return the preferred configuration before lock release.
The CI actor tests structured-clone gateway replies and make the selector
connection query-only for its snapshot. An unsupported default configuration
must be attempted once without persisting an assignment. Temporarily restoring
reference comparison or write mode makes all four new default cases fail.
The initial broad read-only fixture also blocked unrelated legacy bookkeeping;
that attempt is retained, not counted as a selector regression. Query-only is
now scoped to the selector command.
