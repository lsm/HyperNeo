# Resume a voice recording after a dropped connection

Run from the worktree root using the shared isolated proof setup:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/new/evidence .claude/skills/verify/voice-resumable-streams.ts verify
```

The helper starts only its own source daemon, a fresh HOME/database, GitHub stub
and an ephemeral Deepgram-protocol ASR fake. No phone, provider credentials or
live daemon is involved. Through public RPC and HTTP it creates and redeems a
synthetic pairing code; the resulting secret stays in memory. A reconnect uses
that same device credential. The helper terminates its synthetic phone socket
with code 1006, resumes the stream, replays full and partial overlaps, then stops.

Require exactly the original unique PCM samples at ASR, one complete transcript
and one final event routed to the rebound connection. First the helper checks
unpaired legacy append/stop. It then checks nine paired legacy reconnect/start
cycles without offset or resume: the ninth succeeds and superseded ASR sockets
retire. Unit contracts protect live/other-device capacity, a start/resume race
and audio retained when a replacement fails.

A separate unpaired connection must fail to take over an unpaired stream after
its client disconnects. Start must advertise `resumable:false` for that stream.
Unit contracts also reject the takeover while the original client is connected
and cover nine unpaired legacy reconnects. Synthetic pairing secrets must be
absent from retained evidence.

Finally disconnect another paired stream. Its ASR socket must still be open at
119 seconds, close by the check at 121 seconds without another RPC, and resume
must return VOICE_STREAM_NOT_FOUND. This exercises the real grace timer; unit
contracts separately pin its exact boundaries.

Evidence: voice-resumable.json, daemon.log and run-status.json. Only synthetic
sample numbers and outcome metadata are retained; the shared wrapper removes
temporary data. `quick` instead of `verify` skips the real-time expiry check and
must not be reported as full grace verification. This proves the daemon's
protocol and real pairing path, not physical-phone audio or a production network.
