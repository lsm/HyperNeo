# Rejected startup releases acquired daemon resources

Use the shared metadata-only setup in `../SKILL.md`. Run:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/daemon-startup-failure.ts
```

The helper starts actual isolated daemons on ephemeral loopback ports with
synthetic databases and no providers, credentials or external HTTP. It injects
the same startup rejection immediately after bind and after processors start.
It also injects a throwing file-index disposer and a stalled session cleanup.
For each, the original rejection must survive, the listening port must be
reusable, the database must be closed and its lock gone, and started processors
must report no polling. The helper records observations before its own fallback
cleanup. Its child exits after saving evidence so a failing baseline cannot leave
its leaked background resources in the test runner.

Resource draining has a shared five-second asynchronous wait budget; database
finalization gets a separate five-second budget so stalled services cannot use
its deadline. Every remaining disposer is still attempted. The stalled-service
case verifies port/database/lock release and preservation of the startup error;
it does not certify termination of an arbitrarily non-cooperative service.

Inspect `startup-failure.json`: all four cases must pass and `verified` must be true.
Keep the failed baseline and passing result separately. The wrapper removes
owned temporary HOME/data/TMPDIR after saving evidence. No GUI, model turn,
real GitHub request, live database or port 8399 is used.
