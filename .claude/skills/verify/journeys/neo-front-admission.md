# Fresh Front session admission

Run `neo-front-admission.ts` through `proof-run.sh` with pinned Bun and the
checkout head as its argument. The helper owns a synthetic HOME, database and
random daemon port. It stops job processing before seeding its root session and
model catalog. No provider turn runs.

Enable dual mode through authenticated `neo.front.set` on a fresh database.
Require the real session lifecycle to create Front, its working directory to
exist, its catalog selection to be empty and automatic Exa tools to be excluded.
Submit a human input through `neo.message.send` and require one Front job.
Enabling again must preserve the original Front session's creation time.

Retain `observed.json`, the proof log and wrapper exit status. Require passed and
resourcesClosed true and exit 0. The wrapper removes the isolated daemon data.
