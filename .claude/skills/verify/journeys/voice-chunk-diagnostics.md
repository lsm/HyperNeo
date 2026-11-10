# Stream receipt and decode diagnostics

Run the isolated daemon and synthetic ASR proof with the pinned Bun runtime.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence .claude/skills/verify/voice-chunk-diagnostics.ts
```

The proof sends PCM through the public chunk RPC, leaves a gap over one second,
and cancels. It checks the persisted close record before buffer clearing. It then
streams synthetic Opus through the real decoder and checks the per-chunk numeric
codec, receive sequence, wire offset, payload bytes and decode duration. The PCM
scenario drops a send attempt and replays a byte range, joining phone attempts
to daemon arrivals by stream and byte range despite shifted ordinal sequences. Receipt totals include replay bytes while
resume offsets retain their existing unique-byte semantics.

Require close records for both streams, five decode records, one late record, numeric new
measurements, no endpoint or transcript marker, and daemon exit 0. The wrapper
owns a fresh HOME/data/DB, scrubs the environment, retains proof logs and removes
temporary data. The owner credential belongs only to that fresh test daemon.
