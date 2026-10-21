## Neo animation stability (headless)

Build web, then Launch on a free non-8399 port with a fresh synthetic run directory.
In that same shell (with a stop.sh EXIT trap), run:

```bash
NODE_PATH=<directory containing playwright> node .claude/skills/verify/neo-animation-check.mjs 9378 "$RUN" verify
```

If Playwright's matching browser is unavailable, set `VERIFY_BROWSER` to an installed
Chromium executable. This always launches headlessly, never the desktop browser.
The helper validates the isolated daemon log, opens Neo over RPC, seeds 18 synthetic
publications in that DB and enables voice with a loopback endpoint. At desktop and
mobile widths it drives the real built `/neo` page, injecting only synthetic
`neo.working` events on its browser WebSocket, and starts/cancels a fake microphone.
It replaces browser analyser output with synthetic local audio levels; no transcription
or model turn is needed. Rail/message bounding boxes must not move, and observing the
rail and its children must receive zero resize callbacks during four busy toggles.
Voice sampling median must be below 25 ms, with over 60 samples in 1.8 seconds;
frame counts and p95 timing are recorded, not a hardware-independent FPS guarantee.
Evidence: `evidence/neo-animation-verify.json` and `neo-animation-{1280,390}.png`.
Before fixing, `reproduce` records 45 px message movement, four resizes, and about
50 ms audio sampling gaps on a 60 Hz browser. The focused VoiceWaveform suite also
drives synthetic 30/60/120 Hz timestamps to check refresh-independent sampling.
This proves web behavior under synthetic input; it does not verify iOS or 5G service.
