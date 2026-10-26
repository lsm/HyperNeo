# Skill validation admission through the writer

Run lane-c-skill-validation-enqueue-writer.ts with Bun and Deno in a fresh synthetic
run under env -i, NODE_ENV=test, disposable HOME/data and an ephemeral daemon port.
The helper stops/drains only its owned processors and defers unrelated jobs.
No model, credentials, native agent, remote skill install, GitHub or UI is involved.
The plugin fixture is a readable directory inside the owned run.

Refuse all job_queue insertion SQL on the main connection. The real skill.create
RPC must persist a disabled synthetic plugin skill and return only after its
validation job is durable. Tick the actual registered processor; the handler
checks the owned directory and commits valid status. A metadata-only skill.update
RPC observes valid status without enqueueing. Updating config through RPC must
admit another job and expose pending, then validate successfully. A trigger rejects
a later job insert: RPC must fail without another job, preserving the existing
registry-before-admission ordering. Health RPCs bracket the path. Baseline evidence
must show forbidden main insertion and no validation job; fixed proofs must show
zero main inserts and two completed validation jobs.

Save evidence/skill-validation-enqueue-writer.json before removing the owned run.
Focused tests cover receipt waiting, config-only scheduling, no-queue mode,
rollback, unavailable writers and lost replies without main replay. Real plugin
execution, remote installs, provider auth, UI, worker death and contention remain
unverified; registry reads and other skill persistence are outside this slice.
