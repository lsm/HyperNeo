# Live transcript flows out smoothly

The grey "heard so far" text in the composer flows out evenly whatever bursts
the recognizer sends. Every display frame a cursor moves through it at a speed
that eases toward "backlog ÷ 0.45 s", so it trails the newest words by about
half a second and never jumps when a burst lands. Each character fades from
clear to solid over 0.3 s behind the cursor. The whole text is laid out from the
start (unrevealed characters are clear), so a growing word never jumps lines. A
revision keeps the unchanged start; the end of the utterance shows everything at
once. With reduced motion the words appear as they arrive.

Build `packages/web` for the checked-out head, then run:

```sh
VERIFY_BROWSER=<installed-chromium> VERIFY_PLAYWRIGHT=<playwright-package-path> \
  VERIFY_SYNTHETIC_MIC=1 VERIFY_KEEP_RUN=1 \
  bash .claude/skills/verify/with-run.sh bash .claude/skills/verify/live-transcript-pace.sh 19356 after
```

Set `VERIFY_MOCK_PORT` when port 8000 is taken by another run.

The launcher starts an isolated daemon and `asr-stub.ts` in `--bursts` mode,
which grows its interim transcript in uneven bursts of 3, 1, 4 and 2 words,
900, 300, 1200 and 600 ms apart. The helper pairs a headless browser, focuses
the Neo composer, starts the mic and, on every animation frame for six seconds,
records how many characters are revealed (laid out minus the clear rest). Only
after that does it take eight composer shots about 250 ms apart. It writes
`<label>.json` (samples and summary), `<label>-strip.png` and `<label>.webm`.

Pass when the summary shows `peakCharsPer60fpsFrame` at or under about 1 (the
reveal rate over any 100 ms window, in characters per 60 fps frame) and
`longestStopMs` under 300 while text waits. `maxCharsPerFrame` counts raw
frames; headless Chromium on a busy host drops frames (`droppedFrames`, gaps
over 25 ms), and a 2 or 3 there lines up with a 40 to 70 ms frame. `fade` holds
the opacities of the characters still fading in, falling from 1 toward 0 at the
cursor. The strip should show the newest letters faint and the cursor sitting
after the full laid-out text, not right behind the revealed letters.

Rerun with `VERIFY_REDUCED_MOTION=1`: `fade` is empty and each burst lands in a
single frame.

`VERIFY_SYNTHETIC_MIC=1` replaces `getUserMedia` with a tone and drops
`AudioEncoder` so the stream uses PCM16. Use it on hosts where headless Chromium's
fake device never resolves. The helper refocuses the composer after starting
the mic because the empty, unfocused composer collapses and hides the draft.

For a human try, set `VERIFY_PACE_HOLD=1`: the launcher keeps the daemon and
stub up and prints the `/neo` URL. Pair the browser with a code from
`bun .claude/skills/verify/rpc.ts device.pair.create '{"kind":"human"}'`.
Stop it with `stop.sh` on the run dir.
