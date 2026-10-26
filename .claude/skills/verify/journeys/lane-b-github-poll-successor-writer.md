# Recurring GitHub poll successor admission

Run `lane-b-github-poll-successor-writer.ts` with Bun and Deno in a fresh synthetic
run under env -i, NODE_ENV=test, HOME=<run>/home and HYPERNEO_DATA_DIR=<run>/data.
It owns an ephemeral non-8399 daemon and loopback HTTP poll stub, restores its
own startup observer and stops/drains the owned processors before seeding.
No credentials, provider turns, real GitHub, UI or live daemon are involved.

Register the production poll handler on a real processor using the daemon writer.
Seed a due poll job. Its main-thread polling-service fixture calls the owned HTTP
stub, then successor admission must complete through a worker while main denies
all SQL from the target handler and command. The job must finish polled=true with
one durable pending successor whose run_at matches the result. A repeat must
retain that successor unchanged; a disabled interval must not schedule another.
Real health RPCs bracket the path. Baseline evidence must fail on forbidden SQL;
fixed Bun/Deno evidence must record zero target main SQL and a completed job.

Focused tests cover concurrent pending-only admission, held receipts, unavailable
writers, receipt rollback and triggerPoll failures. Save
evidence/github-poll-successor-writer.json before removing owned temporary data.
GitHubService startup/settings refresh, real GitHub API behavior, UI, worker death,
contention and large-queue latency remain outside this proof.
