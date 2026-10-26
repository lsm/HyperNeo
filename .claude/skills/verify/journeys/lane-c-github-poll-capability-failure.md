# Polling capability sync after rejected job bookkeeping

Run lane-c-github-poll-capability-failure.ts using the isolated proof wrapper,
NODE_ENV=test and disposable HOME/data. It uses the actual app settings subscriber
and real settings.global.update RPC, with the same in-memory auth gate, empty
model discovery and refused external HTTP as the settings retry journey. No live
daemon, real credentials, provider turn or GitHub access is involved.

Start with polling capability enabled. Reject the first settings-driven job
writer request while committing githubPollingInterval=0 over RPC. Read only the
owned synthetic capability row and observe the real extension's interval-refresh
method. Job admission failure must leave its pending job intact and must not
suppress capability=false or the extension interval update. Then repeat the same
setting to recover job bookkeeping, preserving the successful-only memo and no
immediate replay behavior. All target job SQL remains forbidden on main.

Baseline evidence records persisted interval zero, polling capability still true
and zero extension refreshes. Save evidence/github-poll-capability-failure.json
before deleting the owned run. This does not authorize serving-daemon mutation or
prove real authentication, GitHub, UI, worker death or contention.
