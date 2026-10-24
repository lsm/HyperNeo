# Hung SDK startups cannot starve root Neo

Set `PROOF=.claude/skills/verify/sdk-startup-gate.ts` and follow the **In-process
RPC proofs** setup in SKILL.md, adding
`HYPERNEO_SDK_STARTUP_MAX_HOLD_MS=10000` to the isolated environment. Ports 8000 and 8001 must be free. The helper
uses an ephemeral daemon port, a fresh synthetic HOME/data/DB, and the local
mock model; no real provider credentials or live daemon access.

Through RPC, create three synthetic worker sessions. Inject unresolved provider
environment preparation after admission in two sessions; the third runs a silent
subprocess that never emits its first SDK message. Open root Neo and enqueue a
human input through `neo.message.send`. Confirm it waits behind all three workers,
then completes a successful SDK result within 60 seconds without a restart,
interrupt, or additional input. The overridden 10-second permit lease must expire
independently of both provider preparation and the SDK inactivity timer. The
production default is 60 seconds (the slow-start nudge threshold); operators may
increase it for healthy slower cold starts.

`$RUN/evidence/sdk-startup-gate.json` records the worker session IDs, injected hang
phases, root ID, queue snapshot, completion time, and warning-level holder/wait/
expiry logs. `$RUN/daemon.log` retains the isolated run's diagnostics. Cleanup
unblocks only synthetic provider calls and stops the helper's daemon and model.

This proves recovery of queued input when unrelated startups hang. It does not
recover historical holder identities from missing production logs, exercise a
real provider, or establish post-deploy behavior of the laptop's root. Neo owns
that final observation after the approved manual merge and deployment. Browser
rendering is not exercised by this backend-only journey.
