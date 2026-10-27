# Tool recovery events keep client RPCs responsive

Follow SKILL.md's isolation, resource and cleanup setup with pinned Bun 1.4.2.
No provider, model, real data, GUI or simulator is involved.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/tool-recovery-writer.ts
```

The helper creates a manual session through real session.create RPC, publishes
SDK tool-created/consumed events to the daemon's actual runtime subscriber, and
checks durable active/consumed state after publication completes. It then expires
a second synthetic tool through the real runtime tick and checks expired state.
An independent child probes system.health over WebSocket throughout the events.
A 1.2-second modeled native wait is applied to the first recovery INSERT wherever
it runs. All observed recovery writes must execute on the DB worker; health must
stay below 250 ms. The committed baseline delays health about 1,208 ms and records
main-thread writes. observed.json and recovery-sql.jsonl retain event receipts,
SQL thread attribution and health samples. A missing subscriber, failed event,
missing insert, wrong durable state or main write fails the proof.

The helper uses real runtime subscriptions with synthetic SDK events; it does
not run a model tool or reproduce production physical-lock ownership. Concurrent
client health is the observable responsiveness surface. Preserve the repository
and tick-loop tests for expiry, inbox retention and restart/rebind behavior.
The shared wrapper saves evidence and deletes synthetic data after cleanup.

Run the same helper with `whitespace` before the final run-directory argument
(the wrapper supplies that directory) in a separate fresh evidence directory:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/padded-evidence .claude/skills/verify/tool-recovery-writer.ts whitespace
```

This mode adds a leading newline and spaces to actual recovery SQL before it
reaches SQLite. Both modes must identify the INSERT after trimming and record
exactly one 1200 ms wait, with measured elapsed wait at least 1100 ms. Otherwise
the proof fails even if health is fast. The unpadded repository query starts
with INSERT already; the padded case guards formatting changes in this helper.

The helper sets `disableWorktrees` inside daemon Config and stops the job
processor before creating the manual session, following SKILL.md. It does not
rely on the unused `disableGoalProcessing` setting.
