# OpenAI Realtime live voice

Use the isolated launch and doctor workflow in the verify skill. With the daemon
running, run:

```bash
NODE_ENV=test RUN="$RUN" VERIFY_PORT=19311 \
  bun .claude/skills/verify/voice-openai-realtime.ts > "$RUN/evidence/voice-openai-realtime.json"
```

The helper rewrites voice settings, so it applies the same run checks as
`voice-speech-part.ts` before reading a credential or opening a socket. It owns
an ephemeral loopback Realtime-shaped WebSocket server that answers a commit
with `conversation.item.input_audio_transcription.completed` and keeps the
socket open, as the real service does. It sets that live address with protocol
`openai-realtime` and mode streaming, then records one stream through the
public stream RPC.

End state: the stop returns `realtime heard` `via: streaming` in well under the
5 s close timeout; the server saw one `session.update`, 4800 bytes of audio for
3200 bytes captured (16 to 24 kHz), and the daemon closed the socket. Error and
missing-completed cleanup is covered by the focused stream relay suite. Stop
the owned daemon and remove its temporary data.
