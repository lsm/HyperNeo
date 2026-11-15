# The web composer offers no realtime voice entry

Use shared resource/isolation setup in SKILL.md. Build `packages/web` for the
checked-out head, then run:

```sh
VERIFY_BROWSER=<installed-chromium> NODE_PATH=<dir-containing-playwright> \
  bash .claude/skills/verify/proof-run.sh /absolute/new/evidence \
  .claude/skills/verify/neo-live-voice-hidden.ts
```

The helper boots the production daemon with an empty temporary HOME and
database, no provider credentials and external HTTP refused. It serves the
built web bundle beside the daemon, pairs a headless Chromium context through
the real `/pair` endpoint and opens `/neo` once per color scheme.

Require, from neo-live-voice-hidden.json and the wrapper's exit status: the
composer renders with the dictation mic, no "Realtime voice" button and no
"Stop realtime voice" button, in both light and dark. Inspect
composer-light.png and composer-dark.png.

This proves the entry point is gone from the visible UI; the speech player
itself stays covered by `journeys/neo-speech-player.md`, and real-time voice
remains available to the iOS composer contract described in
`journeys/spoken-replies.md`.
