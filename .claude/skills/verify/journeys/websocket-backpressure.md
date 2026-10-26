# A slow WebSocket client drains without a full resync

Use the shared resource check, isolation and cleanup rules in SKILL.md. No
provider, model mock, real database or live daemon is needed. This proof runs
the daemon's real Bun server adapter, WebSocket handlers, router and transport
on an ephemeral loopback port. A raw WebSocket client pauses reads for 500 ms
while the router broadcasts 384 ordered synthetic events of about 64 KiB each.

```bash
TMPDIR="$PWD" bash .claude/skills/verify/proof-run.sh \
  "$PWD/.proof-websocket-fixed" .claude/skills/verify/websocket-backpressure.ts verify
```

The client must receive every event exactly once in order, with zero runtime
drops and zero resync closes. `backpressure.json` records count, size, delivery,
drops, resyncs and maximum Bun buffered bytes. The same helper's `baseline` mode
expects a runtime drop on the unfixed transport. It previously delivered only
20/384 events, dropped once, requested one resync, and buffered 16,820,817 bytes.
The final fixed run delivered 384/384, with zero drops/resyncs and 50,232 maximum
Bun buffered bytes. Its application queue peaked at 375 frames (less than
24,613,500 bytes), within the configured bound. OS socket buffering can vary.

The application queue is bounded to 1,000 frames and 32 MiB per client. A full
queue closes once rather than silently skipping an event. Bun's `-1` frame is
already accepted and must never be retried. Later frames wait for drain.
Broadcast admission remains open so the router cannot silently skip a full
queue; the send path owns overflow admission and requests a resync if needed.

`client.websocket.pressure` diagnostics record reason (`backpressure`,
`queue_overflow`, `runtime_overflow`, or `socket_closing`), envelope type/method,
UTF-8 message size, buffered bytes, queue bytes/count, socket state and offered
per-client message/byte rates over the current up-to-one-second window. No
message bodies are logged. Closing sockets do not request another resync.

This proves the socket delivery surface used by web and phone; it does not
exercise browser layout or claim the synthetic burst identifies the actual
live overflowing message. After deployment, inspect the structured diagnostics
and drop logs read-only over 20 minutes and record the served build. Never
restart or mutate the live daemon.
