# Deepgram recorded voice and Deepgram speech

Use the isolated launch and doctor workflow in the verify skill. With the daemon
running, run:

```bash
NODE_ENV=test RUN="$RUN" VERIFY_PORT=19311 \
  bun .claude/skills/verify/voice-deepgram.ts > "$RUN/evidence/voice-deepgram.json"
```

The helper rewrites voice settings, so it applies the same run checks as
`voice-speech-part.ts` before reading a credential or opening a socket. It owns
an ephemeral loopback Deepgram-shaped server and closes it in finally. It saves
Deepgram recorded and speech parts through the public settings RPC, sends one
recording through `voice.transcribe`, and reads the voice list through the
`neo.speech.catalog` operation door.

End state: the transcript is the server's (`deepgram heard`); the server saw
the raw WAV body at `/v1/listen?model=nova-3` with `Content-Type: audio/wav`,
then `GET /v1/models`; the voice list holds `aura-2-thalia-en`. Synthesis
(raw PCM, no WAV header to clients) is covered by the focused speech suite.
Stop the owned daemon and remove its temporary data.
