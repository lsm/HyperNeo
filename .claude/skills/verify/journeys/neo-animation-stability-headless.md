## Neo animation stability (headless)

Build web. Before Launch, seed doing todos in a fresh synthetic run directory:

```bash
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/neo-todo-collapse-seed.ts "$RUN"
sqlite3 "$RUN/data/daemon.db" "UPDATE neo_todos SET state = 'doing', blocked_reason = NULL;"
```

Launch on a free non-8399 port with that run directory.
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
The main conversation must have neither a working status row (including its empty
slot) nor a composer task strip, even with doing todos. Capture
`evidence/neo-mid-turn-{1280,390}.png` while the synthetic processing event is active.
Inspect these screenshots for absence of both rows; JSON bounding boxes check that
the conversation does not jump during busy toggles. The worker chat pane keeps its
own working indicator.
Voice sampling median must be below 25 ms, with over 60 samples in 1.8 seconds;
frame counts and p95 timing are recorded, not a hardware-independent FPS guarantee.
Evidence: `evidence/neo-animation-verify.json`, `neo-mid-turn-{1280,390}.png`, and
`neo-animation-{1280,390}.png`. Before the earlier animation fix, the historical
`reproduce` mode recorded 45 px message movement, four resizes, and about
50 ms audio sampling gaps on a 60 Hz browser. The focused VoiceWaveform suite also
drives synthetic 30/60/120 Hz timestamps to check refresh-independent sampling.
This proves web behavior under synthetic input; it does not verify iOS or 5G service.
If browser launch is blocked, retain the launch error and run the real-composer
mid-turn regression in `NeoComposerDraftRecovery.test.tsx`. Component evidence
does not prove pixel layout or satisfy the screenshot check.
