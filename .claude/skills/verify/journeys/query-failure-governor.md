# Worker query failure governor (#9093 B)

Use SKILL.md resource checks and one heavy job at a time. No HTTP model or port
8000 preflight is needed. This helper uses a scripted SDK whose query start throws
an arbitrary fake error, an ephemeral real daemon and real session/message RPCs.
Its provider credential exists only in the fresh synthetic DB. External HTTP is
refused. Never use the live daemon, real DB, port 8399 or credential files.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/query-failure-governor.ts after
```

For a baseline, use before against the pre-fix query runner and queue, retaining
that evidence separately. Five identical query-start throws demonstrate the
one-second parked retry loop: the queue discarded the original error as a user
interruption. Restore the fixed source before final verification.

Pass requires the real message.send path to start exactly three failing queries,
with at least one and two seconds of backoff. session.get must expose the failed
episode and original error; the synthetic DB metadata must match that public
read. Further automatic work must not start the SDK. Explicit session.resetQuery
must create a fresh episode; after fixing only the scripted cause, a new message
must succeed and clear its failure count. This proof uses the actual governor,
not the isolated retry-routing fixture used in the existing QueryRunner suite.

The focused query-failure-episode tests check restore across governor instances,
changed error messages within one budget, stale failure after explicit reset,
and a preparation promise that never resolves. The query-runner characterization
suite isolates the new governor while preserving existing retry-route decisions;
it does not independently prove the new budget. Run both plus the repository
check. Follow up with a real options-build timeout and late-completion check.

Keep query-failure-governor.json, proof.log and run-status.json. Require wrapper
exit zero. The helper closes its scripted query, WebSocket and daemon in finally;
the wrapper saves evidence and removes temporary HOME/data immediately.

The durable HyperNeo work.status/Neo-wake projection is independently owned by
#9095. Its integration seam is persisted metadata.queryFailureEpisode and the
cap's session.error details.metadata.queryFailureEpisode. Record that consumer's
verification separately; a public failed episode is not proof of a Neo wake.
Scratch remediation belongs to the parallel #9093 A owner. After merge, confirm
the served daemon build contains the squash; never restart it. If rollout is
pending, retain that applicable deployment gate as pending with the observed
build and owner reason.
