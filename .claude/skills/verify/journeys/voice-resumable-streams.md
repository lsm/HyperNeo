# Resume a voice recording after a dropped connection

Run from the worktree root using the shared isolated proof setup:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/new/evidence .claude/skills/verify/voice-resumable-streams.ts verify
```

The helper starts only its own source daemon, a fresh HOME/database, GitHub stub
and an ephemeral Deepgram-protocol ASR fake. No phone, provider credentials or
live daemon is involved. It uses public WebSocket RPC, terminates the synthetic
phone connection with code 1006, reconnects, resumes the same stream, resends a
fully duplicated chunk and a partially overlapping chunk, then stops.

Require one complete final transcript, exactly the original unique PCM samples
at ASR, and one final event routed to the reconnected client. First, the helper
also checks the legacy no-offset/no-resume path. It then disconnects another
stream and waits 121 seconds: its ASR socket must close without any further RPC,
and resume must return VOICE_STREAM_NOT_FOUND. The wait exercises the real grace
timer; the unit suite separately checks exact boundaries and device isolation.

Evidence: voice-resumable.json, daemon.log and run-status.json. Only synthetic
sample numbers and outcome metadata are retained; temporary data is removed by
the shared wrapper. `quick` instead of `verify` skips the real-time expiry check
and must not be reported as full grace-period verification. This proves the
daemon protocol, not phone audio capture or a production network.
