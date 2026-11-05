# Turn embedding writes keep the daemon responsive

Use SKILL.md's shared isolation, resource check and cleanup. No model, real DB,
provider, simulator or GUI is involved. Run with pinned Bun 1.4.2:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/turn-vector-reader.ts 1200 writer
```

The helper drives the real app-wired work.turns.embed job and probes system.health
through a separate process's real WebSocket. It models a 1.2-second native storage
wait on the first message_search_vectors INSERT, on whichever thread executes it.
The baseline committed before the fix blocks main and health for about 1,205 ms.
Fixed code must finish the job, retain all source bodies and preexisting vectors,
save exact new vectors in fresh-before-backfill order, and report no pending work.
Every intercepted insert must run on the DB writer, main lag must stay below one
second and independent health replies below 250 ms. observed.json and
range-reads.jsonl retain the measurements (the shared log filename covers writes
in writer mode). A worker import/boot failure, missing writes or incomplete job
fails the proof. The wrapper removes owned data even on failure.

Repeat with 0 writer in a fresh evidence directory for the ordinary-data control;
that run additionally requires job completion below 250 ms. The wait models a
storage stall; it does not identify the historical production lock holder or
prove physical-disk behavior. The delayed job itself still takes over 1.2 seconds.
Phone voice reliability and deployment remain separate live acceptance checks.
