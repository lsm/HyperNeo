# The web speech player plays Neo's spoken replies

Use shared resource/isolation setup in SKILL.md and run:

```sh
VERIFY_BROWSER=<installed-chromium> NODE_PATH=<dir-containing-playwright> \
  bash .claude/skills/verify/proof-run.sh /absolute/new/evidence \
  .claude/skills/verify/neo-speech-player.ts
```

This boots the production daemon with an empty temporary HOME and database, no
provider credentials and external HTTP refused. A loopback synthetic TTS server
streams a 440 Hz sine in odd-sized pieces, so samples split across chunks. A real
WebSocket client enables `neo.speech.listen` with audio; Neo speaks through the
real MCP adapter. Each `neo.speech` event is forwarded into headless Chromium,
where `openNeoSpeechPlayer` from `packages/web/src/lib/voice/neo-speech-player.ts`
plays it through a real `AudioContext` tapped by a level meter. Its
`neo.speech.ack` calls go back through the same WebSocket.

Require, from neo-speech-player.json and the wrapper's exit status: the short
reply's saved receipts include `playing` then `played`; `played` arrives no
sooner than the 0.6 s of audio; at least half a second of voiced samples reached
the output. The long reply is interrupted after `playing`: a `cancelled` receipt
is saved and no further voiced audio follows.

The player is not yet wired to a button, so this proves the daemon-to-Web-Audio
path and receipts, not a rendered control or a speaker.
