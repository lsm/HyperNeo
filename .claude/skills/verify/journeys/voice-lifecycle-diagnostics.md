# Voice lifecycle diagnostics through the public RPC door

Run from the worktree root with a fresh absolute run directory and two free ports:

```bash
bash .claude/skills/verify/voice-diagnostics.sh "$RUN" 9427 9428
```

The helper uses NODE_ENV=test, env -i, its own HOME/data directory/DB, loopback
binding, a gh stub and a local fake ASR. No provider keys, real ai0 endpoint,
real phone, real recording or port 8399 is used. It stops its daemon on exit;
the fake ASR runs inside the proof process and stops in finally.

The proof drives the same voice RPC methods as a client: successful streaming;
forced mid-stream ASR close (1011); batch fallback; unreachable ASR in auto mode;
refused streaming-only start; and a client close (1001) during an active stream.
It asserts the persisted structured JSONL file, not just an in-memory logger.
End state: evidence/voice-diagnostics.json records the stream ids, exactly two
fake batch calls, and matching lifecycle events with bytes, audio duration,
elapsed time, classified fallback reasons, client ids and close codes.

Diagnostics are metadata only and remain available to the structured sink even
when console info logging is disabled. Raw peer close/error text and endpoint
query/userinfo are omitted because they can contain transcript or credentials;
close codes have classified reasons plus the peer reason byte count, socket
errors have allowlisted system codes. The proof injects PRIVATE_ markers in
transcript, close reasons and URL query and requires none in the new events.
PCM bytes count excludes the WAV header; audioDurationMs assumes 16-kHz mono
PCM16. durationMs is elapsed stream lifetime; stopDurationMs is stop latency.
Client disconnect also records stream-close metadata before releasing buffers.

Every ASR socket close also persists one `voice.stream.end` line naming who
closed (client, server or relay), the close code and classified reason, the
peer reason byte count (a string under Bun's `ws`, a Buffer under Node — count
bytes from either), the stream duration, ms since the last audio frame sent and
the last result received, and ping/pong timing when keepalive frames were seen.
The proof asserts that line for the forced 1011 (server), the normal
CloseStream close (server) and the client disconnect (client).

This slice changes observability only: a dropped client still loses its stream,
a dropped ASR still falls back to the whole buffered recording, and batch retry
idempotency/resume are separate changes. It does not prove operation on the
human's phone, Tailscale/DERP or a real WhisperLiveKit server. No UI changed.
