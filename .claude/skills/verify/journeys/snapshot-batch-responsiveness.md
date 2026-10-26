## Snapshot batch responsiveness

```bash
RUN=$(mktemp -d /private/tmp/hn-snapshot-batch-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/neo-snapshot-batch.ts verify 9382 "$RUN"
```

This starts a fresh isolated daemon with 181 synthetic asks. Its top 50 contain
231 todos and 66 answered questions, with instruction/report sizes shaped like
the observed snapshot. An external client sends four overlapping `neo.snapshot`
requests over the real `operation.invoke` WebSocket door. Another independent
client probes `system.health` when the first child/link query begins. No model,
provider keys, credentials, copied live rows, GitHub or GUI are involved.

The helper injects a controlled 4 ms wait per child/link statement to model the
amplification of slow reads. On regression commit `6040b602e6`, `reproduce`
records four builds and 1,324 child/link reads, max lag above 1 s and a health
reply above 1 s. Fixed `verify` requires one build, three child/link queries,
max lag below 1 s and health below 250 ms. Each of the four replies must retain
50 asks, 231 todos and the exact selected session link. Summary RPC cards omit
the 66 answered questions; they remain available through neo.ask.read.

`observed.json` records query/build counts, max main-loop lag, independent health
latency, burst duration and reply byte sizes. Other snapshot/pack reads remain
included in the separate total-read count; this change does not claim every
snapshot query is constant or explain the physical cause of historical waits.
The helper restores its synthetic query observer and closes both client child
processes, the timer and daemon in `finally`.

Focused contracts also exercise eight overlapping reads, later-write freshness,
scope isolation, per-request revision responses, failed-build recovery, RPC/MCP
view separation and admission, child ordering and missing links. In-flight RPC
builds share only the same requested scope until synchronous construction ends;
there is no retained snapshot cache. MCP reads keep their existing per-turn
handling. `neo.open` must still reply before deferred work discovery starts.
