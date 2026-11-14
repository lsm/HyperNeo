# Live voice runs a spoken conversation loop in the web UI

Use shared resource/isolation setup in SKILL.md. Build `packages/web` for the
checked-out head, then run each theme:

```sh
VERIFY_BROWSER=<installed-chromium> NODE_PATH=<dir-containing-playwright> \
  bash .claude/skills/verify/proof-run.sh /absolute/new/evidence \
  .claude/skills/verify/neo-live-voice-loop.ts light
# again with `dark` and a new evidence directory
```

The helper boots the production daemon with an empty temporary HOME and
database, no provider credentials and external HTTP refused. One loopback
fixture server stands in for both the speech endpoint (`HYPERNEO_SPEECH_URL`)
and the batch transcription endpoint. Chromium gets a generated tone as its fake
microphone, is paired through the real `/pair` endpoint and opens `/neo`.

The run clicks "Realtime voice" and then requires the following:

- The mic opens by itself.
- While Neo speaks, the button reads "Stop Neo speaking" and the mic is closed.
- The mic opens again after the `played` receipt.
- A recording sent with the composer's send control is stored with
  `[input: live_voice]`, and the mic opens again.
- Pressing "Stop Neo speaking" during a long reply records `cancelled`, and the
  mic opens again.
- Turning live voice off closes the mic it opened, and the mic stays closed.

Inspect `listening-<theme>.png`, `speaking-<theme>.png` and
`neo-live-voice-loop.json`, and trust the wrapper's exit status. This proves the
web loop, the daemon listener, Web Audio receipts and the stored input mode. It
does not prove a physical microphone or speaker, a real speech service or a
real model's wording.
