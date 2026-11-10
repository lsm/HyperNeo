# Reserve an idle daemon restart

Run `bash .claude/skills/verify/proof-run.sh <fresh-evidence-directory> .claude/skills/verify/deploy-wait.ts`
on the authorized build host with the pinned Bun runtime. The wrapper supplies an empty HOME,
NODE_ENV=test and disposable data. The daemon chooses a random loopback port and the journey
refuses the production ports. External fetches are refused.

The authenticated CLI must refuse a reservation during an open microphone stream, an audio
listener between captures, queued or playing speech, and a busy Neo turn. A terminal speech ack
and a text-only listener permit one fake restart. When reservation wins the race, voice starts
and listens return updating and a real queued input stays durably enqueued until expiration.
The unit regressions also cover unavailable state, expiration and session-socket authorization.

Require `passed: true`, seven cases, one fake restart and a zero wrapper exit. The journey closes
its socket and daemon in finally. The coordinator's bounded wait and real deployment are the
subsequent rollout step after this command is live.
