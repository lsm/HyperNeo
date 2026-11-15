# The composer shows the dictation mic and no live voice button

Use shared resource/isolation setup in SKILL.md. Build `packages/web` for the
checked-out head, then run:

```sh
VERIFY_BROWSER=<installed-chromium> NODE_PATH=<dir-containing-playwright> \
  bash .claude/skills/verify/proof-run.sh /absolute/new/evidence \
  .claude/skills/verify/neo-live-voice-hidden.ts
```

The helper boots the production daemon with an empty temporary HOME and
database, no provider credentials and external HTTP refused. It serves the built
web bundle beside the daemon, pairs a headless Chromium context through the real
`/pair` endpoint and opens `/neo` once per color scheme.

In each scheme the journey requires the composer's "Start voice input" button to
be visible, and requires zero "Realtime voice" or "Stop realtime voice" buttons
on the page. It then screenshots the composer form. The mic renders only when
the daemon's voice settings are enabled, so the helper enables them; a headless
browser without `navigator.mediaDevices` may still show it disabled, which the
evidence records without failing presence.

Inspect composer-light.png and composer-dark.png in the evidence directory and
neo-live-voice-hidden.json, and trust the wrapper's exit status. This proves the
composer renders its dictation mic without a live-voice entry in light and dark;
it does not prove dictation itself, speech playback or any daemon speech path.
