# Nonfatal degraded GitHub poll admission at startup

Run lane-c-github-poll-startup-degraded.ts in a fresh synthetic Bun/Deno daemon
under env -i, NODE_ENV=test and disposable HOME/data. It asserts data-dir isolation,
stubs the provider auth gate in memory, disables model discovery and refuses
external HTTP. A synthetic token is placed only on the owned GitHubService fixture;
no provider or GitHub credential enters the environment or a real store.

Reject the first real startup poll writer request. Actual createDaemonApp must
resolve with pollRefreshDegraded=true, one logged admission failure and no poll
job. Hold only the service's retry timeout as a controlled test clock, recording
its configured next-poll delay. Health RPC must work before recovery. Stop/drain
the owned processors, advance that single poll tick, then require one durable
initial job, cleared degradation and two admission attempts. Tick the daemon's
registered processor: the empty synthetic poll completes successfully. Main
refuses target job SQL during recovery. This proves startup does not reject on
this failure path; general partial-startup cleanup remains separate issue #8956.

Save evidence/github-poll-startup-degraded.json before removing owned data. If
startup rejects, save its error and terminate only the proof process so the parent
wrapper can remove its orphaned synthetic resources. Unit tests cover the failing
baseline, repeated failures, stop cancellation, in-flight rejection after stop and
unknown committed receipts rechecked without replacing the existing job. Real
provider authentication, GitHub, UI, worker death and contention are unverified.
