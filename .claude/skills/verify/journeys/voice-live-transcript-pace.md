# Live transcript types out at a steady pace

Build `packages/web` for the checked-out head, then run:

```sh
VERIFY_PLAYWRIGHT=<playwright-package-path> VERIFY_SYNTHETIC_MIC=1 VERIFY_KEEP_RUN=1 \
  bash .claude/skills/verify/with-run.sh bash .claude/skills/verify/live-transcript-pace.sh 19356 after
```

The launcher starts an isolated daemon and `asr-stub.ts` in `--bursts` mode,
which grows its interim transcript by six words every 900 ms, like a real
recognizer arriving in chunks. The helper pairs a headless browser, focuses the
Neo composer, starts the mic and samples the live text length on every animation
frame for six seconds. It writes `<label>.json` (samples and summary),
`<label>-strip.png` (eight composer shots about 250 ms apart) and `<label>.webm`.

Pass when the summary shows many small steps instead of a few word-group jumps:
with the typewriter, `largestJump` stays in single digits and `changes` is
dozens. Before it, `changes` is about six and `largestJump` about 35. For a
baseline, build the web from the base commit and rerun with label `before`.

`VERIFY_SYNTHETIC_MIC=1` replaces `getUserMedia` with a tone and drops
`AudioEncoder` so the stream uses PCM16. Use it on hosts where headless Chromium's
fake device never resolves. The helper refocuses the composer after starting
the mic because the empty, unfocused composer collapses and hides the draft.

For a human try, set `VERIFY_PACE_HOLD=1`: the launcher keeps the daemon and
stub up and prints the `/neo` URL. Pair the browser with a code from
`bun .claude/skills/verify/rpc.ts device.pair.create '{"kind":"human"}'`.
Stop it with `stop.sh` on the run dir.
