# Neo composer matches the phone composer

Use pinned Bun and shared resource preflight from SKILL.md, build the web at the
checked-out head, then run:

```bash
VERIFY_BROWSER=<installed-chromium> VERIFY_PLAYWRIGHT=<playwright-package-path> \
VERIFY_MOCK_PORT=19377 VERIFY_KEEP_RUN=1 \
  bash .claude/skills/verify/with-run.sh bash .claude/skills/verify/neo-composer-phone-match.sh 19366 after
```

The wrapper launches an isolated daemon, mock and streaming ASR stub, pairs a
synthetic browser and swaps in a tone microphone (headless fake devices never
resolve `getUserMedia`). At the phone's 402px width and 3x scale it captures
`idle`, `typing` and `recording` (live words visible) in light and dark into
`$RUN/evidence/<label>/`, with `receipts.json` holding size, radius, shadow,
fill and border of the form. The recording keeps focus in the composer so it
stays expanded, as the phone's open box does. The `PCM16` badge appears only
because the tone microphone drops `AudioEncoder`.

Compare each PNG with the same state captured from the iOS app's composer in
the Simulator. Expected: a 326px wide, 50px idle capsule
with a line-colored rim; the `--neo-composer-glass` fill; send in accent at
half opacity while disabled; the 24px tall 3px bars with muted timer; 16px gaps
between the waveform, Stop and Send; live words upright in the faint color.
The phone's voice-conversation button has no web counterpart.
