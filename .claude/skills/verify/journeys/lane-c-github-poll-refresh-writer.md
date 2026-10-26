# GitHub poll refresh through the writer

Run lane-c-github-poll-refresh-writer.ts with Bun and Deno in a fresh synthetic
run under env -i, NODE_ENV=test, disposable HOME and data directory. It owns an
ephemeral daemon, stops and drains all owned processors and defers unrelated jobs.
No provider key, real credential, native agent, real GitHub or HTTP mock is used.
A production GitHubService uses the daemon DB/processor with an injected empty
page collector; its token is a synthetic transport marker in memory only.

Forbid job_queue SQL from the service/refresh-command stack on main. Starting the
service must admit one due job; concurrent ordinary refreshes retain it unchanged.
Run its actual registered poll job: it completes and retains one future successor.
The real settings.global.update RPC persists interval changes, with an explicitly
owned test subscription bridging settings.updated to the production service.
Changing the interval replaces the pending successor with a due job. Disabling
polling deletes only pending poll jobs, retains a processing claim and unrelated
queue, and stops the runtime service. Re-enabling retains the processing claim
and admits no duplicate. Health RPCs bracket the path. The original daemon's
credential-gated GitHub service is absent in this fixture; production credential
bootstrap and its app subscription are not exercised.

The baseline must fail with forbidden main SQL and no initial job. Save
evidence/github-poll-refresh-writer.json before deleting the owned run.
Focused tests cover transactional deletion/admission rollback, pending-only limits,
receipt waiting, lost receipts, missing queues/processors and concurrent refresh.
Real GitHub, provider auth, UI, worker death and contention remain unverified.
