# The live voice button makes Neo speak in the web UI

Use shared resource/isolation setup in SKILL.md. Build `packages/web` for the
checked-out head, then run each mode:

```sh
VERIFY_BROWSER=<installed-chromium> NODE_PATH=<dir-containing-playwright> \
  bash .claude/skills/verify/proof-run.sh /absolute/new/evidence \
  .claude/skills/verify/neo-live-voice-button.ts configured
# again with `unconfigured` and a new evidence directory
```

The helper boots the production daemon with an empty temporary HOME and
database, no provider credentials and external HTTP refused. It serves the built
web bundle beside the daemon, pairs a headless Chromium context through the real
`/pair` endpoint and opens `/neo`. A loopback synthetic TTS server stands in for
`HYPERNEO_SPEECH_URL`; `unconfigured` leaves that variable unset.

`configured` clicks the composer's "Realtime voice" button, then requires it to
become "Stop realtime voice" with `aria-pressed="true"` and a filled accent
background once the pointer leaves and transitions settle. Neo then speaks
through the real MCP adapter, and the saved receipts must read queued, playing,
played: the page's own player played the audio. Pressing the button again must
turn it off, after which Neo's next say is refused with `voice_replies_off`.

`unconfigured` clicks the same button and requires the notice "Voice replies are
not set up on this daemon." with the button still off and no speech receipts.

Inspect listening.png and not-configured.png in the evidence directory and
neo-live-voice-button.json, and trust the wrapper's exit status. This proves the
web button, the daemon listener and Web Audio receipts; it does not prove a
physical speaker, a real TTS service or a real model's wording.
