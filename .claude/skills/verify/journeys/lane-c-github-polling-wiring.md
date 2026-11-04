# Public GitHub polling writer wiring

Use shared setup in `../SKILL.md`. Run `proof-run.sh` with
`lane-c-github-polling-wiring.ts` in fresh synthetic Bun and Deno daemons. The
helper registers the real Space schema, authenticates its socket using only the
fresh daemon's local credential, stubs external HTTP/gh and owns all processors,
locks and timers. No real provider, token, live daemon or reserved port is used.

The public `space.github.setPollingEnabled` RPC must fail on the baseline with
`Target GitHub SQL reached main`. After activation, require no target writes on
main, one atomic worker commit and public listConfig readback with preserved
flags, webhook-secret skip, cursor semantics, source/filter fields and times.
Snapshot/cursor errors roll back all writes. A held writer keeps acknowledgement
and notification pending while old public config and health remain responsive.
Admission rejection and an actual lost committed acknowledgement must never
replay or rebuild a saved snapshot. Notification failure keeps its known commit;
reordered receipts never overwrite a newer saved config. Auth, parameter and
interval gates precede admission. Callbacks remain unchanged for this writer
slice; their main reads stay explicitly tracked in #9438 and block #8714.

Retain `github-polling-wiring.json`, including latency/clone/RSS/WAL/loop metrics.
A deliberately held affected request is not a 250ms latency pass. Restore hooks,
close sockets/locks/processors/app and retain evidence before removing fresh data.
The wrapper's exit code is authoritative. Real GitHub, deployment, native agents,
UI, full main-thread-I/O elimination and complete transitive closure are unverified.

Run the repeatable boundary measurement before changing application code:

```bash
node .claude/skills/verify/lane-c-github-polling-wiring-measure.cjs /absolute/measurement.json
```

It verifies the seven approved full-module data hashes and records fresh owned
units and unchanged interface roots. Interface roots are pinned, not audited.
Any difference from the coordinator's recorded boundary needs reconciliation;
this measurement never grants itself a new exclusion.
