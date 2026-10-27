# A voice stream's ASR socket keeps breathing while the daemon's main loop stalls

The voice stream relay runs its ASR WebSocket on a dedicated worker thread,
so seconds-long SQL on the daemon's main event loop must not freeze the
transcription connection mid-utterance. Before the fix the relay shared the
main loop: during a 2 s stall the ASR server saw pong gaps of ~2.2 s followed
by a burst of queued replies, the exact freeze that made live drafts jerk and
sends fail on a busy daemon (#9070).

This proof runs the real `VoiceStream` with its default threaded relay and a
stub ASR server in a separate child process. The child pings every 300 ms and
records pong gaps while the parent busy-waits its own main thread for 2 s.
The parent then asserts the stream stayed responsive the whole time.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/voice-relay-stall-proof.ts
```

No daemon, database or provider is involved; the helper owns both processes
and exits 2 with the recorded gaps in `evidence/voice-relay-stall.json` when
the largest pong gap reaches 1 s. The unfixed relay measured a 2,202 ms gap
over the same stall; the fixed relay stays near the 300 ms ping interval.
The shared wrapper saves evidence and removes the disposable run directory.
The helper closes its relay and stops and waits for its exact ASR child in
finally, including failures. A streaming route and recorded pongs are required;
no measurements is a failed proof.
