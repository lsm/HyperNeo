# Processor stale reclaim on the writer

Run `lane-b-stale-reclaim-writer.ts` with Bun and Deno in a fresh synthetic run
under env -i, NODE_ENV=test, HOME=<run>/home and HYPERNEO_DATA_DIR=<run>/data.
The helper owns an ephemeral non-8399 daemon. It observes only its own startup
processors, restores that observer and drains them before seeding. No provider,
credential discovery, model mock, UI or live daemon is involved.

Seed two stale claims in the registered fixture queue, a fresh claim there and
a stale foreign queue claim. Run the real job processor with the daemon's actual
writer gateway while the main connection refuses reclaim and jitter UPDATEs.
The old leases must be unable to heartbeat or complete reclaimed jobs; fresh
and foreign claims must stay processing. Jitter must hold redelivery until due.
After advancing only the synthetic due times, the registered handler must run
each reclaimed job once, complete it with a new token and retain its retry budget.
Real system.health RPCs bracket the job path. Baseline evidence must fail with
forbidden main SQL; Bun/Deno fixed evidence must show zero target main writes.

Save evidence/stale-reclaim-writer.json before deleting owned temporary data.
Focused tests additionally cover the stale-token reschedule race, abort ordering,
shutdown drain and unavailable writer behavior. This does not verify the separate
app shutdown requeue callback, real worker death, UI, contention or large-job latency.
