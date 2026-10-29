# Daemon-owned worker scratch

Use the shared metadata-only isolated-daemon setup in SKILL.md, with a fresh
run, HOME and HYPERNEO_DATA_DIR. No model, provider credentials or fixed mock
ports are needed. The helper starts an ephemeral non-8399 daemon and creates
only synthetic worker roots, then archives one session through actual RPC.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/daemon-owned-scratch.ts
```

Observe `daemon-owned-scratch.json`: archive removes its scratch, shutdown
removes newly daemon-owned scratch, and startup removes only an older-than-day
record with a positively dead owner. Live-owner, recent and unmarked Desktop
scratch must remain. A synthetic persisted SDK child with a live PID must also
retain scratch even after its recorded daemon owner has exited. Startup captures
SDK child records before the existing orphan-process sweep; shutdown also checks
tracked child PIDs after stopping sessions. The fixture records get a known exited child PID to model
an unclean exit; no real daemon is killed and no system-temp sweep occurs.
The outer proof wrapper exports evidence, stops owned resources and removes
only its own fresh run. Abrupt SIGKILL relies on the next startup after a day;
independent Desktop process ownership is deliberately outside this slice.

Resuming an already marked, inode-matching SDK runtime renews its daemon lease;
an unmarked or replaced directory is never adopted. Live previous daemon PIDs remain
liveness guards; positively dead ones are pruned on renewal before PID reuse.
Prior owner identities remain separate guards for recorded SDK children, and persisted SDK-child records captured before startup cleanup
also guard shutdown after a lease transfer. Focused regressions cover renewal
before a stale sweep and retention of live prior owners/SDK children.

## Startup cleanup failure

The same helper replaces only the OS-confined cleanup child's command body with
an exit-23 diagnostic for one synthetic stale lease. Observe that startup still
serves actual `system.health` RPC with status `ok`, logs the diagnostic, and
retains scratch and lease bytes unchanged. Restore the real child command and
restart: both retained paths must be reclaimed. This simulates cleanup-boundary
failure on the current OS; it does not claim a native Linux namespace failure.

## Shutdown cleanup failure

The helper fails the cleanup child for the first of two sorted shutdown leases.
Graceful shutdown must complete, close its database, remove the healthy lease,
and log the failure while retaining the failed scratch and lease unchanged.
Focused regressions simulate reuse of a dead PID after renewal and still verify
that a live child of that prior owner retains its scratch.
