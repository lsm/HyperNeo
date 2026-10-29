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
an unmarked or replaced directory is never adopted. Previous daemon PIDs remain
liveness guards, and persisted SDK-child records captured before startup cleanup
also guard shutdown after a lease transfer. Focused regressions cover renewal
before a stale sweep and retention of live prior owners/SDK children.
