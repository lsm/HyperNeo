# Live dictation keeps several chunks in flight over a slow link

Follow the Verify skill for the pinned Bun, isolated daemon and Chromium setup.
Build the web app from the checkout under test.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/voice-submit-matrix.ts chunk-pipeline
```

The helper pairs the real Neo web composer with live streaming on, then records
four seconds of dictation. In the page, every WebSocket message from the daemon
arrives 800 ms late, which stands in for a slow phone link. It feeds the
composer a synthetic tone through `getUserMedia`, because a headless Chromium
without macOS microphone access never resolves the fake capture device.

Check `chunk-pipeline.json`: `maxInFlight` must be at least 2, every sent chunk
carries numeric `capturedAt` and `sentAt` with `sentAt >= capturedAt`, the ASR
route is `streaming`, and the final transcript lands in the draft. The wrapper
must exit 0. The client that waits for each reply before the next chunk fails
with `maxInFlight` 1. The daemon records the two client times as
`clientCapturedAt` and `clientSentAt` on `voice.stream.chunk.decode`, next to
its own arrival time, so gaps in client send times point to a main-thread stall
and gaps only at the daemon point to the network.
