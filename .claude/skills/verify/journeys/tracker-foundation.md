# Tracker mirror service sweep

Run with Bun 1.4.2 from the repository root.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/tracker-foundation.ts
```

The helper owns its HOME, DB and successive daemons on ephemeral ports. It uses a
synthetic tracker and no provider. It invokes the service sweep, kills the first
daemon after external create but before binding, then recovers through marker
lookup. It prints createCount=1 for the recovered parent and recoveryExit=0.

Later sweeps create a late child, persist its link, close a completed child once,
and leave that closed mirror alone when its todo becomes active again. A settled
ask closes active and failed children as not_planned before closing its parent.
A failing child stops after three closes and its parent then closes. Retain
observed.json, recovery.json and retry-cap.json. The wrapper removes its temporary data.

A real 30-second create timeout records one failure, then marker lookup recovers
the created item on the next sweep. Capped settled history is excluded from facts.
Retain timeout.json alongside the recovery evidence.
