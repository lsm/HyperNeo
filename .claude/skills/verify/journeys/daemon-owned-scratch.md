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
scratch must remain. The fixture records get a known exited child PID to model
an unclean exit; no real daemon is killed and no system-temp sweep occurs.
The outer proof wrapper exports evidence, stops owned resources and removes
only its own fresh run. Abrupt SIGKILL relies on the next startup after a day;
independent Desktop process ownership is deliberately outside this slice.
